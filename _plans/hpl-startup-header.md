# hpl-startup-header — Claude Code 风格启动画面

> 对应 TODO-19（cli.ts 启动画面清理）+ TODO-20（hpl-startup-header 扩展）
> 预研依据：`_foresight.md`（Pi 启动画面自定义预研）

## Context

当前 hapilon 启动时用户会看到 4 段杂乱输出：hapilon 自己的 `hapilon_v0.1.0_alpha` banner、Pi 的 `pi v0.80.8` 版本头 + 快捷键提示、`[Extensions]` 加载资源列表、`Update Available` 更新通知。本计划将它们全部移除，替换为 Claude Code 风格的**全宽 Unicode 边框 + 双栏布局**自定义头部：

```
╭─── Hapilon v0.1.0-alpha ───────────────────────────────────────────────╮
│                                                                          │
│             Welcome back!                          │  Extensions (8)     │
│                                                    │  hpl-context        │
│               ▗▖                                   │  hpl-footer         │
│              ▐▛███▜▌                                │  hpl-panel-viewer   │
│             ▝▜█████▛▘                               │  ...                │
│               ▘▘ ▝▝                                │                      │
│                                                    │  Pi 0.80.10 avail.  │
│     zai · glm-5-turbo                               │  pi.dev/changelog   │
│   /Volumes/Under_M2/morphiiouo/hapilon              │                      │
│                                                    │  Press ctrl+o for   │
│                                                    │  startup help       │
╰──────────────────────────────────────────────────────────────────────────╯
```

**边框字符**: `╭╮╰╯│─`（与 FloatingPane 一致，复用 pi-tui theme border 色）
**双栏比例**: 左 55% / 右 45%（`width >= 80` 时）；窄终端降级为单栏全宽
**ASCII mascot**: Claude Code 原版 `▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝` + 顶部单像素角 `▗▖`。4 行 × ~13 字宽

技术组合（探索已逐一验证）：

| 目标 | 手段 | 验证位置 |
|------|------|----------|
| 移除 hapilon banner | 删除 `cli.ts:78` 的 console.log | `src/cli.ts:77-79` |
| 移除 Pi 版本头 + 快捷键 | Pi settings `quietStartup: true` | `interactive-mode.js:500`（quiet 时 builtInHeader 为空 Text，仍占位可被替换） |
| 移除 `[Extensions]` 列表 | 同上 `quietStartup: true` | `interactive-mode.js:1043`（quiet 时仍显示 error/warning 诊断，Fail Fast 不受影响） |
| 移除 Update Available | spawn env `PI_SKIP_VERSION_CHECK=1` | `version-check.js:21` |
| 自定义头部 | `ctx.ui.setHeader(factory)` | `types.d.ts:110`、`interactive-mode.js:1577`、官方示例 `examples/extensions/custom-header.ts` |
| ctrl+o 展开联动 | 自定义组件实现 `setExpanded(boolean)` | `interactive-mode.js:3064-3078`（`setToolsExpanded` 对 `customHeader ?? builtInHeader` 调用 `setExpanded`） |

## 核心原则

1. **数据与渲染分离**：header 内容构建为纯函数（`buildHeaderLines`），单元测试全覆盖；TUI 组件只是薄壳。
2. **cli.ts 与扩展之间只用环境变量通信**：`HAPILON_EXTENSIONS` / `HAPILON_VERSION` 两个 env var，不引入文件传递或 IPC。
3. **装饰性功能不阻塞、不报错刷屏**：Pi 版本检查异步进行、失败时省略该行（TUI 内 stderr 输出会污染渲染，这是 Fail Fast 原则的明确例外，理由见「关键风险」）。

## 架构

```
hapilon 进程 (cli.ts)                        pi 子进程
┌──────────────────────────────┐            ┌─────────────────────────────────┐
│ 1. 删除 banner console.log    │            │ hpl-startup-header 扩展          │
│ 2. ensureQuietStartup(agent)  │──写文件──> │  ~/.hapilon/agent/settings.json  │
│    { quietStartup: true }     │            │  (Pi 读取后跳过内置 header/列表)  │
│ 3. discoverExtensions()       │            │                                  │
│    └> extensionNames()        │            │ index.ts                         │
│ 4. spawn env:                 │───env───>  │  session_start:                  │
│    PI_SKIP_VERSION_CHECK=1    │            │   guard: hasUI && mode==="tui"   │
│    HAPILON_EXTENSIONS=[...]   │            │   ctx.ui.setHeader(factory)      │
│    HAPILON_VERSION=0.1.0-alpha│            │   异步 version check → 重渲染     │
└──────────────────────────────┘            │                                  │
                                             │ content.ts   buildHeaderLines()  │
                                             │ version-check.ts  自行 fetch     │
                                             └─────────────────────────────────┘
```

