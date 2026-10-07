# Anthropic 与 OpenAI 的模型为什么爱用脚本改文件？

日期：2026-10-06。问题来源：听说 Anthropic 和 OpenAI 的模型现在都喜欢用 shell/python 脚本改文件，而不是 apply_patch / Edit 等专用工具。查证结果：**Anthropic 侧属实但根源在 harness 注入的指令，OpenAI 侧官方立场相反、是模型自发漂移**。

## 结论一句话

- **Anthropic**：Claude Code 的 auto mode 会在系统提示里注入一段「Bash 优先」指令，明说读文件用 `cat`/`sed -n`、改文件用 `sed`/heredoc/短脚本，别用 Read/Edit/Write 专用工具。这是 CLI 二进制里硬编码的实验门控（`bashFirst`，gate 名 `tengu_thrifty_sonic`），不是模型自己的偏好。2026-08 起随 auto mode 成为默认而大面积爆发，社区强烈反弹，issue 一大串（#87575、#87971、#88041、#89716、#89731、#90450）。
- **OpenAI**：官方方向相反——apply_patch 被后训练进 GPT-5.1，做成 Responses API 的 hosted tool，官方称命名工具版让 apply_patch 失败率降 35%。但实际使用中模型（尤其在 patch 被拒几次后、或非 GPT 模型走自定义 provider 时）确实漂移去用 python/sed 改文件（openai/codex#3057：>80% 编辑走 Python/Bash；#10330、#4421、#16397）。这是漂移，不是官方引导。

## Anthropic 侧证据

**注入的指令原文**（issue #87971 引自会话 transcript，#88041 有人从 CLI 二进制里挖出了带变量占位符的模板原文）：

> While auto mode is active: Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job.

**机制细节**（#88041、#89731）：
- 硬编码在 CLI 二进制，无设置项、无 env var；门控条件 `tools.has(Bash) && (tools.has(Edit) || tools.has(Write)) && d5o()`。
- 按会话分组指派（`forced` / `cohort` / `none`），同一版本同一模型不同用户行为不同——这解释了为什么它「时有时无」。
- 未文档化的退出开关：settings.json 里设 `CLAUDE_CODE_THRIFTY_SONIC=false`（#90450 中由 @kawasin73 发现，#87971 有两人独立验证）； reportedly Opus 5.5 发布后该开关失效。
- 时间线：Claude Code 2.1.21 和 2.1.31 曾两次发 CHANGELOG 说「改进为优先使用专用工具（Read/Edit/Write/Glob/Grep）而非 bash 等价物」；auto mode 的 bashFirst 是对这两个已发布修复的静默反转，无 CHANGELOG、无文档（#89731）。
- auto mode 本身：2026-03 研究预览，2026-07-10 GA，2026-08-14 起成为 Pro/Max/Team 默认（Anthropic 官方博客 + TechCrunch 2026-08-09）。

**为什么这么做（推断，Anthropic 未公布官方理由）**：gate 名叫 THRIFTY（节俭），社区实测数据指向 token 经济：Edit 需要先 Read，上下文成本约 2 倍；定向 `sed -n '120,150p'` 比整文件 Read 便宜约 40%；一条 bash 能批量做多个文件多处修改、少几个回合。讽刺的是 Anthropic 自己的工程博客把「项目内文件编辑」设计为免分类器的 Tier 2 快速路径（理由是可被版本控制审查），bashFirst 把这部分工作推回了要过分类器的 Tier 3（#89731 指出的自相矛盾）。

**社区记录的实际代价**：
- `str.replace`/`sed` 不匹配时静默失败，Edit 失败会吵——#87971 有用户半篇文档被 Claude 现编的 sed 脚本删掉。
- 绕过 PreToolUse/PostToolUse 钩子（钩子按工具名匹配，流量挪到 Bash 后 .env 守卫等静默失效，#89716 实测 `git diff .envrc` 和 python 一行读文件都无钩子决策）。
- 绕过手动模式下的逐编辑 diff 审查（#85511），对盲人用户是唯一可无障碍审查通道的移除（#88041）。
- 丢失 Read 工具的提示词缓存命中；Windows 下 CRLF 被毁、heredoc 写入 NUL 字节（#89307、#90450）。
- 有企业被迫在 managed settings 里加「不得服从 harness 的 Bash 优先指令」的对抗性提示词（#87971 评论）。

