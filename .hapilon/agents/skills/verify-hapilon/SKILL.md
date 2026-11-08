---
name: verify-hapilon
description: hapilon 功能改动（新功能、修 bug）的运行时验收：经 herdr-core 的 hc CLI 开真 devhapi 终端、派验收任务、读屏断言、留证据。hapilon 仓库功能改动或修复收尾、需要运行时或可视化验收时使用；改动只靠单测可断言、发版流程、其他仓库不用。
---

# 功能验证

## 目标

把「改动做完了吗」变成可复核的证据：真实用户路径上（真 devhapi、真派活）跑通改动，断言结果，证据落盘。自动化是常态，找人是例外。

## 何时不用

- 改动可被 `npm run test:unit` 完整断言，无运行时行为。
- 发版走 hapilon-release，提交走 snap，与本技能无关。
- 目标仓库不是 hapilon。

## Doctor（验收前逐条检查，任一不过即报不可验收）

1. `HC_TERMINAL_SOCKET` 已设，`hc ls --json` 退出 0——证明本会话在 herdr-core 环境。
2. `~/.local/bin/hapi` shim 存在且指向仓库 dist——证明验证终端跑的是本仓库构建。
3. `npm run build` 刚跑过，dist 与 src 同步。

不过就如实报告「不可自动验收 + 原因」，不静默降级。

## Launch

1. `npm run build`，改到哪个模块就先跑对应单测文件再跑全量。
2. `hc run --bg --name verify-<slug> --cwd <仓库> --label kind=verify hapi`——devhapi 用真实 `~/.hapilon-dev`，保真优先，不做隔离环境。
3. `hc get <t> --json` 等到 `"agent":"hapilon"` 且 `status` 为 idle——herdr-core 识别成 agent 才算就绪。

## Drive

先分线，按特征有没有可视化面决定：

- **线 A（无可视化面：CLI 行为、纯逻辑）**：不开终端，本会话直接 `node dist/cli.js …` 跑真实命令，输出即证据；要隔离环境用 `hc exec --env`。不要为线 A 开终端。
- **线 B（可视化面：TUI、扩展运行时）**：`hc send <t> "<验收任务>" --wait --timeout 300` 派活。过程卡点用 `hc get <t> --json` 看 status/turn，用 `hc read <t>` 看屏。终态以 `--wait` 的 turn 语义为准：send 开启的那个 turn 结束即收敛。

等待纪律：补充等待只用 `hc wait <t>`（agent 语义，等它停止 working）或 `hc wait <t> --output X`（程序语义，等输出出现）。不许 sleep 轮询。

## Evidence

每次验收在 `.hapilon/verify/<日期>-<slug>.md` 落一份证据：`hc read` 的关键读屏捕获、`hc get` 的状态快照、断言清单（每条写「预期 / 实测 / 结论」）。终端清理后证据仍可复查。

断言不过 → 回调用方 playbook 修复 → 重跑验收。重跑必须新开终端，不复用脏终端。

## Cleanup

- 默认什么都不做：`hc run --bg` 的终端默认挂在本会话名下，会话结束自动消亡。
- 需要留观给用户复核时，launch 时加 `--outlive-parent` 并 `hc label <t> review=pending`。
- 只清自己开的终端（`--name verify-` 前缀可辨识），`hc kill` 在跑的，`hc rm` 已结束的。用户的终端一个都不碰。

## 护栏

- agent 停在等审批、等提问（blocked）→ 停下问人，不代答。
- herdr 环境不满足 → 明确报告不可验收，不换路子硬跑。
- `hc send` 不拦输入：实测往终端连发按键时派送照样 237ms 秒达（终验口径：能输进输入框的都算输入，门不拦）。验证终端专属验收使用；发现用户正在该终端交互就停手换新终端。编辑区有残留字符会被并进派送消息（污染实证），send 前用 `hc keys <t> backspace …` 逐字清输入行（esc 清不了编辑区，实测）。
- `hc keys` 的 shift 修饰不生效：读屏实测输入 `a A 5 [ shift+2`，编辑区实为 `aa5[2`（A→a、shift+2→2）。可靠键入集 = 小写字母、数字、无 shift 标点（`[ ] ; ' , . / = - \`` 与 `space` 键名）+ 命名键（enter esc tab backspace、ctrl/alt/f 组合）；XKB 符号名（comma 等）与中文字符直接被拒。大写与 `!@#:` 类符号、中文一律走 `hc send`（粘贴语义，任意字符直达）。key 报错不得吞（曾因吞错导致演示字词粘连）。
- `hc` 命令语义以 `hc <子命令> --help` 为准，禁止省参数试探。
- 断言通道：`hc read` 文本读屏，或 `hc attach <t> --observe` 管道观察流（实测可断言编辑区渲染，注入整句含空格在流中命中）；像素级布局是盲区，升人工。
- 变更类命令（`hc run/kill/rm/send`）参数必须给全，不留默认值赌运气。

## 规则库

按改动碰到的面套用，一改多面多条并用；新特征不建文件，归到对应面。

**通道与就绪**
- 就绪信号是 `hc get` 的 `reported:true` + `status.state`；`hc run` 返回的 `agent` 字段是 argv 猜测，不作依据。
- 非交互命令（`hc exec`）不产生终端与 agent 条目；`hc ls` 会看到本会话自己的 pane，别当成验证对象。
- pi TUI 全屏渲染：`hc read --lines` 先加大行数再 grep。

**派发与收敛**
- `hc send --wait` 的收敛语义 = 本次 send 开启的 turn 结束；抓 working 中间态用「send 不带 --wait，紧跟 hc get」。
- 送达文本带来源包裹 `<hc from="<终端>">…</hc>`，断言时区分包裹与被验方输出。
- 等待只用 `hc wait`（agent 语义）或 `hc wait --output X`（输出语义），不 sleep 轮询。

**渲染断言**
- `hc read` 是节拍采样：瞬时 UI（补全菜单、弹层）可能落在两拍之间——连续多拍确认，仍看不到升人工。
- `hc attach <t> --observe` 是管道观察流，可断言屏面渲染（整句含空格实测命中）；流混有 TUI 边框与转义，去 ESC 后 grep，且待验内容必须是真实渲染形态（shift 退化后 grep 原字符不到不是流的问题）。
- 像素级布局（位置、颜色、边框）升人工。

**特征要点**
- 状态行栈：连续两条提示须同时可见（追加成栈）；验收失败先查启动警告（补丁锚点失配只告警）。
- slash 中段补全：行中键入 `/` 唤出补全菜单；Esc 关闭后输入行字符无丢失。
- 上下文压缩：`/acp-status` 断言水位与压缩块；`/compact` 不应出现在命令表。
- team 编排：已知缺口——hpl-orchestra 指向 TUI 版 herdr，herdr-app 环境派发不可用；验收命中即记证据，修复另开任务。

**盲区登记**
- 毫秒级状态切换时序；压缩摘要质量（属模型行为评估）；多 role tier 回落（需多 role team）；大上下文自动折叠阈值（需真实长会话）。