### 替代方案与取舍

| 方案 | 描述 | 结论 |
|------|------|------|
| A（选定）| `quietStartup` + `setHeader` 扩展 + env 传递 | 官方 API 组合，有 `custom-header.ts` 官方示例与 `hpl-footer` 内部先例 |
| B | 只用 `setHeader`，不设 `quietStartup` | 被否：`[Extensions]` 列表由私有方法 `showLoadedResources()` 渲染，扩展 API 无法移除 |
| C | cli.ts 在 spawn 前直接 console.log 打印自定义 banner | 被否：无 theme 配色、无 ctrl+o 联动、resize/clear 重绘后与 TUI 脱节 |
| 扩展列表文件传递（`loaded-extensions.json`）| env var 的替代 | 被否：多一次磁盘 I/O 与生命周期管理（陈旧文件问题），env var 天然与本次 spawn 绑定 |

## 文件变更清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/extensions/hpl-startup-header/index.ts` | 扩展入口：注册 `session_start` hook，TUI guard，调用 `ctx.ui.setHeader()`，触发异步版本检查并 `tui.requestRender()` |
| `src/extensions/hpl-startup-header/content.ts` | `HeaderData` 类型 + `parseExtensionsEnv()` + `hapilonLogo()` (ASCII art) + `drawBox(lines, width)` (Unicode 边框) + `layoutColumns(left, right, width, ratio)` (双栏排版) + `buildHeaderLines(data, expanded)` 纯函数 + `createStartupHeader()` 组件工厂 |
| `src/extensions/hpl-startup-header/version-check.ts` | `fetchLatestPiVersion(fetchFn?)`（3s 超时，尊重 `PI_OFFLINE`，**忽略** `PI_SKIP_VERSION_CHECK`）+ `isNewerPiVersion(latest, current)` |
| `src/test/unit/hpl-startup-header.test.ts` | content.ts 纯函数单元测试 |
| `src/test/unit/hpl-startup-header-version.test.ts` | version-check.ts 单元测试（注入 fake fetch） |

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `src/cli.ts` | 删除 `console.log("hapilon_v0.1.0_alpha")`（77-79 行）；spawn 前构造统一 `piEnv` 对象（新增 `PI_SKIP_VERSION_CHECK` / `HAPILON_EXTENSIONS` / `HAPILON_VERSION` 三个键），sandbox 路径（164 行）与默认路径（187 行）两处 spawn 共用；调用 `ensureQuietStartup(agentDir)` |
| `src/extensions.ts` | 新增纯函数 `extensionNames(paths: string[]): string[]`（`<dir>/index.js` → 目录名；`name.js` → 去后缀） |
| `src/providers.ts` | 新增 `ensureQuietStartup(agentDir: string): void`（放在 `ensureSettingsFile` 旁）：读取-合并-写回 settings.json，保留已有键；解析失败时 warn 且**不覆盖**原文件 |
| `src/help.ts` | `getVersion()` 加 `export`（cli.ts 复用，避免重复读 package.json 的逻辑） |
| `src/test/unit/extensions.test.ts` | 增补 `extensionNames` 用例 |
| `src/test/unit/providers.test.ts` | 增补 `ensureQuietStartup` 用例 |
| `src/test/integration/cli.test.ts` | 更新 3 处 `hapilon_v0.1.0_alpha` 断言（66/91/202 行，banner 删除后语义变化）；「未配置警告」用例增补断言 stdout 不含 banner |

### 需要确认（实现前请用户拍板）

