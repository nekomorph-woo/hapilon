# 封装裸 Pi Coding Agent 的必做 Roadmap

> 一句话概括：拿到裸 Pi 后，每个 wrapper 都必须补齐的安全、配置、体验三大基础设施路线图，按优先级排列。

## 核心概念

### 裸 Pi 给你什么？

Pi Coding Agent 是一个**最小化终端 Coding Agent 内核**。它提供了 Agent 循环、7 个内置工具（read/bash/edit/write/grep/find/ls）、TUI、Session 持久化、Extension 系统和 Skills 系统。

### 裸 Pi 没给你什么？

Pi 刻意不提供以下内容（设计哲学：自己按需加）：

| 缺失能力 | 风险等级 | 说明 |
|----------|----------|------|
| **Sandbox/沙箱** | 🔴 致命 | bash 工具以用户完整权限运行，无任何隔离 |
| **权限系统** | 🔴 致命 | 无命令审批、无文件保护、无操作确认 |wox
| **Provider 配置引导** | 🟠 高 | 无 setup wizard，用户需手动编辑 JSON |
| **多 Provider 管理** | 🟡 中 | 需手动编辑 models.json / auth.json |
| **CLI 帮助系统** | 🟡 中 | Pi 的 --help 较简略，无分层帮助 |
| **自定义命令路由** | 🟡 中 | 无 setup/doctor/config 等管理命令 |
| **日志/可观测性** | 🟡 中 | 有 pi-debug.log 但无结构化日志 |
| **会话管理 UI** | 🟢 低 | 内置 /tree 和 session selector，基本够用 |
| **Sub-agents** | 🟢 低 | 无内置，但可通过扩展实现 |
| **Plan Mode** | 🟢 低 | 无内置，但可通过扩展实现 |

---

## 必做路线图（按优先级）

```
🔴 P0 — 不做会有安全事故
🟠 P1 — 不做用户无法正常使用
🟡 P2 — 不做体验差但能跑
🟢 P3 — 锦上添花
```

### 🔴 P0: 安全基础设施

#### P0.1 命令审批/危险操作拦截

**为什么必做**：Pi 的 bash 工具直接以用户权限运行任意命令。`rm -rf /`、`sudo`、修改 `.env`、读取 `~/.ssh/` 等操作无任何拦截。

**实现方式**（按强度递增）：

| 方案 | 实现 | 强度 | hapilon 状态 |
|------|------|------|-------------|
| **A. 危险命令黑名单** | `pi.on("tool_call", ...)` 拦截 bash 工具，正则匹配 `rm -rf`、`sudo`、`chmod 777`、`curl ... \| sh` 等模式，弹确认框 | ⭐⭐ | ❌ 未实现 |
| **B. 文件路径保护** | 拦截 write/edit 工具，阻止修改 `.env`、`.git/`、`~/.ssh/`、`package-lock.json` 等受保护路径 | ⭐⭐⭐ | ❌ 未实现 |
| **C. OS 级沙箱** | 使用 `@anthropic-ai/sandbox-runtime`（macOS `sandbox-exec` / Linux `bubblewrap`）限制文件系统和网络访问 | ⭐⭐⭐⭐ | ❌ 未实现 |
| **D. 容器隔离** | Docker/podman 容器内运行 Pi，完全隔离 | ⭐⭐⭐⭐⭐ | ❌ 未实现 |

