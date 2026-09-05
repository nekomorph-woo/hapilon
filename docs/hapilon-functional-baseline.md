# hapilon 现有功能基线（Effect 改造前快照）

> 本文档是 Effect AI-native 改造的**功能基线**：改造后的 hapilon 必须逐条保持此处列出的全部功能。
> 代码级可信源：`docs/src-baseline/`（改造前 src/ 的完整备份）。
> 基线 commit：`7c129ce`（feat/effect-intro 分支，effect 3.22.1 引入点）。
> 供 reviewer-claude（代码/功能审查）与 func-check（功能缺失检查）对照使用。

---

## 0. 项目定位

hapilon（命令 `hapilon` / 别名 `hapi`）是 Pi Coding Agent（`@earendil-works/pi-coding-agent` 0.84.4）的**薄启动器 + 扩展发行层**：

- 薄启动器：配置准备、安全门接线、扩展注入、spawn pi（stdio inherit，保留原版 TUI）
- 扩展发行层：11 个自有 `hpl-*` 扩展 + 8 个 npm 第三方扩展，经 `-e` 与 settings 双通道注入
- TypeScript + Node.js（>=22.19），ESM（`"type": "module"`），dist 入库、tarball 分发

分层铁律（PRD §5）：Wokii/hapilon 上层 → hapilon Core → Pi Runtime。hapilon 不 fork pi、不解析 pi 的 ANSI 输出、不重绘 TUI。

---

## 1. 启动器层（cli.ts → dist/cli.js，bin 双入口）

| 功能 | 行为 |
|------|------|
| `--help` / `-h` | 任意位置拦截，打印 hapilon help，不透传 pi |
| `--version` / `-v` | 输出 hapilon 自身版本（读 package.json），不透传 pi |
| 子命令路由 | `COMMANDS` 注册表驱动（setup / doctor / config / mcp / help） |
| 未知命令 | **不拦截**，原样透传给 pi（issue #14） |
| 自有 flag 剥离 | `--no-safety` / `--sandbox` / `--no-econ`（含 `=` 形式）spawn 前剥离，pi 不认识（#38） |
| 默认参数注入 | config.json 有 defaultProvider/defaultModel 时 unshift `--provider` / `--model`（用户显式传参时不覆盖） |
| 内核识别关闭 | 恒追加 `--no-context-files --no-skills`（上下文体系由 hpl-context / hpl-system-prompt 接管） |
| 未配置警告 | `~/.hapilon/` 不存在时 warn 提示 setup（仍继续启动） |
| 静默启动 | `ensureQuietStartup`：settings.json 合并写入 `quietStartup: true`（幂等） |
| 安全提示 | 首次启动打印安全扩展激活信息，`safetyNoticeShown` 置位后不再打印 |
| 安全门 settings 通道 | 默认 `ensureSafetyExtensions`（写入）；`--no-safety` 时 `removeSafetyExtensions` |
| 扩展默认配置预置 | `ensureExtensionConfigs`（map #31，文件不存在才写） |
| `-e` 扩展注入 | 内置 hpl-*（排除安全门两个）+ npm 扩展，逐个 `-e <path>`（仅父会话） |
| `--no-econ` | 单会话关闭 bash 输出压缩（调用 hpl-econ 的 setSessionDisabled） |
| `--sandbox` | OS 沙箱路径（见 §7）；Windows 上 warn 降级 |
| spawn | `spawn(process.execPath, [piCli, ...extensionFlags, ...piArgs], { stdio: "inherit", env: piEnv })` |
| piEnv | `PI_CODING_AGENT_DIR`、`PI_SKIP_VERSION_CHECK=1`、`HAPILON_EXTENSIONS`（JSON 名单）、`HAPILON_VERSION` |
| 退出码透传 | child exit code → process.exitCode；spawn error 打印并置 exitCode=1 |
| 沙箱路径 | cmdStr 经 shellEscape 拼接 → `SandboxManager.wrapWithSandbox` → spawn(shell:true)，直接 return |

沙箱初始化（`@anthropic-ai/sandbox-runtime`）：denyRead `~/.ssh ~/.aws ~/.netrc`；allowWrite `.` `/tmp` agentDir；denyWrite `.env .git/config`；网络全放行（allowedDomains `["*"]`）。

## 2. 命令与帮助