1. **Extensions 计数含自身**：`discoverExtensions()` 会发现 `hpl-startup-header` 自己，列表将是 8 个而非需求样例的 7 个。计划按「如实显示 8 个」处理。
2. **`quietStartup` 每次启动强制写 `true`**：用户手动改回 `false` 会在下次启动被覆写。设计意图是 hapilon 拥有启动画面主权，`--verbose` 是查看 Pi 原生输出的逃生门（Pi 源码 `verbose || !quietStartup`）。如需尊重用户手改，需引入「仅首次写入」语义——默认不做。
3. **`ensureQuietStartup` 放 `providers.ts`**：TODO-19 原文写「通过 hapilon config-io 设置」，但 `config-io.ts` 职责是 `~/.hapilon/config.json`（hapilon 自己的配置），而 agent 目录文件（auth/settings/models）的读写辅助全部在 `providers.ts`（`ensureSettingsFile` 就在那里）。按职责归属放 `providers.ts`。
4. **ctrl+o 展开内容为硬编码快捷键列表**：Pi 的 `keyHint` 辅助函数是内部私有实现，无法读取用户实际 keybinding 配置。展开视图硬编码 Pi 默认键位精选（约 10 条）。用户重绑键位后提示会失真——记入 `_backlog`。

## 实现步骤

TDD 顺序：每步先写测试（RED）再实现（GREEN）。测试跑法：`npm run build && npm run test:unit`。

### Phase 1 — cli 侧基础函数

1. **`extensions.ts` 新增 `extensionNames()`**
   - 测试用例（`extensions.test.ts`）：`["/a/hpl-foo/index.js"]` → `["hpl-foo"]`；`["/a/bar.js"]` → `["bar"]`；混合输入；空数组 → 空数组
   - → verify: `npm run test:unit` 新用例通过，旧用例不回归

2. **`providers.ts` 新增 `ensureQuietStartup(agentDir)`**
   - 行为契约：
     - settings.json 不存在（含 agentDir 不存在）→ 创建（目录 `mode: 0o700`）并写 `{ "quietStartup": true }`
     - 已存在且含其他键 → 合并写回，其他键原样保留
     - 已为 `true` → 不写文件（幂等，避免无谓 mtime 变更）
     - JSON 解析失败 → `console.warn` 提示 + **不动原文件**（宁可本次启动显示 Pi 原生 header，不可破坏用户数据）
   - 测试用例（`providers.test.ts`，tmp 目录）：上述 4 条各一
   - → verify: 单测通过；坏 JSON 用例断言文件内容未变

3. **`help.ts` export `getVersion`**
   - → verify: `npm run typecheck` 通过，help 相关集成测试不回归

### Phase 2 — cli.ts 接线（TODO-19）

4. **修改 `cli.ts`**
   - 删除 77-79 行 banner（`isNonInteractive` 变量保留，安全提示与沙箱提示仍在用）
   - 在 `discoverExtensions()` 之后：`const names = extensionNames(loadedExtensions)`（注意用过滤后的 `loadedExtensions`，`--no-safety` 时列表自动少 2 个）
   - spawn 前构造一次：
     ```typescript
     const piEnv = {
       ...process.env,
       PI_CODING_AGENT_DIR: agentDir,
       PI_SKIP_VERSION_CHECK: "1",
       HAPILON_EXTENSIONS: JSON.stringify(names),
       HAPILON_VERSION: getVersion(),
     };
     ```
     sandbox spawn 与默认 spawn 两处均替换为 `env: piEnv`
   - 在 spawn 前（`existsSync(agentDir)` 警告之后）调用 `ensureQuietStartup(agentDir)`
   - 更新 `cli.test.ts` 三处 banner 断言
   - → verify: `npm run build && npm test` 全绿；`node dist/cli.js doctor` 输出正常

### Phase 3 — hpl-startup-header 扩展（TODO-20）

