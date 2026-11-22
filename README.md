<p align="center">
  <a href="docs/artifacts/hapilon-theme-pixel.webp">
    <img src="docs/artifacts/hapilon-theme-pixel.webp" width="288" alt="六位角色围坐在长满苔藓的铜管上，右侧的角色打开了一台终端">
  </a>
</p>

<h1 align="center">hapilon</h1>

<p align="center"><strong>基于 Pi 的终端 Coding Agent</strong></p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#工作流">工作流</a> ·
  <a href="#常用命令">常用命令</a> ·
  <a href="https://github.com/nekomorph-woo/hapilon/releases/latest">最新发布</a>
</p>

## 关于

hapilon 把 [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、内置扩展和技能打包成一个终端工具。启动后由 Pi 运行模型和会话，hapilon 负责加载项目约定、组织工具、管理上下文，并为模型调用和文件操作提供额外控制。你可以在一个终端里完成日常开发，也可以把工作交给子 Agent 或独立的角色面板。

- **模型与配额。** 在 Pi 支持的 provider 之间选模型，用档位配置常用模型和候补，在状态栏查看受支持的配额或余额。
- **项目规则与技能。** 让个人约定、仓库规则和子目录说明跟着代码走，使用随包分发或项目自带的 Skill。
- **会话与上下文。** 恢复历史会话，按需压缩长命令输出和长对话，查看工具结果与会话复盘。
- **任务与工具。** 使用任务列表、后台命令、文件搜索和 MCP。主会话还集成了网页访问、浏览器与桌面操作扩展。
- **协作与防护。** 派发子 Agent，或在 herdr 中编排角色面板。命令和敏感路径有独立的检查规则，也可启用 OS 沙箱。

## 快速开始

需要 **Node.js 22.19 或更新版本**。下面安装已发布的 `v0.21.89`，其他版本可在 [GitHub Releases](https://github.com/nekomorph-woo/hapilon/releases/latest) 找到。

```sh
hapilon_releases=https://github.com/nekomorph-woo/hapilon/releases/download
npm i -g "$hapilon_releases/v0.21.89/hapilon-0.21.89.tgz"
```

<details>
<summary>Windows PowerShell</summary>

```powershell
$hapilonReleases = 'https://github.com/nekomorph-woo/hapilon/releases/download'
npm.cmd i -g "$hapilonReleases/v0.21.89/hapilon-0.21.89.tgz"
```

</details>

装好后，在要工作的仓库里运行 `hapilon`。用 `/login` 连接 Pi 支持的 provider，用 `/model` 选模型，就可以输入第一个任务。自定义模型可通过 `~/.hapilon/agent/models.json` 接入。

> 看一下这个仓库的核心模块和测试入口，告诉我验证一次改动需要跑哪些命令。先不要修改文件。

`hapi` 是同一入口的短别名。已经配置好模型时，也可以从 shell 发起一次性请求，将回复输出到终端。下面这次请求不保存会话。

```sh
hapilon -p --no-session "概括当前仓库的测试入口，不要修改文件"
```

遇到安装或认证问题时，运行 `hapilon doctor`。升级时安装目标 Release 的 tarball，再重启 hapilon。本文介绍仓库当前代码，具体版本的功能以各版发布说明为准。

## 工作流

### 让 Agent 遵守项目约定

把团队通用的构建命令、验证要求和代码约定放进项目的 `.hapilon/HAPILON.md`。hapilon 会加载用户级和当前目录向上的约定。在 monorepo 里，可把 API 包专用的命令放进 `packages/api/.hapilon/HAPILON.md`，Agent 首次通过文件工具访问该子树后才载入。

`.hapilon/agents/rules/` 用于附加规则，`.hapilon/agents/skills/` 里的 `SKILL.md` 用于可复用的工作流程。可以用 `/skill:<名称>` 调用 Skill。包内提供了调研、交接、设计和提交快照等 [Skill](resources/skills/)。

hapilon 默认使用 `HAPILON.md` 作为项目约定入口，并拦截读取 `AGENTS.md` 和 `CLAUDE.md`。从其他工具迁移时，把要保留的约定写进 `.hapilon/HAPILON.md`。

### 配置模型与候补

用 `/tiers` 配置 `opus`、`sonnet` 和 `haiku`。这些名称是可配置的档位，可以绑定不同 provider 的模型。档内条目有顺序，`[0]` 选择第一项。登录后也可以用 `/fast-hapilon-setup` 生成一份档位建议，再确认保存。

```sh
hapilon --model "tier:sonnet[0]"
```

如果仓库需要自己的候补顺序，在 `.hapilon/model-tiers.json` 中写要覆盖的档位。以下示例只替换 `sonnet`，另外两档沿用全局设置。把条目换成 `/model` 中可用的模型即可。

```json
{
  "sonnet": [
    "provider-a/model-id:high",
    "provider-b/model-id"
  ]
}
```

`/subagent-models` 与 `/vision-models` 分别管理常规子 Agent 和图像子 Agent 的派发列表。适用的派发优先尊重显式点名；自动选择时，会根据已有配额快照跳过用量紧张的候选。可以用 `/quota-usage` 查看受支持的 provider 的配额或余额。

### 继续工作并整理上下文

- 最近在这个目录工作过，可以用 `hapilon -c` 续接。想手动挑选历史会话，用 `hapilon -r`。
- 只记得任务内容时，用 `/find-session` 描述你在找什么。配置好 `haiku` 档后，检索面板会列出带原文证据的候选，确认后切换会话。
- 构建和全量测试输出太长时，用 `/econ` 调节压缩与首尾保留行数。Agent 可用 `ctx_more` 取回省略的片段。长对话的上下文压缩由 ACP 管理，可用 `/acp` 查看。
- 跨仓库工作时，用 `/add-dir` 把外部目录加入当前会话的上下文，再用 `/dirs` 核对当前范围。

### 管理任务与 Agent 协作

在普通终端里可以用 `/tasks` 查看任务清单，通过 `/agents` 管理子 Agent。后台任务可以在命令结束时通知当前会话，适合等待构建、测试或依赖安装。

需要可见的独立角色面板时，在 **herdr pane** 或 **herdr-core 终端**启动 hapilon。打开 `/team`，选择「开始编排」准备 Worker 面板，再按需打开审查角色。

```text
/team:open reviewer
```

例如修一个失败的测试，owner 负责明确范围和验收命令，Worker 实现并回报验证结果，Review 只读检查改动。派发和回报可通过信箱排队，`hapilon team-status` 显示角色状态、任务进度和回执。团队也支持体验官、讨论成员和自定义角色。herdr-app 用户可运行 `hapilon setup-herdr` 添加启动入口。

## 工具与扩展

hapilon 随包加载 [内置扩展](src/extensions/) 和 [第三方扩展](src/extensions/npm-extensions.ts)。MCP 由 Pi 内核提供，可在 `~/.hapilon/agent/mcp.json` 配置服务，再用 `/mcp` 管理连接或登录。服务的配置格式见 [Pi MCP 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)。

| 用途 | 随包集成 |
| --- | --- |
| 查找代码和资料 | 本地文件与代码搜索、网页搜索与读取 |
| 检查界面 | 主会话中的浏览器与桌面操作工具，依赖对应的运行环境和权限 |
| 管理长任务 | 持久化任务列表、目标推进、后台任务与监控 |
| 交互与观察 | 结构化提问、工具输出浮层、思考计时、配额与上下文状态栏 |
| 回顾工作 | 会话进度摘要、Skill 使用统计与本地报告 |

## 常用命令

带 `/` 的命令在交互界面输入。

| 场景 | 命令 |
| --- | --- |
| 连接 provider、选模型 | `/login` · `/model` · `/tiers` |
| 恢复会话、查看上下文 | `/find-session` · `/acp` · `/econ` |
| 查看任务、子 Agent 和团队 | `/tasks` · `/agents` · `/team` |
| 加入或移除外部目录 | `/add-dir` · `/dirs` · `/remove-dir` |
| 管理 MCP、查看工具面板 | `/mcp` · `/pop` |
| 查看配额或设置 OpenAI Fast 模式 | `/quota-usage` · `/fast` |
| 查看 Skill 使用情况 | `/hapi-metrics skills` |
| 在 shell 查看帮助和诊断 | `hapilon --help` · `hapilon --version` · `hapilon doctor` |

## 配置和安全

用户数据默认在 `~/.hapilon/`。用绝对路径设置 `HAPILON_HOME`，可以给另一套环境单独保存设置和会话。

| 位置 | 用途 |
| --- | --- |
| `~/.hapilon/agent/` | Pi 的认证、模型设置、MCP 和会话记录 |
| `~/.hapilon/model-tiers.json` | 全局模型档位 |
| `~/.hapilon/subagent-models.json` · `vision-models.json` | 全局子 Agent 与图像模型列表 |
| `~/.hapilon/HAPILON.md` · `agents/rules/` · `agents/skills/` | 个人约定、规则和 Skill |
| `~/.hapilon/teams/roles/` | 团队自定义角色 |
| 项目内的 `.hapilon/` | 仓库约定、项目级模型配置、规则和 Skill |

默认的 [命令检查](src/extensions/hpl-safety-gate/)会为 Agent 的 `bash` 工具调用分级，对高风险操作进行拦截或确认。[文件路径保护](src/extensions/hpl-protected-paths/)单独检查文件工具对敏感路径的操作。后台任务使用独立执行通道。需要 OS 级限制时可以启用 `hapilon --sandbox`，各平台的准备条件见 [启动入口](src/cli/main.ts)。

## 从源码运行

```sh
npm ci --legacy-peer-deps
npm run build
node dist/cli.js --help
npm test
```

在当前仓库启动开发版可以运行 `npm run dev`。提交 TypeScript 改动时同步构建结果 `dist/`。也可以用 `npm run typecheck` 只检查类型，或分别执行 `npm run test:unit` 和 `npm run test:integration`。

<details>
<summary>源码和维护入口</summary>

| 位置 | 负责什么 |
| --- | --- |
| [`src/cli/`](src/cli/) · [`src/providers/`](src/providers/) | CLI 路由、启动 Pi 与 provider 相关设置 |
| [`src/extensions/`](src/extensions/) · [第三方扩展接线](src/extensions/npm-extensions.ts) | 模型、会话、项目上下文、工具、任务和团队 |
| [`src/config/`](src/config/) · [`src/safety/`](src/safety/) | 用户与项目配置、信任记录和沙箱 |
| [`resources/skills/`](resources/skills/) | 随包分发的技能 |
| [`src/patch/`](src/patch/) · [`src/test/`](src/test/) | Pi 兼容补丁、单元与集成测试 |
| [发版脚本](scripts/release.sh) · [安装冒烟脚本](scripts/sandbox-verify.sh) | 打包、发布和隔离环境安装验证 |

</details>
