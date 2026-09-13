# HAPILON.md

hapilon 仓库的项目级约定。hapilon 是以 Pi Coding Agent 为内核的终端 Coding Agent（`hapilon`/`hapi` 双命令，薄包装 spawn pi）。

## 语言

- 默认简体中文交流；代码注释，commit message 统一简体中文（标题与正文，含 type/scope 后的描述）；代码、标识符、术语遵循英文惯例。

## 构建与验证

- `npm ci` 需要 `--legacy-peer-deps`（`@zhushanwen/pi-ask-user` 的 peer 声明滞后，预存问题；overrides 已豁免 pi-ask-user 与 pi-mcp-adapter）。
- `npm run build`（tsc → `dist/`）。**dist 入库**：src 改动必须同步 dist——随功能提交，或紧跟 `chore(build): sync dist ...`。
- `npm run test:unit` 全量单测；改 extensions/prompt 后先跑相关文件再跑全量。
- TypeScript 走 Effect 风格：typed errors（Data.TaggedError）、Effect.gen，见 effect-typescript 技能。

## 提交纪律

- Conventional commits：type/scope 英文，描述与正文简体中文（覆盖 snap 按历史提交推断语言的默认优先级——历史是英文，新提交仍走中文）；业务高度（用户视角，一行一个想法，禁止罗列文件/版本号）；正文 ≤3 行只讲 why——即 snap skill 的标准。
- 仓库常有并行会话写入：commit 前 `git status` 逐条过目，显式路径 staging，禁 `git add -A`。
- 不主动 push；用户明确要求才 push / 走 PR。

## 目录要点

- `src/extensions/hpl-*` — 内置扩展：hpl-system-prompt（系统提示全量组装，含提交纪律小节）、hpl-safety-gate、hpl-model-tiers、hpl-orchestra（team/pane 编排）等。
- `resources/skills/` — 内置技能库（随版本分发）；`resources/themes/` — TUI 主题（hapilon-dark/light）。
- `src/patch/ensure-pi-patch.ts` — 对 node_modules 里 pi 包的幂等补丁（代码块底色）；pi 升级锚点失配会有启动警告，需对照新源码更新锚点表。
- `.hapilon/` — 本地运行时目录（gitignored）：artifacts、handoff 等 skill 产物。
- 文档落盘：调研/决策笔记 → `docs/research/`；用户明示留存的交付物 → `docs/artifacts/`；临时产物 → `.hapilon/<skill>/` 或 OS temp；领域词汇表（ubiquitous language）→ `docs/glossary.md`（懒创建，第一个术语敲定时建）。

## 已知坑

- dev 模式 `devhapi` 的 HAPILON_HOME 是 `~/.hapilon-dev`（配置、sessions、模型档位都在那边，别查错家目录）。
- model-tiers 双层配置：全局 `~/.hapilon*/model-tiers.json` + 项目 `.hapilon/model-tiers.json`，项目按档覆盖全局。
- teams 配置（`~/.hapilon-dev/teams/`）的 role.model 支持 `tier:<name>[<index>]` 指代与具体 id，过期 id 自动回落档位[0]。