5. **`content.ts` — 纯函数与组件**
   - `hapilonLogo(): string[]`：Claude Code 原版 mascot + 顶部单像素角（accent 色）：
     ```
     ▗▖              ← 小角（1 像素，抽象龙角）
     ▐▛███▜▌          ← 宽额头 / 帽檐
     ▝▜█████▛▘         ← 脸 + 酒窝
     ▘▘ ▝▝            ← 双眼
     ```
     4 行 × ~13 字宽。只用 Unicode 块字符，与 Claude Code 原生 mascot 一致
   - `drawBox(lines: string[], width: number, title?: string): string[]`：
     - 顶部: `╭─── <title> ───...───╮`（border 色），标题居左
     - 内容: `│ <line> │`（每行左右各 1 个 border 字符）
     - 底部: `╰──...──╯`
     - 内容行超出 width - 2 时截断（不换行，header 区域有限）
   - `layoutColumns(left: string[], right: string[], width: number): string[]`：
     - `width >= 80`：双栏（左 55% / 右 45%），中间 `│` 分隔
     - `width < 80`：单栏堆叠（先左后右，中间加分隔线 `────────────`）
     - 右侧行比左侧多时，左侧补空行对齐；反之亦然
   - `parseExtensionsEnv(raw: string | undefined): string[] | undefined`：undefined → undefined；JSON 非法 → warn + undefined
   - `buildHeaderContent(data: HeaderData): { left: string[]; right: string[] }`：
     | 区域 | 内容 | 缺省行为 |
     |------|------|----------|
     | 左-上 | `hapilonLogo()` (accent) | 恒有 |
     | 左-中 | `Welcome back!` (text) | 恒有 |
     | 左-下 | `provider · modelName` (text) + cwd 全路径 (dim) | model 为 undefined → `no model selected` (dim) |
     | 右-上 | `Extensions (N)` (dim bold header) + 扩展名列表 (dim, 每行缩进 2) | env 缺失 → 省略；扩展名过长截断 |
     | 右-中 | `Pi x.y.z is available.` (text) + `Changelog: pi.dev/changelog` (dim) | 无更新 → 省略 |
     | 右-下 | `Press ctrl+o for startup help` (dim) | 恒有 |
   - `buildHeaderContentExpanded(data: HeaderData): { left: string[]; right: string[] }`：
     - 左=同 `buildHeaderContent`
     - 右=键盘快捷键列表（硬编码精选约 10 条，dim）+ 扩展名全列表
   - 组件工厂 `createStartupHeader(ctx, tui, theme, state)`：
     - `render(width)`：`ctx.model` 实时读取 → `buildHeaderContent/Expanded` → `layoutColumns` → `drawBox` → 每行 `theme.fg(style, text)` 上色
     - `invalidate()`：空
     - `setExpanded(expanded)`：更新标志，下次 render 用不同 content builder
   - 测试（`hpl-startup-header.test.ts`）：`hapilonLogo()` 输出结构、`drawBox` 边框完整、`layoutColumns` 宽/窄两种模式、`buildHeaderContent` 全部场景（有/无 model、有/无 extensions、有/无 update）、expanded 切换、`parseExtensionsEnv` 三分支

6. **`version-check.ts`**
   - `isNewerPiVersion(latest, current)`：复用 `providers.ts` 的 `semverGte`（跨目录 import `../../providers.js`，`trust-store` / `hapilon-home` 已有同款先例）
   - `fetchLatestPiVersion(currentVersion, fetchFn = globalThis.fetch)`：
     - `PI_OFFLINE` 存在 → 直接 undefined
     - **不检查 `PI_SKIP_VERSION_CHECK`**——该变量是 cli.ts 为关闭 Pi 内置检查而设置的，本扩展运行在同一进程内，若沿用 Pi 的 `getLatestPiRelease` 会恒返回 undefined。此处必须自行 fetch `https://pi.dev/api/latest-version`（代码内注释说明这个反直觉点）
     - `AbortSignal.timeout(3000)`；非 2xx / body 无 `version` 字段 / 网络异常 → undefined
   - 当前 Pi 版本：`import { VERSION } from "@earendil-works/pi-coding-agent"`（官方 custom-header.ts 同款）
   - 测试（`hpl-startup-header-version.test.ts`）：注入 fake fetch 覆盖成功/非 2xx/非法 body/reject；`isNewerPiVersion` 边界（相等、补丁号升、降级）；`PI_OFFLINE` 分支
   - → verify: 单测通过，无真实网络请求

7. **`index.ts` 组装**
   - `pi.on("session_start", ...)`：`if (!ctx.hasUI || ctx.mode !== "tui") return;`
   - `ctx.ui.setHeader((tui, theme) => createStartupHeader(ctx, tui, theme, state))`
   - `void fetchLatestPiVersion(VERSION).then(...)`：结果为更新时写入 `state.piUpdate` 并 `tui.requestRender()`（footer 的 `onBranchChange → requestRender` 同款模式）；fetch 完成前 header 正常显示（无第 6 行），不阻塞启动
   - → verify: `npm run typecheck && npm run build` 通过；`discoverExtensions()` 单测确认能发现 `hpl-startup-header/index.js`