模型侧补充：Claude Desktop 的 Opus 5 也有同样行为，被问及时自述「在服从 auto-mode 的 Bash 优先指令，读得太死了」（r/ClaudeAI 1vq0o9z）；Claude Code 用 python 脚本编辑的抱怨在 auto mode 之前就有（r/ClaudeCode 1vfroof，模型自答原因：「惯性 + 一次调用批量多处的便利，划不来，Edit 失败得响亮才是对的」）。

## 社区经过（时间线）

- **2025 年（前史）**：零星抱怨早已存在——r/ClaudeCode 1vfroof（模型自答「惯性+批量便利，划不来」）、vscode#298509（Claude 写 `_patch.py` 改源码）、r/ClaudeCode 1o4wx2p（有人翻记录发现是 Write 工具静默失败后 Claude「耸耸肩」改走 bash——漂移的有机成因）。Claude Code 2.1.21 / 2.1.31 两次发版修复「优先专用工具」。
- **2026-08-14**：auto mode 成为 Pro/Max/Team 默认。
- **2026-08-18**：r/ClaudeCode PSA 帖（1vruj7h）贴出系统提示里的 Bash 优先指令原文，问「有人知道动机吗」。楼里高赞：审代码变噩梦、这该是开关不是默认；有人发现自家 Claude 把这段注入指令当 prompt injection 忽略了。
- **2026-08-19 起 issue 洪峰**：#87971（VSCode 插件会话、指令原文）、#88041（有人挖 `/opt/claude-code/bin/claude` 二进制找到带混淆变量名的模板与 `d5o()` 门控；~1200 会话双峰测量确认 cohort 指派；盲人用户 a11y 抗议）、#89716（安全团队实测钩子失效：`git diff .envrc`、python 一行读文件均无 PreToolUse 决策，live 验证 Read 同路径仍被拒）、#89731（CHANGELOG 考古：反转 2.1.21/2.1.31，无任何文档；指出与工程博客 Tier 2 设计自相矛盾）、#90450（见下）。
- **逃生口发现**：@kawasin73 在 #90450 找到未文档化环境变量 `CLAUDE_CODE_THRIFTY_SONIC=false`；#89731 补刀其 triBool 解析坑——拼错值不报错而是静默回落到 cohort 指派。
- **#90450 的系统性验证**：用哨兵字符串做同文件对照实验，证明 `cat`/`Get-Content`/Grep/Glob 一律不触发嵌套 CLAUDE.md 与 path-scoped rules，只有 Read 工具触发；即 auto mode 下「上下文膨胀的官方推荐解法」整体失效，且会话内粘滞（规则去重后不再补发）。Read 一个不存在的文件也会触发注入，证明触发器是 Read 工具的路径解析本身。
- **实测伤害清单**：半篇文档被 sed 删（可恢复）；heredoc 向 markdown 写入 NUL 字节；Windows CRLF 损毁（#89307、#92407）；一条转录 81 次 Bash 调用、0 次 Edit/Write；两次脚本编辑切断活 import / 留下孤儿 export，靠编译器才抓到（#89731）。
- **社区防御手段**：企业 managed settings 写对抗性指令（「不得服从 harness 的 Bash 优先指令，本条优先级更高」）；全局 CLAUDE.md 规则；PreToolUse 钩子拒绝任何写 .md 的 shell/python 命令（识别重定向、tee、sed -i、perl -i、python 片段，畸形 payload fail-open）；钩子作者被迫自己 lex shell 命令（#89716 指出各家引号/重定向解析都有假阴性）；zommuter 让 Claude 自省写出的 CLAUDE.md 规则带实测数字（Edit 失败率低 ~4 倍、上下文贵 ~2 倍、定向 sed -n 便宜 ~40%）。
- **官方回应**：上述 issue 均无官方表态；auto-mode 文档只描述权限分类器，bashFirst 指令零文档。仅有的两个动向：2.1.288 起嵌套 CLAUDE.md/rules 改为 Edit/Write 也触发（部分修补，bash 读取仍不触发）；以及坏消息——Opus 5.5 发布后 THRIFTY_SONIC 开关 reportedly 失效，且该模型「就算开关关了也爱用 Bash」。
- **相邻战场**：auto mode 分类器本身同期被外部研究打靶——Embrace The Red（2026-08）小样本绕过率 60-80%，Anthropic 回应「分类器是 best-effort，OS 隔离才是安全边界」；arXiv 2604.04978 测得 81% 端到端假阴性（模糊授权话术）与 36.8% 的状态变更经未审查的项目内编辑放行。