**参考**：
- Pi 官方 example: `permission-gate.ts`、`hpl-protected-paths.ts`、`sandbox/`
- 社区 package: [pi-permission-system](https://github.com/MasuRii/pi-permission-system)、[pi-permission-layers](https://pi.dev/packages/pi-permission-layers)、[pi-guard-sandbox](https://pi.dev/packages/pi-guard-sandbox)
- macOS 专用: [agent-safehouse.dev](https://agent-safehouse.dev/)

**hapilon 需要做的**：至少实现方案 A（危险命令黑名单）+ 方案 B（文件路径保护）作为内置扩展。方案 C（沙箱）作为可选功能后续迭代。

#### P0.2 项目信任机制

**为什么必做**：Pi 已内置 project trust（`trust.json`），但 wrapper 可能需要额外的信任层——例如在非交互模式下的默认行为。

**实现方式**：
- 利用 Pi 自带的 `-a`/`-na`/`--no-approve` 标志控制非交互模式的信任决策
- wrapper 层面可记录用户对项目的信任选择

**hapilon 状态**：⚠️ 部分实现 — `cli.ts` 已转发参数但未做额外处理

---

### 🟠 P1: 用户上手基础设施

#### P1.1 Provider 配置引导（Setup Wizard）

**为什么必做**：用户拿到 hapilon 后第一步就是配模型。裸 Pi 需要手动创建 `auth.json` 和 `models.json`，门槛高。

**实现方式**：
- 交互式 CLI：询问用户用什么 provider → 输入 API Key → 自动写入 `auth.json`
- 支持环境变量引用（`$OPENAI_API_KEY`）而非明文存储
- 支持 macOS Keychain / 1Password CLI 提取

**hapilon 状态**：✅ 已实现 — `hapilon setup` 命令 (`src/setup.ts`)

#### P1.2 配置目录隔离

**为什么必做**：hapilon 的配置不能和裸 Pi 的配置混在一起。用户可能同时使用 hapilon 和 Pi。

**实现方式**：
- 设置 `PI_CODING_AGENT_DIR=~/.hapilon/agent/`
- 所有 Pi 的配置（auth.json、settings.json、sessions、extensions）自动写入 hapilon 专用目录

**hapilon 状态**：✅ 已实现 — `cli.ts:103-109` 通过环境变量注入

#### P1.3 默认模型/Provider 注入

**为什么必做**：用户配好 provider 后，每次启动应该自动使用配置的模型，不需要手动 `/model` 切换。

**实现方式**：
- 读取 `~/.hapilon/config.json` 中的默认 provider/model
- 通过 CLI 参数注入：`--model`、`--provider`、`--thinking-level`
- 或者修改 Pi 的 `settings.json` 设置 `defaultProvider`/`defaultModel`

**hapilon 状态**：✅ 已实现 — `config-io.ts` 的 `injectDefaultArgs()`

#### P1.4 健康检查（Doctor）

**为什么必做**：用户配完环境后需要一个命令验证所有配置正确——provider 可连接、API key 有效、目录结构正确。

**实现方式**：
- 检查 `~/.hapilon/agent/` 目录存在性
- 检查 `auth.json` 是否有至少一个 provider
- 可选：发一个最小 API 请求验证 key 有效性

**hapilon 状态**：✅ 已实现 — `hapilon doctor` 命令

---

### 🟡 P2: 体验增强

#### P2.1 扩展自动发现与注入

**为什么必做**：hapilon 内置扩展（安全、便利工具等）应该随 hapilon 发布一起打包，用户不需要手动 `-e` 加载。

**实现方式**：
- `discoverExtensions()` 扫描 `dist/extensions/` 目录
- 自动通过 `-e` 注入到 Pi 启动参数

**hapilon 状态**：✅ 已实现 — `src/extensions.ts` + `cli.ts:98`

#### P2.2 CLI 帮助系统

**为什么必做**：用户需要知道 hapilon 支持哪些命令、参数、配置方式。

**实现方式**：
- `hapilon help` — 总览
- `hapilon help <command>` — 分命令帮助
- `hapilon --help` / `-h` — 兼容

**hapilon 状态**：✅ 已实现 — `src/help.ts` + `src/cli.ts:14-18`

#### P2.3 非交互模式适配

**为什么必做**：hapilon 在 print/json/rpc 模式下不应输出 banner、警告等污染 stdout。

**实现方式**：
- 检测 `-p`/`--print`/`--mode` 标志
- 非交互模式下静默 banner 和非关键警告

**hapilon 状态**：✅ 已实现 — `cli.ts:69-76`

#### P2.4 会话管理扩展

**为什么必做**：裸 Pi 的会话管理较基础。实用的增强包括：
- 自动命名 session（基于第一个 prompt 或 git branch）
- 会话书签（重要决策点打标签）
- dirty repo guard（有未提交改动时阻止切换 session）

**参考 Pi 官方 example**：`session-name.ts`、`bookmark.ts`、`dirty-repo-guard.ts`

**hapilon 状态**：❌ 未实现

#### P2.5 Token 用量追踪

**为什么必做**：用户需要知道花了多少钱、用了多少 token。裸 Pi 不提供内置统计。

**实现方式**：
- `pi.on("model_response", ...)` 累计 token 用量
- 在 footer/status bar 显示实时统计
- 存储历史用量数据

**hapilon 状态**：❌ 未实现

---

### 🟢 P3: 锦上添花

#### P3.1 自定义 Prompt 模板

内置一些常用 prompt 模板：code review、重构、写测试、解释代码等。

**hapilon 状态**：❌ 未实现

#### P3.2 Git 集成增强

自动 checkpoint（每个 turn stash）、退出时自动 commit 等。

**参考 Pi 官方 example**：`git-checkpoint.ts`、`auto-commit-on-exit.ts`

**hapilon 状态**：❌ 未实现

#### P3.3 多 Provider 故障切换

一个 provider 挂了自动切到备用 provider。

**hapilon 状态**：❌ 未实现

#### P3.4 上下文压缩定制

自定义 compaction 策略，例如总结整个对话而非简单截断。

**参考 Pi 官方 example**：`custom-compaction.ts`

**hapilon 状态**：❌ 未实现

---

## 与本项目 hapilon 的关系

### 已实现 vs 待实现

```
hapilon v0.1.0-alpha 完成度
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔴 P0 安全
  命令审批/危险拦截  ░░░░░░░░░░░░░░░░░░░░  0%
  文件路径保护       ░░░░░░░░░░░░░░░░░░░░  0%
  OS 沙箱（可选）    ░░░░░░░░░░░░░░░░░░░░  0%

🟠 P1 上手
  Setup Wizard      ████████████████████  100%
  配置目录隔离       ████████████████████  100%
  默认模型注入       ████████████████████  100%
  Doctor 健康检查    ████████████████████  100%

🟡 P2 体验
  扩展自动发现       ████████████████████  100%
  CLI 帮助系统       ████████████████████  100%
  非交互模式适配     ████████████████████  100%
  会话管理增强       ░░░░░░░░░░░░░░░░░░░░  0%
  Token 追踪         ░░░░░░░░░░░░░░░░░░░░  0%

🟢 P3 锦上添花
  全部               ░░░░░░░░░░░░░░░░░░░░  0%
```

### 当前最紧迫的差距

**安全是零**。hapilon 目前对 Pi 的危险操作没有任何拦截。这意味着：
- Agent 可以 `rm -rf` 你的项目
- Agent 可以读取你的 `~/.ssh/` 密钥
- Agent 可以 `curl` 你的文件到外部服务器
- Agent 可以修改 `.env`、`.git/config` 等敏感文件

这不是"未来要做"的事，这是**下次编码之前就应该做**的事。

---

## 入门路线图（推荐实施顺序）

### Phase 1: 安全地基（当前阶段，1~3 天）

1. **危险命令黑名单扩展** (`src/extensions/hpl-safety-gate.ts`)
   - 拦截 bash 工具中的 `rm -rf`、`sudo`、`chmod 777`、`curl ... | sh`、`git push --force` 等
   - 弹确认框（复用 `ctx.ui.confirm`）
   - 提供 `--yolo` / `--no-safety` 绕过选项

2. **文件路径保护扩展** (`src/extensions/hpl-protected-paths.ts`)
   - 拦截 write/edit 工具对 `.env`、`.git/`、`~/.ssh/`、`package-lock.json`、`*.pem` 等路径的写操作
   - 必要时扩展到读保护（`~/.ssh/`、`~/.aws/`）

3. **启动时安全提示**
   - 首次启动 hapilon 时显示安全声明
   - 说明哪些操作会被拦截、如何绕过

### Phase 2: 体验补全（1~2 周）

4. **Token 追踪扩展** — 实时显示 token 用量和费用
5. **Session 命名** — 自动给 session 起有意义的名字
6. **Dirty repo guard** — 有未提交改动时阻止切换 session

### Phase 3: 高级特性（按需）

7. **OS 级沙箱** — 集成 `@anthropic-ai/sandbox-runtime` 或容器方案
8. **多 Provider 故障切换**
9. **自定义 compaction 策略**

---

## 常见陷阱

### 安全类

- **不要在 hook 里 return false 来静默阻止**
  — 必须 `return { block: true, reason: "xxx" }` 给用户清晰的反馈
  — 静默阻止会让用户以为操作成功，比不阻止更危险

- **不要只拦截 bash 而忽略其他工具**
  — `write` 工具也能覆盖 `.env` 文件
  — `edit` 工具也能删除代码
  — 拦截要覆盖所有可变工具

- **安全扩展本身不能被绕过**
  — 不要把安全扩展做成"可被 Agent 卸载"的
  — 不要提供"永久信任"选项（容易被 prompt injection 利用）

### 体验类

- **不要过度确认**
  — 每次 bash 都弹确认框 = 用户点麻木 = 安全失效
  — 只拦截真正危险的操作

- **设置页不要做成"填表单"**
  — 交互式 question-answer 比 JSON 编辑友好 100 倍
  — 提供推荐默认值，让用户一路回车

---

## 参考资源

### Pi 官方文档
- [Pi Extensions 文档](https://pi.dev/docs/latest/extensions)
- [Pi 官方 extension 示例集](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/README.md) — 包含 permission-gate、hpl-protected-paths、sandbox 等 50+ 示例
- [Pi Sandbox 分析报告](https://agent-safehouse.dev/docs/agent-investigations/pi) — 详尽的安全审计
- [doc/pi-wiki.md](doc/pi-wiki.md) §15 安全模型

### 社区安全方案
- [pi-permission-system](https://github.com/MasuRii/pi-permission-system) — 集中式权限门控
- [pi-permission-layers](https://pi.dev/packages/pi-permission-layers) — 分层权限控制
- [pi-guard-sandbox](https://pi.dev/packages/pi-guard-sandbox) — OS 级沙箱
- [agent-safehouse.dev](https://agent-safehouse.dev/) — macOS sandbox-exec 工具

### 行业参考
- [Claude Code 安全文档](https://code.claude.com/docs/en/security)
- [Docker Sandbox for Coding Agents](https://www.docker.com/blog/docker-sandboxes-a-new-approach-for-coding-agent-safety/)
- [Enterprise AI Coding Agent Deployment](https://northflank.com/blog/enterprise-ai-coding-agent-deployment)

### 项目内参考
- [Hapilon PRD](Hapilon-PRD-v1.1.md) — 第 9 章 配置与 Provider
- [src/extensions.ts](src/extensions.ts) — 扩展自动发现机制
- [src/cli.ts](src/cli.ts) — CLI 入口，启动流程
- [.claude/skills/write-a-hapi/](.claude/skills/write-a-hapi/) — 写 hapi 扩展的 SKILL