8. **全量回归**
   - → verify: `npm run build && npm test` 全绿

### Phase 4 — 端到端人工验证 + 技术债记录

9. **人工验证清单**（见「验收标准」，逐条走查）
10. **`_backlog` 记录两条技术债**（用 write-backlog 结构）：
    - `pi-tui` 位于 devDependencies 却被多个扩展 runtime import（本扩展沿用先例，若未来以 npm 包分发会缺依赖）
    - ctrl+o 展开视图的快捷键列表为硬编码，用户重绑 keybinding 后提示失真

## 关键风险

| 风险 | 分析与缓解 |
|------|-----------|
| `setHeader` 在 builtInHeader 未初始化时静默 no-op（`interactive-mode.js:1578-1580`）| Pi 在 `session_start` 前已完成 UI start（`interactive-mode.js:495` 注释明确此顺序），且 hpl-footer 同时机调用 `setFooter` 已稳定运行。若 Pi 未来改时序会静默失效——端到端验收含肉眼检查项兜底 |
| `--verbose` 覆盖 `quietStartup`（Pi 源码 `verbose \|\| !quietStartup`）| 视为特性而非缺陷：`--verbose` 是查看 Pi 原生启动信息的 debug 逃生门，文档化即可 |
| `quietStartup` 会同时隐藏 Model scope 日志 | 探索确认 error/warning 诊断仍会显示（`interactive-mode.js:1265` `showDiagnosticsWhenQuiet: true`），扩展加载失败不会被吞——Fail Fast 底线保住 |
| 版本检查静默失败违反「Errors Never Pass Silently」| 明确例外并记录理由：扩展运行于 TUI 进程内，stderr 打印会撕裂终端渲染；且该行是装饰性信息，失败的正确表现就是「不显示」。网络失败不写日志文件（避免为装饰功能引入日志设施） |
| settings.json 与 Pi 进程的写入竞争 | cli.ts 在 spawn **之前**同步完成写入，Pi 启动后才读取，无并发窗口 |
| 非交互模式（`-p` / `--mode`）| 扩展有 `hasUI && mode === "tui"` guard；`quietStartup` 与 print 模式无交互；env var 注入无副作用。集成测试维持现有非交互用例回归 |
| `HAPILON_EXTENSIONS` 超长（未来扩展多时）| 当前 8 个名称约 150 字节，距 env 尺寸限制（约 256KB）有 3 个数量级余量，不做预防性设计 |

## 验收标准

单元/集成测试（`npm test` 全绿）之外，端到端人工验证：

构建：`npm run build`，然后在本仓库目录运行 `node dist/cli.js`。

- [ ] 启动后**不再出现**：`hapilon_v0.1.0_alpha`、`pi v0.80.8` 版本头与快捷键提示、`[Extensions]` 等加载资源列表、`Update Available` 通知
- [ ] 看到全宽 Unicode 边框 `╭─...─╮` 包裹的自定义 header，标题行含 `Hapilon v0.1.0-alpha`
- [ ] 左栏：Hapilon ASCII logo（accent 色）+ `Welcome back!` + provider · model + workspace 全路径
- [ ] 右栏：`Extensions (8):` 列表（dim 色，缩进对齐）；`node dist/cli.js --no-safety` 计数减为 6
- [ ] 头部整体视觉协调：边框对齐、列宽合理、颜色区分清晰（accent / text / dim）
- [ ] ctrl+o 切换：右栏变为快捷键列表（esc 中断、ctrl+c 清屏、shift+tab thinking、ctrl+p 选模型、`/` 命令、`!` bash、ctrl+g 外部编辑器等）；再按恢复原样
- [ ] 窄终端（< 80 列）：降级为单栏堆叠，不崩溃不越界
- [ ] 联网且 Pi 有新版时右栏显示 `Pi x.y.z is available.` 行；`PI_OFFLINE=1` 时该行消失
- [ ] `node dist/cli.js -p "say hi"` 与 `--mode json` 非交互模式正常输出、不崩溃
- [ ] `node dist/cli.js --verbose` 仍能看到 Pi 原生加载列表（逃生门）
- [ ] `~/.hapilon/agent/settings.json` 中 `quietStartup: true` 已写入，原有键未丢失
- [ ] 首次运行（`HAPILON_HOME=$(mktemp -d) node dist/cli.js`）不因 agent 目录缺失崩溃