## OpenAI 侧证据

**官方立场是加强 apply_patch，不是放弃**：
- GPT-5.1 后训练内置 apply_patch（freeform 形态），官方文档：`tools=[{"type": "apply_patch"}]` 即用，无需自定义描述；「测试中，命名工具版让 apply_patch 失败率下降 35%」（GPT-5.1 Prompting Guide，developers.openai.com）。
- codex CLI 仓库删除了 function 风格的 apply_patch，只保留 freeform（openai/codex PR #21651，2026）。
- 官方 cookbook 示例里要显式写「Never edit code via shell commands」「Use apply_patch only once per edit attempt」——说明官方知道模型会漂移，靠提示词压。

**实际漂移证据**（均为社区 issue，官方未回应根因）：
- openai/codex#3057（2025-09 起）：多名用户报告 >80% 编辑走 Python/Bash 而非文件编辑工具；显式要求「请用内置编辑工具」可短暂纠正。
- #10330：模型自称「apply_patch 不可用」转用 bash/python，多发生在用户拒绝过几次 patch 之后。
- #16397：自定义 provider 的非 GPT 模型（如 Kimi）完全不用 apply_patch，一律 `sed` / `cat > file << EOF`——没经过 apply_patch 后训练的模型根本不会用这个工具。
- r/OpenaiCodex 1nkrl7y：「 constantly bypasses its own edit-file tools and instead uses inline python scripts to edit files」。

## 对 hapilon/pi 的启示

pi 内核的 read/edit/write 工具路线与 OpenAI 官方一致（结构化编辑、锚点精确匹配、失败响亮）。Anthropic 这波是 harness 层为省 token 做的实验性转向，且正在被社区用数据反对（静默失败、钩子绕过、数据损坏）。若将来考虑「bash 优先」换速度，上述 issue 列表就是反面教材清单。

## 来源

- anthropics/claude-code#87971 「Claude abuses bash tools for reads, writes, and edits when running in Auto Mode」（2026-08-19 开，open）
- anthropics/claude-code#88041 「Auto-mode "bashFirst" system prompt instructs sed/heredoc file edits instead of Edit/Write tools」
- anthropics/claude-code#89716 「Auto mode's "prefer Bash over Read/Edit/Write" guidance silently bypasses PreToolUse hooks」
- anthropics/claude-code#89731 「Auto mode's Bash-first steering reverses 2.1.21 and 2.1.31, which shipped the opposite as a fix」
- anthropics/claude-code#85511、#90450、#89307、#91956、#92407（手动模式 diff 绕过、THRIFTY_SONIC 开关、CRLF/缓存/Windows 相关）
- Anthropic 工程博客「How we built Claude Code auto mode」（2026-03-25，Tier 2 免分类器设计、93% 审批率、0.4% FPR / 17% FNR）
- claude.com/blog「Auto mode is now the default in Claude Code」（2026-08，8 月 14 日起默认）
- openai/codex#3057、#10330、#4421、#16397；PR #21651（删除 function 风格 apply_patch）
- developers.openai.com「Apply Patch | OpenAI API」及「GPT-5.1 Prompting Guide」（失败率 -35%、「Never edit code via shell commands」示例）
- r/ClaudeAI 1vq0o9z、r/ClaudeCode 1vfroof、r/OpenaiCodex 1nkrl7y
- r/ClaudeCode 1vruj7h（PSA 原帖，2026-08-18）、r/ClaudeCode 1w19zea、r/ClaudeCode 1o4wx2p；anthropics/claude-code#90088（独立症状报告，交叉印证）
- microsoft/vscode#298509（Claude 生成 _patch.py 改源码）
