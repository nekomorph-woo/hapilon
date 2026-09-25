# Claude Code 的 recap 功能本身：存在性、触发、展示、演进

日期：2026-09-25 · 切面：专攻 Claude Code 的 recap/session summary 功能本体（触发/展示/结构/长度/演进）。提示词设计横评见同日 `2026-09-25-recap-prompt-design.md`（同事负责），本文只做交叉验证，不展开 compact。

证据等级标注：**[官方]** 官方 changelog/文档原文；**[二进制]** 自行对 npm 分发的原生二进制做 strings 提取（v2.1.282，2026-09-24 发布）——闭源混淆分发，但 JS 字符串原样内嵌，可信度最高的非官方渠道；**[逆向重建]** 第三方仓库自述"reconstructed approximation"；**[用户观察]** 博客/视频/社区描述。

## 1. 结论速览

**有，而且就是 hapilon recap 的直接同构物。** Claude Code 自 **v2.1.108（2026-04-14 发布）** 起内置 session recap，内部代号 **away summary**（配置键 `awaySummaryEnabled`，环境变量 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`）：

- **一行式**会话摘要，用户离开终端后回来时"已经躺在那"；
- 触发 = 距上个完成 turn ≥ **3 分钟** 且**终端失焦** → 后台预生成（不是回来才生成）；
- transcript 内一条**斜体 system 消息行**（`subtype: "away_summary"`），不是弹窗、不是 statusline；
- 内容 **1-2 句、40 词以内、无 markdown**，程序级 **400 字符硬上限**（词边界截断）；
- 默认全 plan/全 provider 开启，`/config` 里叫 "Session recap"，手动命令 `/recap`；
- 生成走**复用 prompt cache 的后台 fork 请求**（禁工具、单 turn、不落盘 transcript、不写缓存）。

hapilon 规划的"空闲 3 分钟小模型摘要 widget"与它几乎逐点对上——好消息是设计方向被 Anthropic 验证过，细节可以直接抄（见 §5）。

## 2. 功能演进时间线（changelog + npm 发布日期）

| 版本 | 日期 | 条目 | 要点 |
|---|---|---|---|
| 2.1.69 | 2026-03-04 | "Changed resuming after compaction to no longer produce a **preamble recap** before continuing" | 旧的"压缩后恢复前先来一段摘要"被**移除**——说明早期有过更重的 resume 摘要形态，被砍掉换成轻量方向 |
| **2.1.108** | **2026-04-14** | "Added **recap feature** to provide context when returning to a session, configurable in `/config` and manually invocable with `/recap`; force with `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` if telemetry disabled" | 功能正式上线；灰度先开遥测用户（statsig 门控） |
| 2.1.110 | 2026-04-15 | "Session recap is now enabled for users with telemetry disabled (Bedrock, Vertex, Foundry, `DISABLE_TELEMETRY`). Opt out via `/config` or `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0`"；修复 focus mode 下不显示 | 全量放开，显式 opt-out 路径 |
| 2.1.113 | 2026-04-17 | "Fixed session recap **auto-firing while composing unsent text** in the prompt" | 输入框有草稿时不触发——护栏是上线 3 天内补的 |
| 2.1.181 | 2026-06-17 | "Fixed `/recap` and conversation forks using the **previous model** immediately after a model switch" | recap 走 fork 请求，模型跟会话走（见 §3.6） |
| 2.1.186 | 2026-06-22 | "Fixed background session recaps being duplicated; **the agent's own end-of-turn summary now shows as the recap line**" | 后台会话里 agent 自己的 turn 末摘要复用为 recap，避免两套摘要 |
| 2.1.196 | 2026-06-29 | "Fixed duplicate recap lines … a schema-rejected **StructuredOutput** attempt no longer renders alongside its retry" | recap 生成有结构化输出 + 重试路径 |
| **2.1.236** | **2026-08-19** | "Fixed occasional **runaway session recaps**: recap text (automatic and `/recap`) is now **capped at 400 characters, cut at a word boundary**" | 长度失控事故 → 400 字符程序级硬顶 |
| 2.1.251 | 2026-08-28 | "Fixed italic text (**such as the session recap line**) rendering as highlighted blocks in GNU screen / tmux `screen`" | 证实展示形态为**斜体单行** |
| 2.1.257 | 2026-09-01 | "Fixed sessions with an advisor model set missing the prompt cache on **background requests (compaction, `/recap`, prompt suggestions)**" | recap 与 compact、prompt 建议同属后台请求一类 |
| 2.1.268 | 2026-09-10 | "rapid **terminal focus reports during a session recap** no longer keep the CPU high" | 触发依赖终端 focus 事件流 |

第三方生态（HN Algolia）：`vibe-log`（auto daily/weekly recap notes）、`DevDay`（end-of-day recap）、`ccstory`（weekly recap）、`madebywelch/recap`（daily briefing）——in-session 一行 recap 之外存在明确的"日/周级回顾"工具需求。**[用户观察]**

## 3. 功能设计细节

### 3.1 触发条件 **[官方 + 二进制交叉验证]**

官方文档（interactive-mode，2026-09-25 访问）原文：

> "The recap generates in the background once **at least three minutes have passed since the last completed turn and the terminal is unfocused**, so it's ready when you switch back. Recaps only appear once the session has **at least three turns**, and **never twice in a row**. … The recap is **always skipped in non-interactive mode**."

二进制逆向出的控制器（v2.1.282，混淆类 `Qhe`）补充了精确机制：

- 基础延迟 `180000ms`（3 分钟），来自 statsig 远程配置 `tengu_sedge_lantern_config.delayMs`（下限 30000ms）——**阈值是可远程调参的**；
- 计时器额外约束：实际触发时刻 ≤ `min(配置延迟, prompt-cache TTL × 0.8)`——**趁缓存还热时生成**，超龄直接放弃；
- 触发时还必须处于 `focus === "blurred"` 且无 turn 进行中；
- focus 事件驱动：失焦→布防计时器；**重新聚焦→中止在途生成、清掉计时器**；
- 遥测阈值 `Qao = 300000`（5 分钟）：失焦满 5 分钟后回来并在下一条真实消息时上报 `tengu_return_to_session`（字段含 `blurDurationMs`、`hadRecap`、`scrolledBeforeSubmit`）。settings JSON schema 里对用户的描述写的是 "away for **5+ minutes**"（**[二进制]**），与文档的 3 分钟不一致——schema 描述疑似滞后或口径不同，以文档+代码常量（3 分钟生成）为准。

### 3.2 触发前的护栏清单（逐条来自二进制 `[awaySummary] skipped:` 日志串）**[二进制]**

非强制（自动触发）路径下，任一命中即跳过：

1. 会话不足 **3 条真实 user 消息**（短会话不出摘要）；
2. 距上一条 recap 又不足 **2 条真实 user 消息**（"never twice in a row" 的实际实现）；
3. transcript 末条已是 away_summary（不堆叠两条）；
4. agent 自己的 turn 末 StructuredOutput 摘要已存在（复用，不重复生成）；
5. **输入框有未发送草稿**（2.1.113 修的那个）；
6. 有后台 agents/workflows 未决、或 loop wakeup 待触发（工作没停，谈不上"离开"）；
7. 接近 rate limit（`status !== "allowed"`）；
8. 缓存年龄未知或已超 TTL 的 90%（"cache stale"——重发全量不划算）；
9. 已有生成在途；本 turn 失败已达 3 次（重试上限 `Jao=3`）。

`/recap` 手动命令走 `force` 语义，绕过 5-9，但 3 条消息门槛仍在；无内容时输出 "Nothing to recap yet — send a message first."。

### 3.3 展示位置与样式 **[官方 changelog + 二进制 + 用户观察]**

- **transcript 内追加一条 system 消息**（`subtype: "away_summary"`），渲染为**斜体单行**（2.1.251 changelog 直接点名 "the session recap line"）；
- 用户视角示例（wmedia.es 博客，2026-05-04）：`⏺ Recap: you were migrating the auth/ module to JWT. Edited 4 files; expiration tests still missing.`
- **前 3 次** recap 文本尾部自动追加 `" (disable recaps in /config)"`（二进制常量 `elo=3`）——可发现性 hack，之后就不再带；
- 不进 API transcript（生成时 `skipTranscript: true`），纯 UI 层展示；后台（`--bg`）会话通过 job 目录下的信号文件（500ms 轮询）触发强制生成；remote（CCR）路径在 **turn 结束时**生成并通过 `notifyMetadataChanged({recap})` 更新，若新 turn 已开始则丢弃。

### 3.4 内容结构与长度控制 **[二进制：提示词 + 常量双层]**

提示词层（§4 原文）：**1-2 句、40 词以内、无 markdown**；"Lead with the overall goal and current task, then the one next action"。

程序层：`f=400` 字符硬上限，超限经词边界截断函数处理并打 `capped` 遥测（对应 changelog 2.1.236 修复 "runaway session recaps"——**提示词约束会被模型违反，400 字符程序截断才是事故后的真正保险**）。

注意没有进度百分比、任务清单、小节结构——就是纯文本一两句话。

### 3.5 生成机制 **[二进制]**

- 复用会话已缓存的 `cacheSafeParams` fork 出一次**后台请求**，附加单条 user 消息（提示词原文）；
- `canUseTool` 恒 deny（"Away summary cannot use tools"）、`maxTurns: 1`；
- `skipCacheWrite: true`（不污染主会话缓存）、`skipTranscript: true`（不落盘）；
- 模型：官方未说明。逆向重建仓库称 Haiku **[逆向重建]**；但 changelog 2.1.181 表明 recap 与 conversation fork 同路径、模型跟会话当前模型走 **[官方]**——两者可并存（fork 时指定小模型但共享缓存前缀）。**此处存疑，不下结论**；
- 失败静默（abort/空 transcript/错误返回 null），不打扰用户。

### 3.6 提示词交叉验证（与同事调研的衔接）

同事文件引用 Piebald-AI 仓库 ccVersion 2.1.173 的 away summary 提示词；本次从 **2.1.282 官方二进制直接提取到逐字相同**的文本——两版本间（2026-06 → 2026-09）提示词**未改动**。另：JonusNattapong/ClaudeCode-Learning 仓库的 "1-3 short sentences" 版本系更早的重建近似，与实测原文不符，应以 40 词/1-2 句版本为准。

## 4. 提示词原文

### 4.1 Away summary 主提示词 **[二进制，v2.1.282 verbatim]**

（交叉验证：与 Piebald-AI 仓库 2.1.173 版本逐字一致；同事笔记已引，此处为独立信源确认）

```
The user stepped away and is coming back. Recap in under 40 words, 1-2 plain
sentences, no markdown. Lead with the overall goal and current task, then the
one next action. Skip root-cause narrative, fix internals, secondary to-dos,
and em-dash tangents.
```

要点：一句话场景设定（用户离开后回来）→ 硬性形式约束（40 词 / 1-2 句 / 无 markdown）→ 内容顺序（总目标 → 当前任务 → 唯一下一步）→ **枚举式负面清单**（根因叙事、修复内部细节、次要待办、破折号离题）。

### 4.2 配套端点摘要指令（agent turn 末摘要，可复用为 recap line）**[二进制，v2.1.282 verbatim]**

> "Your text output is what the user reads; they usually can't see your thinking or the raw tool results. Write it for a teammate who stepped away and is catching up, not for a log file: they don't know the codenames or shorthand you created along the way, and they didn't watch your process unfold. Before your first tool call, say in a sentence what you're about to do; while working, give brief updates when you find something load-bearing or change direction."

这是主 agent 的输出风格指令（`$r` 变量区分 turn 中/turn 末措辞），2.1.186 起后台会话用它充当 recap line。

### 4.3 其他

- `/recap` 命令定义（二进制）：`{name:"recap", description:"Generate a one-line session recap now", supportsNonInteractive:true}`，同样走 4.1 提示词 + force。
- compact 的三套提示词（full/partial/up-to）归同事切面，见 `2026-09-25-recap-prompt-design.md` §2.1。

## 5. 对 hpl-recap 的启示（"我们可以抄什么"）

1. **触发信号用"失焦"而不只是"空闲计时"**：`focus === blurred && 距上次完成 turn ≥3min` 才布防，重新聚焦即取消。hapilon TUI 拿得到终端 focus 事件（或退化为"无按键输入"），关键是**趁离开时预生成**，回来零延迟；且对齐缓存窗口（≤ cache TTL × 0.8）内生成，几乎零 token 成本。
2. **长度控制抄双层结构**：提示词写"40 词、1-2 句、无 markdown"（含枚举式负面清单），程序层留 **400 字符词边界截断**兜底 + capped 遥测。Claude Code 的教训（2.1.236 runaway）说明只靠提示词必翻车。
3. **护栏清单直接搬**：输入框有草稿跳过、后台任务未决跳过、不足 3 条用户消息不出、距上次摘要不足 2 条用户消息不出（防连刷）、生成中防重入、每 turn 失败重试 ≤3、接近限速跳过。hapilon 的 widget 版还可加：用户手动滚动过 transcript 就别再插（Claude Code 有 `markUserScrolled` 记录）。
4. **可发现性 hack**：前 3 次摘要尾部带 `"(disable in /config)"` 一类提示，之后消失——新功能自解释且不永久占宽度。
5. **遥测先行**：`tengu_return_to_session{blurDurationMs, hadRecap, scrolledBeforeSubmit}` 这个埋点设计值得抄——上线第一天就能回答"回来的人是否已有摘要在等"，比摘要质量本身更早验证功能价值。

## 6. 参考来源

| # | 来源 | URL | 访问日期 | 等级 |
|---|---|---|---|---|
| 1 | Claude Code CHANGELOG.md（GitHub raw，recap 相关 12 条） | https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | 2026-09-25 | [官方] |
| 2 | npm registry `@anthropic-ai/claude-code` 各版本发布时间 | https://registry.npmjs.org/@anthropic-ai/claude-code | 2026-09-25 | [官方] |
| 3 | 官方文档 Interactive mode → "Session recap" 节 | https://code.claude.com/docs/en/interactive-mode | 2026-09-25 | [官方] |
| 4 | `@anthropic-ai/claude-code-darwin-arm64@2.1.282` 原生二进制 strings 自行提取（提示词 verbatim、控制器逻辑、常量、遥测名、/recap 命令定义、settings schema 描述） | https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64 | 2026-09-25 | [二进制] |
| 5 | JonusNattapong/ClaudeCode-Learning `prompts-en/22_away_summary.md`（自述 reconstruction；与 4 不符处以 4 为准） | https://github.com/JonusNattapong/ClaudeCode-Learning/blob/main/prompts-en/22_away_summary.md | 2026-09-25 | [逆向重建] |
| 6 | Piebald-AI 解包仓库（经同事笔记交叉引用，ccVersion 2.1.173） | 见 `2026-09-25-recap-prompt-design.md` | 2026-09-25 | [二进制·同事] |
| 7 | wmedia.es Tip #060 "Session recap in Claude Code"（用户视角 + 渲染示例；其"v2.1.114"说法与 changelog 的 2.1.108 不符，以 changelog 为准） | https://wmedia.es/en/tips/claude-code-session-recap-resume-context | 2026-09-25 | [用户观察] |
| 8 | YouTube "Claude Code Session Recap — The Quiet Feature That Changes Everything" 等（仅标题级信息） | https://www.youtube.com/watch?v=qS7a_tIy-Yg | 2026-09-25 | [用户观察] |
| 9 | HN Algolia 检索 recap 生态工具（vibe-log / DevDay / ccstory / madebywelch-recap） | https://hn.algolia.com/api/v1/search?query=claude%20code%20recap | 2026-09-25 | [用户观察] |

**未获得/未验证**：recap 使用的模型确切 ID（Haiku 说法仅出自逆向重建仓库）；/status 输出格式的逐字段布局（本文未采证）；X/Twitter 上的用户反馈（无法访问）；对长度的公开抱怨帖（DDG/Reddit 直连受限，未检索到——长度问题的最硬证据是官方 2.1.236 修复条目本身）。