- **commands.ts**：命令注册表（`CommandDef` 树：name/description/usage/subcommands/handler）。handler 全部 lazy import（启动开销恒定）。全局选项 `--help/-h`、`--no-safety`、`--sandbox`。
- **help.ts**：`getVersion()`（读 package.json，失败 warn 返回 "unknown"）；`printHelp()` 主帮助（含 hapi 别名说明）；`printHelpFor(name)` 命令详情（未知命令打到 stderr 提示「未知命令」）。
- **测试锚点**：`hapilon --help` 与 `-h`、`help`、`help config`、`help setup`、`help nonexistent`（未知命令提示）、`--model gpt --help`（任意位置拦截）、`--version` 等于 package.json version、未知命令 `foobar` 不被拦截。

## 3. 配置层

### 3.1 hapilon-home.ts（目录单一来源）

- `HAPILON_HOME` env 优先（`~` 展开；相对路径**抛错**），默认 `~/.hapilon`
- `agentDir()` = `<home>/agent`（pi 配置目录单一来源）
- `ensureHapilonDirs()`：base/agent/sessions/logs/cache 五目录 0700 创建
- `configFilePath()` = `<home>/config.json`

### 3.2 config-io.ts（全局配置 I/O + flag 工具）

- `HapilonConfig`：defaultProvider / defaultModel（string）/ safetyNoticeShown（boolean）
- `readHapilonConfig()`：逐字段类型校验，类型不对 warn 并丢弃该字段；解析失败 warn 返回 `{}`（不抛）
- `writeHapilonConfig()`：父目录 0700 创建后写
- `HAPILON_FLAGS = ["--no-safety", "--sandbox", "--no-econ"]`；`hasFlag`（含 `=`）；`stripHapilonFlags`；`injectDefaultArgs`（provider/model 注入，用户显式 `--provider`/`--model` 时不覆盖）

### 3.3 project-config.ts（项目级三级合并）

- 合并链：`.hapilon/config.local.json`（个人）> `.hapilon/config.json`（团队）> `~/.hapilon/config.json`（全局）
- `ProjectConfig` 额外支持 `allow: Record<string, string[]>`（信任白名单）
- 浅合并（字段 flat）；`readProjectLocalConfig` / `writeProjectLocalConfig`（读-改-写保留其他字段）

### 3.4 config/handlers.ts（config 子命令）

| 子命令 | 行为 |
|--------|------|
| `config show` | 展示默认 provider/model（未设置时提示） |
| `config default --set` | 交互式：列已配 auth provider → 选 → spawn `pi --list-models` 拉模型 → 选 → 写 config.json。非 TTY 直接报错退出 |
| `config default --unset` | 清除默认配置（未设置时提示「无需清除」） |
| `config provider list` | 列已配 provider，key 脱敏（`maskKey`），非内置 id 标 `(custom)` |
| `config provider add <id>` | 无效 id 列全部 provider 选择；已配置时 y/N 覆盖确认；空 key 取消。写 auth.json（0600） |
| `config provider remove <id>` | 无 id 列已配 provider 选择；y/N 确认后删除 |
| 未知子命令 | stderr 提示 + exit 1 |

- **config/prompts.ts**：`question` / `yesno` readline helpers
- **providers.ts 中的 provider 定义**：`COMMON` 9 个 + `ALL_PROVIDERS` 30 个（deepseek/openai/anthropic/xai/google/groq/mistral/openrouter/zai + ant-ling/azure/nvidia/cerebras/cloudflare×2/vercel/zai-coding-cn/opencode×2/huggingface/fireworks/together/kimi-coding/minimax×2/xiaomi×4）

## 4. Provider / pi 接线层

- **providers.ts**：auth.json 读写（Pi 原生 `{type, key}` 格式，0600）；`mergeAuthEntries`（增量合并，OAuth token 保留）；`ensureSettingsFile`（不存在才写 `{}`）；`ensureQuietStartup`（幂等合并，解析失败 warn 不动原文件）；`parseSemver`/`semverGte`；`writeSkeletonFiles`（auth.json `{}`、settings.json `{}`、models.json 带 _guide 模板）；`readAuthFile`（逐条目 `{type,key}` 校验，坏条目 warn 删除）；`maskKey`（sk-a1b2…g7h8 风格）；`findProviderDef`
- **pi-cli-path.ts**：`resolvePiCli()`——从 `import.meta.resolve("@earendil-works/pi-coding-agent")` 向上找含 package.json 的包根，校验 `pkg.name` + `pkg.bin.pi`，返回 dist/cli.js 绝对路径。找不到抛错。**不用 PATH 中的 pi**（版本不受控）
- **pi-listing.ts**：`parseModelsTable`（解析 `pi --list-models` 两空格分隔表格，可按 provider 过滤）；`listModelsForProvider`（spawn pi，stdout/stderr 全收集，非零退出 reject 带 stderr）

