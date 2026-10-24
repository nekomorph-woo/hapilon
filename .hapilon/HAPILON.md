# HAPILON.md

hapilon 仓库的项目级约定。hapilon 是以 Pi Coding Agent 为内核的终端 Coding Agent（`hapilon`/`hapi` 双命令，薄包装 spawn pi）。

## 代码维护哲学（写代码前先读这段）

- 代码是与人类同事共同维护的：可读性、可维护性、业务理解能力优先于一切。禁止为了「快」或「容易推理」把业务代码写乱；禁止炫技：业务代码里不用过度防御、不用人类同事难读懂的写法。
- 唯一例外：工具函数、helper 类函数可以为极致性能采用适合的写法（仍要自文档化命名）。
- 像「家庭整理大师」一样安置代码：代码、包、文档并井有条，各有其位；同一层内风格一致，同一概念只有一个家。新代码先进对的地方，再谈写好。

## 语言

- 沟通、代码注释、文档统一简体中文；专业术语保持原始语种（不翻译）。
- 代码、标识符遵循英文惯例；commit message 统一简体中文（标题与正文，含 type/scope 后的描述）。

## 构建与验证

- `npm ci` 需要 `--legacy-peer-deps`（ask-user 7.4 起 peer 已兼容 pi 1.x，flag 属历史遗留，撤销前需验证全量安装）。
- `npm run build`（tsc → `dist/`）。**dist 入库**：src 改动必须同步 dist——随功能提交，或紧跟 `chore(build): sync dist ...`。
- `npm run test:unit` 全量单测；改 extensions/prompt 后先跑相关文件再跑全量。
- TypeScript 走 Effect 风格：typed errors（Data.TaggedError）、Effect.gen，见 effect-typescript 技能。

## Effect TS（写代码前先读这段）

- 新代码默认 Effect：`Effect.gen` + typed errors（`Data.TaggedError`），错误进类型签名（`Effect<Success, Error>`）；不裸 throw、不用 try/catch 吞错。
- Promise 边界用 `Effect.tryPromise({ try, catch })` 包装，catch 把 unknown 归一为带 message 的 typed error。
- catch 之后禁止静默降级：要么进错误通道，要么 `console.warn` + 明确命名的降级值——不许当无事发生。
- 例外（允许普通 async/await 或裸 throw）：纯同步小工具函数、已定型不再改动的 async 遗留代码、及其测试。
- 动手前先读 effect-typescript 技能；拿不准某处该不该用 Effect 时，用。

## 扩展通知（notify）

- 运行时提示统一走 `src/extensions/notify.ts` 的 `notify()`。它是 pi `ctx.ui.notify` 的出口，不是替代：有 UI 时送 TUI 状态行，未就绪（启动早期、print 模式）回落 console.warn，不丢消息。不要再直接 console.warn 发运行时提示。
- 手头有 ctx（钩子、命令处理器）直接 `ctx.ui.notify(...)`；无 ctx 的模块（config、工具函数、workflow 全局钩子）用 `notify(...)`——两条路同一通道。
- sink 全进程共享、注册一次即可（现挂在 hpl-subagent-models 的 before_agent_start），新扩展不用管。保留 console 的例外：team-cli/wait-pane 的命令 stdout、ensure-configs 的启动校验——那些是命令输出，不是通知。
- 连续通知不互相覆盖靠 ensure-pi-patch 的 showStatus 补丁（marker `hapiStatusStack`）：状态行追加不替换，pi 内置提示（Switched to… 等）一并生效。

## 提交纪律

- 一切修改提交必须走 snap 技能；Conventional commits：type/scope 英文，描述与正文简体中文（覆盖 snap 按历史提交推断语言的默认优先级——历史是英文，新提交仍走中文）；业务高度（用户视角，一行一个想法，禁止罗列文件/版本号）；正文 ≤3 行只讲 why——即 snap skill 的标准。修复坑的提交另需在正文末加 `Pit:` trailer（格式见「坑的记录与确认」）。
- 仓库常有并行会话写入：commit 前 `git status` 逐条过目，显式路径 staging，禁 `git add -A`。
- 不主动 push；用户明确要求才 push / 走 PR。

## 版本规范

- 初始版本 0.1.0。
- 第 1 位（major）：必须用户指定才能升级。
- 第 2 位（minor）：必须用户指定才能升级；模型可依已存量修改数量建议升级，但只有建议权，没有执行权。
- 第 3 位（patch）：每发生一次 snap 技能提交自动 +1，随该提交一并写入 package.json；版本升级本身的提交不触发再计数。

## 目录要点

- `src/extensions/hpl-*` — 内置扩展：hpl-system-prompt（系统提示全量组装，含提交纪律小节）、hpl-safety-gate、hpl-model-tiers、hpl-subagent-models（subagent 派发模型列表，Agent/TaskExecute 拦截改写）、hpl-orchestra（team/pane 编排）、hpl-herdr（herdr 内的 hapi 身份与状态上报）等。
- `resources/skills/` — 内置技能库（随版本分发）。
- `src/patch/ensure-pi-patch.ts` — 对 node_modules 的幂等补丁表（pi 包：中段 slash 触发门、状态行追加不覆盖；hapilon 自身依赖：后台任务插件的 Windows shell 与耗时展示、pi-subagents 的 workflow 派发模型钩子）；上游变更导致锚点失配时只有启动警告，需对照新源码更新锚点表。
- MCP 走 pi 内置（builtin:mcp）：`~/.hapilon*/agent/mcp.json` 由内核直接读取，渐进式暴露（tool_search 按需加载）。
- `.hapilon/` — 本地运行时目录（gitignored）：artifacts、handoff 等 skill 产物。
- 文档落盘：调研/决策笔记 → `docs/research/`；用户明示留存的交付物 → `docs/artifacts/`；临时产物 → `.hapilon/<skill>/` 或 OS temp；领域词汇表（ubiquitous language）→ `.hapilon/CONTEXT.md`。

## 坑的记录与确认

- 不随手编辑「已知坑」：踩坑时在**修复它的 snap 提交**正文末加 trailer `Pit: <一句话症状> [fact|habit]`；人类回溯后确认的坑才写进「已知坑」。
- 事实坑（不查必错、错了难定位，如环境目录、锚点失配）**一次即标**；习惯坑（写法纪律，如裸 throw、吞错降级）**第二次遇到才标**。
- 回溯（人类主导，低频）：`git log --grep='^Pit: '`——既可分析内容，也可按次数/时间衰减统计；确认的坑更新进「已知坑」，过期的删。
- 「已知坑」上限约 10 条，每条一句话症状 + 根因 + 避法（或可删判据）；超出时先删已失效的。

## 已知坑

- Effect 风格是高频失守点：连写过 Effect 的人也会在赶活时退回裸 throw/async——review 与自检时优先看这条。（习惯坑）

- dev 模式 `devhapi` 的 HAPILON_HOME 是 `~/.hapilon-dev`（配置、sessions、模型档位都在那边，别查错家目录）。（事实坑）
- model-tiers 双层配置：全局 `~/.hapilon*/model-tiers.json` + 项目 `.hapilon/model-tiers.json`，项目按档覆盖全局。（事实坑）
- teams 配置（`~/.hapilon-dev/teams/`）的 role.model 支持 `tier:<name>[<index>]` 指代与具体 id，过期 id 自动回落档位[0]。（事实坑）
