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

hapilon 把 [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 和一组面向日常开发的扩展打包到一起。你可以在终端里把任务交给合适的模型、用自然语言找回以前的会话，或在 herdr 里开几个独立的角色面板协作。

- **接着上次做。** 用 `/find-session` 描述记得的任务或改动，从带原文证据的候选结果中恢复会话。
- **按档位用模型。** 给 `opus`、`sonnet`、`haiku` 分别配置模型和候补，用同一个档位名启动会话或指定团队角色。
- **在终端里分工。** 用 `/team` 打开角色面板，让 Worker 实现、Review 审查，由 owner 统一派发和收取结果。
- **看见配额和上下文。** 状态栏显示受支持的 provider 配额，有重置时间时一并显示。长命令输出可按需取回，上下文可增量压缩。
- **让项目约定跟着代码走。** 在 `.hapilon/HAPILON.md` 写项目约定。子目录也能单独定义规则，在 Agent 访问相关文件时载入。

## 快速开始

需要 **Node.js 22.19 或更新版本**。在 [GitHub Releases](https://github.com/nekomorph-woo/hapilon/releases/latest) 的 Assets 中复制 `hapilon-*.tgz` 的下载链接，用 npm 全局安装。下面以已发布的 `v0.21.63` 为例。

```sh
npm install -g https://github.com/nekomorph-woo/hapilon/releases/download/v0.21.63/hapilon-0.21.63.tgz
hapilon
```

在你要工作的仓库里启动 `hapilon`。进入交互界面后，用 `/login` 连接 Pi 支持的 provider，用 `/model` 选模型。自定义模型可通过 `~/.hapilon/agent/models.json` 接入。

第一次可以先让 Agent 读一遍项目，再决定改什么。

> 看一下这个仓库的测试入口和核心模块，告诉我验证一次改动需要跑哪些命令。先不要修改文件。

已经配置好模型后，也可以从 shell 发起一次性请求。下面的例子把答复打印到终端，这次对话不保存为会话。

```sh
hapilon -p --no-session "概括当前仓库的测试入口，不要修改文件"
```

`hapi` 和 `hapilon` 是同一个 CLI 的两个入口。遇到配置问题，运行 `hapilon doctor` 检查 Node、Pi 启动入口和认证状态。升级时安装目标 Release 的 tarball，再重新启动 hapilon。下文功能对应仓库当前代码，已发布版本的差异见各版 Release 说明。

## 工作流

### 找回上次的工作

打开 `/find-session`，像向同事描述任务一样描述你要找的会话。

> 上次排查 Windows Terminal 换行问题的是哪个会话？我想接着验证那次改动。

检索使用 `haiku` 档的首选模型。浮层里的检索子进程只能读取会话记录，候选结果里的原文证据会与记录核对。确认候选后，当前终端会切换到对应会话。只想继续当前目录最近的会话，用 `hapilon -c`。想从历史列表手动挑选，用 `hapilon -r`。

### 给任务选一个模型档位

在 `/tiers` 里为三档选模型、调整候补顺序，也可以设置启动时的默认模型。三档是 hapilon 的配置名，可以绑定任意已接入的 provider。当前仓库还提供 `/fast-hapilon-setup`，登录后可从可用模型生成一份推荐配置，再由你编辑和确认。

设好档位后，可以在 shell 里按档启动。下面的 `[0]` 是从零开始的档内索引。

```sh
hapilon --model "tier:sonnet[0]"
```

如果某个项目需要自己的候补顺序，可以在项目的 `.hapilon/model-tiers.json` 里只写要覆盖的档位。以下示例覆盖 `sonnet`，另外两档沿用全局设置。把示例条目换成自己在 `/model` 中可用的模型，可选的 `:high` 后缀指定思考强度。

```json
{
  "sonnet": [
    "provider-a/model-id:high",
    "provider-b/model-id"
  ]
}
```

`/subagent-models` 和 `/vision-models` 管理的是派发列表。在适用的派发里，你明确点名的模型会优先使用。自动挑选时，如果已读取的配额快照显示某个 provider 的用量窗口达到 90%，会顺延到后面的候选。全部候选都紧张时，沿用父会话模型。

### 开一组角色面板

在 **herdr pane** 或 **herdr-core 终端**里启动 hapilon，输入 `/team`，选择「开始编排」。这个会话成为 owner，并准备一个 Worker 面板。需要单独审查时，打开 Review 面板。

```text
/team:open reviewer
```

以修复一项失败的测试为例。

1. 把失败现象、允许修改的范围和验收命令交给 owner，由它派给 Worker。
2. Worker 实现、自验，并把结果和验证情况回报给 owner。
3. Review 只读检查改动及遗漏，owner 根据回执决定接收还是继续修改。

派发和完工回报通过信箱投递，角色忙碌时消息可以排队。在团队终端运行 `hapilon team-status` 查看角色状态、任务进度和回执。也可以从 `/team` 加入体验官、讨论成员或自定义角色。herdr-app 用户可运行 `hapilon setup-herdr` 添加启动菜单入口。

### 从长输出里找回细节

运行全量测试或构建时，`/econ` 可以调节 `bash` 输出的压缩阈值和保留的首尾行数。Agent 需要核对某一段省略输出时，可以用 `ctx_more` 按行取回。对于随着对话变长积累的上下文，可以用 `/acp` 查看压缩状态。

## 常用命令

带 `/` 的命令在 hapilon 的交互界面输入。

| 你想做什么 | 命令 |
| --- | --- |
| 续接、选模和编排 | `/find-session` · `/tiers` · `/team` |
| 把外部目录加入当前会话 | `/add-dir` · `/dirs` · `/remove-dir` |
| 查看 provider 配额或余额 | `/quota-usage` |
| 查看或调节上下文与命令输出 | `/acp` · `/econ` |
| 在浮层查看折叠的工具面板 | `/pop` |
| 管理 MCP 连接 | `/mcp` |
| 配置受支持模型的 OpenAI Fast 模式 | `/fast` |
| 查看本地会话或技能使用统计 | `/hapi-metrics` |
| 在 shell 中查帮助、版本、配置状态 | `hapilon --help` · `hapilon --version` · `hapilon doctor` |

## 配置和安全

用户数据默认在 `~/.hapilon/`。可以用绝对路径设置 `HAPILON_HOME`，为另一套环境单独保存设置和会话。

| 放在哪里 | 放什么 |
| --- | --- |
| `~/.hapilon/agent/` | Pi 的认证、模型、设置、MCP 和会话记录 |
| `~/.hapilon/model-tiers.json` | 全局模型档位 |
| `~/.hapilon/teams/roles/` | 团队自定义角色 |
| `~/.hapilon/HAPILON.md` 与项目的 `.hapilon/HAPILON.md` | 全局与项目约定 |
| `<子目录>/.hapilon/HAPILON.md` | Agent 通过文件工具访问对应目录时载入的约定 |

在 monorepo 中，可以在根目录的 `.hapilon/HAPILON.md` 写通用约定，再在 `packages/api/.hapilon/HAPILON.md` 写 API 包专用的测试命令。后者会在 Agent 首次用 `read`、`edit` 或 `write` 访问对应目录里的文件后载入。

hapilon 会对 Agent 通过 `bash` 工具发出的命令做分级处理，并对受保护的文件路径做单独检查。需要操作系统级隔离时，可使用 `hapilon --sandbox`。实现与平台准备条件见 [启动入口](src/cli/main.ts) 和 [安全模块](src/safety/)。

## 从源码运行

```sh
npm ci --legacy-peer-deps
npm run build
node dist/cli.js --help
npm test
```

在当前仓库启动开发版可以用 `npm run dev`。提交 TypeScript 改动时同步构建结果 `dist/`。只检查类型可用 `npm run typecheck`，也可以用 `npm run test:unit` 或 `npm run test:integration` 分别执行两类测试。

<details>
<summary>源码和维护入口</summary>

| 位置 | 负责什么 |
| --- | --- |
| [`src/cli/`](src/cli/) · [`src/providers/`](src/providers/) | 命令路由、启动 Pi、加载配置 |
| [`src/extensions/`](src/extensions/) · [第三方扩展接线](src/extensions/npm-extensions.ts) | 模型、会话、团队、上下文、检索、任务与终端工具 |
| [`src/config/`](src/config/) · [`src/safety/`](src/safety/) | 用户与项目配置、信任记录和沙箱 |
| [`resources/skills/`](resources/skills/) | 随包分发的技能 |
| [`src/patch/`](src/patch/) · [`src/test/`](src/test/) | Pi 兼容补丁、单元与集成测试 |
| [发版脚本](scripts/release.sh) · [安装冒烟脚本](scripts/sandbox-verify.sh) | 打包、发布和隔离环境安装验证 |

</details>