## 5. 安全体系（三道防线）

### 5.1 safety-settings.ts（settings 通道，#37）

- 安全门扩展（hpl-safety-gate + hpl-protected-paths）写入 `<agentDir>/settings.json` 的 `extensions` 数组——settings 是 pi 持久扩展配置，**父会话与 subagent 会话都加载**（对比：`-e` 通道仅父会话）
- `isSafetyExtensionPath` 单一判定来源（cli.ts -e 过滤 + settings 条目识别共用，防两份清单分叉）
- `ensureSafetyExtensions`：dist 产物缺失**抛错**（构建损坏应爆出）；settings 解析失败 warn 不动原文件；幂等（无变化不写）
- `removeSafetyExtensions`：`--no-safety` 时移除（用户显式关闭，作用于所有会话）；解析失败时保守不动（宁可继续带门）

### 5.2 hpl-safety-gate（bash 危险命令拦截）

- `tool_call` hook 拦截 bash：BLOCK（高危直接阻止）/ CONFIRM（中危 4 选项弹框）/ ALLOW
- 规则库 rules.ts（280 行）+ sensitive-args.ts（109 行）
- trust-store 双维度信任（见 5.4）确认后放行

### 5.3 hpl-protected-paths（文件路径保护）

- `tool_call` hook 拦截 write/edit/read：write/edit 走 trust-check → block（高危硬阻止）→ confirm（中危弹框）；read 走 trust-check → confirm（敏感路径弹框）
- `/allow <path>` 会话级临时白名单
- 规则库 rules.ts（99 行）

### 5.4 trust-store.ts（信任存储）

- session 级：内存 `Map<toolName, Set<target>>`，`addSessionTrust`/`isSessionTrusted`/`clearSessionTrust`/`listSessionTrust`
- project 级：持久化到 `.hapilon/config.local.json` 的 `allow` 字段；`initProjectTrust` 内存缓存（扩展加载时一次）；`addProjectTrust`（写盘+同步缓存）/`isProjectTrusted`（缓存优先，未 init 的 cwd 懒加载实时读盘）/`listProjectTrust`
- 统一 API：`addTrust(scope)`、`isTrusted`（session → project 顺序查询）

### 5.5 sandbox.ts + `--sandbox`

- Linux 预检 `bwrapInstalled()`（which bwrap）；缺失打印发行版安装提示（Debian/Fedora/Arch）并 exit 1
- macOS 走 SandboxManager；Windows warn 降级为命令+文件策略
- `spawnFn` 可注入（测试用）

## 6. 扩展基础设施

### 6.1 extensions.ts（发现）

- `discoverExtensions(dir?)`：默认 `dist/extensions/`；`*.js` 单文件 + `<name>/index.js` 目录两种；跳过隐藏文件；字母序
- `extensionNames(paths)`：`<dir>/index.js` → 目录名；`<name>.js` → 去后缀

### 6.2 npm-extensions.ts（第三方扩展接线，#37）

- 8 个 npm 扩展固定清单：`@tintinweb/pi-tasks`、`@tintinweb/pi-subagents`、`@ff-labs/pi-fff`、`@zhushanwen/pi-ask-user`、`@narumitw/pi-btw`、`pi-web-access`、`pi-mcp-adapter`、`@dietrichgebert/ponytail`
- **ponytail 必须末位**（before_agent_start 尾部追加语义，先于 hpl-system-prompt 执行会被抹掉；npm-extensions.test.ts 末位断言 + ponytail-load-order 集成测试钉死）
- 入口解析：主路径 `resolve(<pkg>/package.json)`；exports 锁死时（ERR_PACKAGE_PATH_NOT_EXPORTED）降级——resolve 主入口向上找包根再拼
- **fail fast**：包缺失直接抛错（Errors Never Pass Silently）
- 不走 `pi install`（那会写 settings.packages 导致 subagent 重新激活）

### 6.3 ensure-extension-configs.ts（默认配置预置，map #31）

ensure 语义：**不存在才写，已存在（含用户改过）永不覆盖**：

| 文件 | 预置 |
|------|------|
| tasks-config.json | `{autoCascade: true}`（hapilon 捆绑了 pi-subagents，级联体验成立） |
| web-search.json | `{workflow: "none"}`（#42：不弹浏览器 curator） |
| mcp.json | `{mcpServers: {}}`（#49 空骨架落点） |
| econ-config.json | `{enabled: true, threshold: 8192, headLines: 40, tailLines: 20}`（#52 组合甲） |

## 7. MCP 子系统（mcp/）

