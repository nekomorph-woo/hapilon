# 项目定位
Hapilon 是一个以 Pi Coding Agent 为运行内核的通用终端 Coding Agent。

以 https://github.com/nekomorph-woo/wokiii 管道流：Discussion-Decision-to-Action. Constructing a circular and efficient value chain 为设计指导方向，侧重编码，通用任务次之的 Pi-extension 式项目。

# 我的弱项 - 你需要特别关照
- 当前项目会使用我日常不太常用的 Java 编程语言编写，因此你在变更了任意逻辑代码、文档、注视、提示词、引用等等会变更项目行为的内容，在 `dialogue-style.md` 基础之上，你还需要使用 `人话` 耐心地向我解释代码业务逻辑（DO NOT 语法）、目的、产生影响。
- 项目不会使用 `wokiii` 管道式自动化流水线方式的 Vibe Coding，而是 `目标/问题驱动 ➡️ 解答讨论 ➡️ 构思完善 ➡️ Planning with Claude Code's plan mode  ➡️ Coding with agent` 的 `傻瓜式` 流程进行。
- **任务完整实现后，详细告知我如何进行端到端验证**
- `wok-execute`：TDD编码完成后，详细告诉我你覆盖的测试（单元测试/集成测试），避免测试与真实需求的理解偏差

# 原则和底线
1. Fail Fast / Errors Never Pass Silently：不要在代码里藏兜底逻辑来吞掉错误、隐藏问题。出了问题就应该让它爆出来，否则你永远找不到真实问题。
2. Fix the Cause, Not the Symptom / Don't Paper Over Bugs：当一个问题出现时，不要用各种 small fix、针对性补丁来掩盖它。必须定位真实根因，彻底修复。在 bug 上糊纸只会让系统积累你不知道的危险暗病。
3. Make It Observable：即使问题很难定位，也绝不要偷懒做表面修复。应该给项目增加充分的日志和可观测性，保证下次问题再现时你有足够信息去定位。问题无法修复时，只需要诚实告诉我信息不足、需新增日志，不要假装修好了。
4. Design for Debugging / Traceability：始终注意在关键路径上给自己留足排查日志，确保每一个关键节点都是可追溯的。
5. Living Documentation / Single Source of Truth：当项目关键技术栈或产品方向发生变更时，同步更新 agents.md。文档必须随代码一起演进，不能让它变成过时的谎言。
6. Don't Break Mainline：大规模重构或实验性改动前，必须先确保本地工作区是干净的，若还存在未提交内容，提醒我。

# 编码文件/代码组织
- **合理的模块拆分，禁止将所有东西全部写在一个文件中，但也不要将代码拆的细碎到多个文件中，保持合理的组织**
- **所有的技术债/预留扩展全部以结构化描述方式记录到 `_backlog` 目录下，一个内容一个文件 **，包含以下结构块：背景，目的，技术债/预留扩展描述，参考引用，项目中指向的位置

# Claude Code Plan Mode & Planning File
- **当前项目使用 Claude Code Plan Mode时，必须将Planning计划文件输出到 `_hapilon_plans` 目录下，禁止按照Claude Code默认的目录输出到 `/Users/xx/.claude/plans/`，方便我归档和检查
- Planning 时注意将验收标准定好，我将使用 TDD 的方式进行编码，需要符合需求的验收标准内容