- **config-store.ts**：mcp.json 存取。`ServerDef`（stdio: command/args/env；http: url/headers）；schema 校验失败抛 `McpConfigError`（Fail Fast）；server 名禁空白与路径分隔符；`addMcpServer`（同名抛错——覆盖手写定义是破坏性动作）；`removeMcpServer`（不存在返回 false）
- **handlers.ts**：`hapi mcp add <name> stdio -- <command> [args] [--env K=V]...` / `add <name> http <url> [--header "K: V"]...` / `list` / `remove <name> [-y]`；`extractKv` 支持 `K=V` 与 `K: V` 两种；修改需重启会话生效

## 8. setup / doctor（setup.ts）

- **setupQuick**：`ensureHapilonDirs` + `writeSkeletonFiles` + 打印 OAuth 引导（xai/codex/anthropic-sub/github-copilot 的 `/login` 命令）
- **setupInteractive**：逐个问 COMMON provider key（已配置显示脱敏值提示覆盖）→ 可选追加其余 provider（ID 输入，未知 ID 报错重问）→ `mergeAuthEntries` 增量合并写盘 → 配置摘要。readline async iterator，finally 关闭
- **doctor**：版本 / Node 版本（>=22.19 ✅/❌）/ 目录存在性 / auth.json 逐条目健康（key 脱敏或 oauth 类型标注，空文件 ⚠，解析失败 ❌）/ models.json / `PI_CODING_AGENT_DIR` / pi binary 可解析性（issue #14）

## 9. 共享层（shared/）

- **files.ts**（hpl-context 与 hpl-system-prompt 共用）：
  - `collectUpward(startDir, home, relative)`：自 startDir 逐级向上收集 `<dir>/.hapilon/<relative>`；home 之外的 startDir 显式补查全局；返回按「全局→祖先→深层」排序（深层覆盖浅层）
  - `readHapilonMd`（Fail Fast 直接抛）；`readRules`（*.md + alwaysApply frontmatter 解析，引号剥离，false 跳过，解析失败按无 frontmatter 收录全文；单文件失败 warn 跳过）
  - `discoverSkillPaths`（扫 `<dir>/<name>/SKILL.md`，交给 pi 原生 loadSkillsFromPaths）
  - `listFiles`（单层、字母序、跳过隐藏）
- **format.ts**：`xmlEscape`（& < > " 转义）
- **floating-pane/**：通用浮层组件。`FloatingPane`（pane.ts 151 行 TUI 组件）；`showFloatingPane`（ctx.ui.custom 封装，TUI 弹浮层；非 TUI 降级 notify/console.log）；鼠标事件解析（mouse.ts：SGR mouse regex、OVERLAY_MOUSE_ON/MOUSE_OFF）

## 10. hpl-* 扩展（11 个）

| 扩展 | 功能 | 注入通道 |
|------|------|----------|
| hpl-safety-gate | bash 危险命令 BLOCK/CONFIRM/ALLOW 三级拦截（§5.2） | **settings** |
| hpl-protected-paths | write/edit/read 敏感路径保护 + /allow（§5.3） | **settings** |
| hpl-context | hapilon 自有上下文体系：Skills 渐进披露（resources_discover）；HAPILON.md+Rules 收集（注入已移交 hpl-system-prompt） | -e |
| hpl-system-prompt | before_agent_start **全量替换** system prompt 为 hapilon XML 结构化体系；用户 SYSTEM.md / --system-prompt 显式指定时让位（返回空）；异常降级回 Pi 原始 prompt | -e |
| hpl-startup-header | ctx.ui.setHeader 自定义启动头：mascot logo / Welcome back / provider·model / workspace / 扩展列表 / 更新提示 | -e |
| hpl-footer | ctx.ui.setFooter 三行状态栏：cwd\|branch / tokens↑↓ hit% ctx%[HOT] 模型·thinking / 扩展状态。HOT 为上下文占用指示灯（ding.ts 渐变+分级） | -e |
| hpl-econ | bash 输出压缩（#52）：超阈值头N+尾M 截断、全文落盘供 grep、ctx_more 按行取回；省略提示含行动指引；--no-econ 会话级关闭；econ-config.json 可配 | -e |
| hpl-context-viewer | /context 命令：收集上下文快照（collector.ts）→ 渲染终端文本（renderer.ts）→ FloatingPane 展示 | -e |
| hpl-panel-viewer | /pop [pattern] 折叠面板浮动查看器 + /pop-config 规则配置 + hapi-pop-show / hapi-pop-config 工具 + Shift+Alt+↓ / Ctrl+Q 快捷键 + 滚轮 | -e |
| hpl-add-dir | 外部目录管理（vendor 自 pi-add-dir v1.3.1 改造，#29）：/add-dir /suggest-dirs /remove-dir /dirs 命令、add_directory / search_external_files 工具、TUI widget、session 持久化（/resume 兼容上游 customType）；只注入 HAPILON.md 不读 AGENTS/CLAUDE，外部 skills 不注入 | -e |
| hpl-simplify | /simplify 事后清理（#56）：check（只读审查出编号报告）→ 用户裁决 → apply 2,4（仅批准项修改+跑测试）。人工闸门：两条独立命令，无一条命令自动跑完的路径；规则内置 audit.ts | -e |

hpl-add-dir 是最大的扩展（suggestions.ts 923 行，共 ~1700 行），含子模块：commands / tools / context / suggestions / widget。

## 11. npm 第三方扩展（8 个，经 npm-extensions 注入）

| 包 | 作用 |
|----|------|
| @tintinweb/pi-tasks | 任务管理（autoCascade 预置开） |
| @tintinweb/pi-subagents | 子代理（进程内 createAgentSession 路线，PRD §9.7） |
| @ff-labs/pi-fff | #43 集成 |
| @zhushanwen/pi-ask-user | #43 集成 |
| @narumitw/pi-btw | #43 集成 |
| pi-web-access | web 搜索（workflow:none 预置） |
| pi-mcp-adapter | MCP 桥接（读 agentDir/mcp.json） |
| @dietrichgebert/ponytail | 极简编码规则（#55，末位注入） |

## 12. 测试体系

- 运行方式：`node --test dist/test/**/*.test.js`（对 dist 产物跑）；分层 `test:unit` / `test:integration`
- **38 个测试文件**：unit 34（commands / config-io / config-prompts / ensure-extension-configs / extensions / floating-pane / hapilon-home / hpl-* 各模块 / mcp-config-store / metadata / npm-extensions / pi-listing / project-config / providers / safety-settings / sandbox / sensitive-args / setup / trust-store）+ integration 3（cli 全链路 / ponytail-load-order / safety-settings-channel）+ fixtures 1
- cli 集成测试模式：spawn dist/cli.js + `HAPILON_HOME` 重定向 tmp 目录；bin 双 symlink 验证；`-e` 直调 handleConfig/handleMcp 模拟 TTY
- **改造门禁：全量测试必须保持绿色**（release.sh 第 2 步即 `npm run build && npm test`）

## 13. 构建与分发

- `npm run build`：`tsc -p tsconfig.json && chmod +x dist/cli.js`（shebang 保留）
- `typecheck` / `dev` / `test` / `test:unit` / `test:integration`
- bin：`hapilon` + `hapi` 同指 `./dist/cli.js`；`files: ["dist", "!dist/test"]`
- release.sh：版本升级 → build+测试门禁 → commit（含 dist）→ tag → push → npm pack → gh release 附 tarball
- sandbox-verify.sh：NPM_CONFIG_PREFIX/CACHE 重定向隔离安装 + 双 bin/--version/doctor 验证（fakehome，零触碰真实 ~/.hapilon）

## 14. 关键横切约束（改造时必须保持）

1. **幂等写盘**：ensure* 家族不存在才写/无变化不写；解析失败 warn 不动用户文件
2. **权限位**：auth.json 0600、目录 0700
3. **Fail Fast vs 降级**的分界：扩展缺失/npm 包缺失/settings 中安全门缺失 → 抛错；用户配置文件损坏 → warn + 空配置/不动文件
4. **单一来源**：agentDir()、configFilePath()、isSafetyExtensionPath、resolvePiCli——不允许出现第二份相同逻辑
5. **ponytail 末位**、安全门 settings 通道 + `-e` 排除防重复加载、`--no-context-files --no-skills` 恒追加
6. **lazy import**：命令 handler 全部动态 import，启动开销恒定
7. stdout 纯净性：`--mode`/`-p` 非 TUI 时不打 banner（isNonInteractive 判定只影响安全提示打印，quietStartup 始终写）
8. 未知命令/未知 flag 透传 pi（hapilon 是薄包装）

## 15. Effect 改造方向备忘（目标态，非基线）

- 全面 Effect 化：错误处理 → `Effect<A, E, R>` 类型化通道；配置/扩展发现/子进程管理 → Layer DI；gen 风格
- 分包：`src/cli/`、`src/config/`、`src/extensions/`、`src/sandbox/`、`src/providers/`、`src/mcp/`、`src/shared/`
- 外部行为（CLI 输出、退出码、文件格式、权限位、测试断言）保持不变——Effect 是内部编程模型的替换，不是行为变更
