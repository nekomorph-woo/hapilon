# hpl-build-ai-flow 设计方案（待审）

把「AI 复杂任务工作流」（docs/ai-*.md 三份，GPT 协商产出）收编为 hapilon 内置扩展 `hpl-build-ai-flow`，阶段数在 GPT 九阶段基础上补入 S5 视觉定调，共十阶段（S0–S9）。用户对难任务自己调用 `/build-ai-flow` 走流程；简单任务不用，无轻/重路径之分。不建流程 skill，流程方法论全部内聚在扩展里；手艺类技能 artifact-assist（苦手视觉陪跑，§10）另行立项，同批交付。

---

## 1. 形态与文件布局

```
src/extensions/hpl-build-ai-flow/
  index.ts       命令注册、参数解析
  stages.ts      十阶段定义（单一事实源：核心问题/自主权/清单/产物/Gate）
  machine.ts     state.json 读写、状态迁移、Gate 机械评估（Effect）
  prompts.ts     派发 prompt 拼装（按任务状态注入上下文）
  completions.ts 插件专用补全：前缀分派 + 状态感知候选 + fuzzyFilter 匹配
  render.ts      status 的 ASCII 状态轨与详情渲染
  decision-audit.ts 决策冲突审查：档位模型一次性调用（模型解析走 hpl-model-tiers 正统件）
  guard.ts       阶段跳跃防护：tool_call 监听，S0–S5 越阶段写文件时提示用户（不拦）
```

构建后 `dist/extensions/hpl-build-ai-flow/index.js` 被 loader 目录扫描自动发现，无需注册表。dist 入库随提交。

工作区（每个任务一份，跟项目走，`.hapilon/` 已 gitignore）：

```
.hapilon/ai-flow/
  active.json                 活跃任务指针 {"slug": "..."}
  <slug>/
    state.json                状态机文件（唯一机器态，其余全是给人读的 md）
    dump.md                   S0 材料+困惑
    discovery.md              S1 事实/来源/未知/冲突
    frame.md                  S2 一句话定位（填空句）
    definitions.md            S3 概念口径
    decision-log.md           S3 起追加式：D-001｜已拍板｜…（后续阶段继续追加）
    design.md                 S4 信息架构/wireframe
    visual-direction.md       S5 视觉方向候选与拍板（2–3 个已渲染小样 → 拍板一个）
    prototype.md              S6 一肥一瘦记录（指向实际原型文件）
    self-review.md            S7 反向验收（六轴自评 + 误导检查）
    scale.md                  S8 全量执行记录
    spec.md                   S9 最终口径（含锁定的视觉身份）
    start-prompt.md           S9 重放入口
```

GPT 文档里"推荐产物"（source-map、fact-unknowns、metrics-spec 等多个散名）收敛为**每阶段一个主文件**——Gate 检查需要确定的文件名，散名建议无法机械化。内容多的就在主文件里分节。

## 2. 与 GPT 三份文档的对应关系

| GPT 侧 | 扩展侧 |
|---|---|
| 一页式工作流：九阶段图 + 记忆口诀 | `stages.ts` 的 StageDef 表（数据化）；`/build-ai-flow status` 渲染进度 |
| 检查清单：每阶段核心问题 | `coreQuestion` 字段，派发 prompt 头部 |
| 检查清单：每阶段检查项 | `checklist` 字段，注入派发 prompt |
| 检查清单：每阶段"最低可用 Prompt" | 不再要用户手打——`prompts.ts` 按当前状态拼装派发，上下文（目标/已有产物/上一阶段结论）自动带入 |
| 检查清单：Gate 条目 | 拆两层：机械项进 `machine.ts` 可执行检查；语义项留 `gateNote` 给人 |
| Fact / Decision / Unknown / Proposal 四分类 | Define 阶段 prompt 强制要求；decision-log 固定条目格式（见 §6） |
| 自主权原则（探索高提问低决策…） | `autonomy` 字段按阶段注入派发 prompt |
| 脑子空白启动器：模式一（完全不知道怎么开始） | S0 Dump 的派发模板（话术内容并入） |
| 启动器：模式二~五（有模糊目标/讨论一轮/不会写 Spec/不会写 Start Prompt） | 对应阶段（2/4/3/8）的派发 prompt 替代——命令派发即话术，用户不再需要背哪句话 |
| 6 句万能话术 | bare 命令的引导提示 + 各阶段 prompt 内化 |
| Freeze：spec + decision-log + start-prompt | S9 产物硬约定，Gate 机械检查两个文件存在 |
| 三循环（Sensemaking / Productization / Institutionalization） | 不单独建模——阶段序号即分组（0–3 / 4–6 / 7–9），status 里分组显示 |
| （GPT 流程缺位）视觉/审美定调 | 新增 S5 视觉定调阶段 + artifact-assist 技能（§10），不来自 GPT 文档，属补缺 |
| （GPT 流程缺位）苦手用户的视觉拍板能力 | artifact-assist 技能的六条苦→行为规则（§10） |

## 3. 相对 GPT 流程的改动

1. **线性传送带 → 带记录的回环。** GPT 流程隐含 0→8 一路向下；真实工作会回炉（Frame 阶段发现口径冲突要退回 Define，Inspect 发现设计错误要退回 Design）。状态机显式支持 regress / skip / reopen，原因必填并写入 history——回炉不是失败，是被记录的正式迁移。
2. **Gate 从自觉 → 双层。** GPT 的 Gate 是给人看的清单，靠模型自觉。现在机械项（文件在不在、填空满没满）由 `/next` 强制检查；语义质量仍归人（本来就是 Gate Keeper 分工）。
3. **自主权从原则句 → 代码注入。** "实现阶段高执行权低需求修改权"这类条款写进每阶段派发 prompt，模型躲不掉。
4. **认知持久化常态落盘。** GPT 只在任务收口（Freeze）时做认知持久化；现在每次派发都从 state.json + 产物重建 prompt 上下文，不依赖会话记忆。流程按单会话使用设计；意外中断后文件仍在，`goto` 可手工续走。
5. **decision-log 定格式。** GPT 只说"维护 decision-log"。定死条目格式 `D-001｜已拍板｜覆盖率的分母只算本版本计划内用例｜2026-09-30`，Define 创建、后续阶段追加（不允许阶段外口头拍板——对应 GPT"不偷偷改 Spec"），Freeze 的 spec 引用 D 编号，口径变更可追溯。
6. **显式停止条件。** 每个派发 prompt 尾部带"写完本阶段产物即停，等 /build-ai-flow next"。治掉 GPT 流程最常见的执行失败：模型一口气跑完九阶段、Gate 全跳过。
7. **产物名从建议 → 硬约定。** 机械 Gate 的前提。
8. **补 GPT 流程的审美缺位。** GPT 的 Design 只管信息结构，不管视觉方向；而看板/报告类交付物的视觉拍板对苦手用户最难。新增 S5 视觉定调（阶段内拍板）+ artifact-assist 技能（陪跑拍板过程）；从 hallmark 借三招：参考物提 DNA、排序返工清单、发版前自评（§10）。

## 4. 命令面与补全

| 命令 | 行为 |
|---|---|
| `/build-ai-flow` | 无活跃任务 → 引导（怎么 start + 首句话术提示）；有 → 同 status |
| `/build-ai-flow start <slug> [目标一句话]` | slug 不存在 → 新建（S0 派发）；已存在 → 报错提示换名（流程按单会话内完成设计，不做跨会话续走） |
| `/build-ai-flow next` | 机械 Gate 检查当前阶段 → 过则推进并派发下一阶段；不过则列出缺口，confirm 后可强推（记 force + 缺口） |
| `/build-ai-flow status` | 渲染 ASCII 状态机 + 当前状态 + Gate 实时检查 + 建议下一步（见下方渲染示例） |
| `/build-ai-flow list` | 全部 flow：slug、阶段、active/frozen、更新时间 |
| `/build-ai-flow goto <0-9> [原因]` | 跳前/回退/重开。**原因必填**，写入 history |
| `/build-ai-flow audit` | 决策冲突审查：档位模型一次性调用，查 decision-log.md 内部矛盾（见 §7） |

补全不用通用 `argumentCompletions`，插件自写 `completions.ts`：前缀分派 + 状态感知候选 + `fuzzyFilter` 匹配（pi-tui 公开工具，仅匹配复用）。候选集随活跃 flow 的状态变化：

- 空 query → 子命令候选（`start `、`next`、`status`、`list`、`goto `、`audit`）；`next` 的描述动态带当前 Gate 状态（如"推进（当前 gate 已过）"）
- `start ` 前缀 → 磁盘上已有 slug（来自 `.hapilon/ai-flow/*`），描述带各自阶段与状态
- `goto ` 前缀 → 0..9 候选，label/description 按当前 stage 标注「回退 / 前跳 / 当前」，searchText 带阶段中文核心问题；value 为 `goto <n> `（选中后整段替换，多词用法按 pi 约定写全）
- `next`/`status`/`list` → 无参数，无候选

### status 的 ASCII 渲染（示意）

```
✓dump ✓explore ●frame ○define ○design ○visual ○proto ○inspect ○scale ○freeze   2/9

任务：月度质量报告（monthly-quality-report）｜状态 active
目标：给领导看的应用测试月报
当前阶段：frame｜定义问题 —— 谁要用这个东西？他看完要做什么判断？
本阶段产物：frame.md ✗
Gate 机械检查：未过 —— frame.md 缺失
历史：start → advance(0→1)
建议下一步：把定位句写进 frame.md（"这是给___看，用来判断___的，不是用来___的"），
           完成后执行 /build-ai-flow next
```

一行十段的状态轨：`✓` 已过（force 强推标 `!`）、`●` 当前、`○` 未到；frozen 时全 `✓` 且尾部标 `[frozen]`。图下附当前状态、Gate 实时检查结果、历史尾部、建议下一步（由状态推出：无活跃 → 引导 start；Gate 未过 → 完成产物后 next；Gate 已过 → 可直接 next；frozen → 重放/重开指引）。

## 5. 状态机设计

### 状态空间

- 阶段状态：`stage ∈ 0..9`（S0 Dump … S9 Freeze）
- 生命周期：`status ∈ active | frozen`（S9 Gate 通过 → frozen，终态可重开）

### state.json

```json
{
  "version": 1,
  "slug": "monthly-quality-report",
  "name": "月度质量报告",
  "goal": "给领导看的应用测试月报",
  "status": "active",
  "stage": 2,
  "createdAt": "2026-09-30T08:00:00.000Z",
  "updatedAt": "2026-09-30T09:12:00.000Z",
  "history": [
    { "kind": "start",   "to": 0, "at": "…" },
    { "kind": "advance", "from": 0, "to": 1, "at": "…" },
    { "kind": "regress", "from": 4, "to": 3, "reason": "口径冲突，回炉 Define", "at": "…" }
  ]
}
```

选 JSON 不选 md：每次派发、每次 Gate 检查都要机器读写，JSON 无解析歧义、可原子写；人看的版本由 `status` 渲染，工作区里其余文件全是 md。history 是追加数组，完整保留全部迁移。

### 迁移表

跨会话能力：机器状态与认知产物全部落盘（state.json + 各阶段 md + decision-log + start-prompt），不依赖会话历史——连续会话体验最佳，意外中断或换会话后可从磁盘 flow 状态继续（goto 带原因，或 hapi 会话 resume 恢复对话上下文）。不设 start-同名-resume 迁移（避免同名歧义），续走一律 goto。

| 迁移 | 触发 | 守卫 | 动作 |
|---|---|---|---|
| start | `start <slug>` 且不存在 | — | 建目录、state(stage=0, status=active)、写 active.json、派发 S0 |
| advance | `next`，gate 通过，stage<9 | gate 机器检查通过 | stage+1、派发 |
| force | `next`，gate 不过 | 用户 confirm | stage+1、history 记 force + 缺口清单 |
| skip | `goto N`，N > stage | reason 必填 | stage=N |
| regress | `goto N`，N < stage | reason 必填 | stage=N（产物不删，覆盖式重写） |
| freeze | `next`，stage=9，gate 通过 | spec.md + start-prompt.md 存在 | **两阶段提交**：advanceFlowEffect 返回 ready-to-freeze（不落盘）→ 审查与用户确认 → freezeFlowEffect 才 append freeze history + status=frozen 落盘；用户拒绝则保持 active/S9 零残留。**S9 强推缺口统一进 Gate Debt，不再记在 freeze 条目里** |
| debt-resolve | `debt resolve <G-00x> <说明>` | 说明必填 | 关闭欠账（resolvedAt+resolution），写 history；不自动猜测关闭 |
| reopen | frozen 态 `goto N` | reason 必填 | status=active、stage=N |

守卫失败的处理：机械缺口 notify 列出；force 必须 confirm——**人是最终闸门，扩展是闸门机械**。

### 迁移图

```
           ┌───────────────────────────────────────────────────┐
           │            regress（带原因，任意回退）               │
           ▼                                                   │
 S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 ──freeze──► frozen
 dump explore frame define design visual proto inspect scale    │
  ▲    ▲________________skip（带原因，向前跳）____________▲      │
  └────────────────── reopen（frozen 态带原因重开）◄──────────────┘
```

### Gate 机械检查（machine.ts）

| 阶段 | 检查 |
|---|---|
| S0–S1 | 主产物存在且 ≥30 字符（防空文件） |
| S2 | frame.md 存在、含"用来判断"、不含 `___` 残留 |
| S3 | definitions.md 存在；decision-log.md 存在且 ≥1 条 `D-` 开头条目 |
| S4–S8 | 对应主产物存在且 ≥30 字符（design / visual-direction / prototype / self-review / scale） |
| S9 | spec.md 与 start-prompt.md 都存在 |

## 6. 派发 prompt 拼装（prompts.ts）

先分清职责：ai-* 文档的方法论内容（核心问题/清单/自主权/停止条件）落在 stages.ts 的阶段定义里，prompts.ts 只负责骨架与状态注入——拼装时逐项从 stages.ts 读，不存副本。

每阶段模板 + 任务状态注入，示意（S2 Frame）：

```
【build-ai-flow：月度质量报告】阶段 2/8 frame｜定义问题
任务目标：给领导看的应用测试月报

自主权：可提出 2~3 个问题定义候选；不可替用户拍板最终定位。

先读工作区已有产物：dump.md、discovery.md

核心问题：谁要用这个东西？他看完要做什么判断？

本阶段清单：
- 主要用户是谁，是什么角色、不是什么角色
- 用户最重要的 3~5 个判断
- 什么信息是噪音，不该进入主线
- 做错最可能怎样误导用户

本阶段产物：frame.md，必须含一句填满的话：
"这是给___看，用来判断___的，不是用来___的"

停止条件：写完 frame.md 即停。不写代码，不做成品，不进入下一阶段。
完成后由用户执行 /build-ai-flow next 做 Gate 检查
（机械项：填空句完整；语义项：这个定位是否真的是领导要做的判断）。
```

要点：

- 头部注入 name/goal/阶段序号；自主权、清单、产物、停止条件全部来自 `stages.ts`，逐阶段不同（S6 Prototype 的停止条件是"只做一肥一瘦两个样例"；S8 是"只扩数据不改结构，改规则先出 Proposal 追加 decision-log"；S9 是"视觉身份锁进 spec，重放不换皮"）
- 阶段附加提示引用现有技能：S1 → research / understand-this-codebase；S4 → design-before-code + artifact-diagramming；S5 → artifact-assist（主）+ prototype（UI 分支）+ show-me；S6 → prototype；S7 → verify + artifact-assist（问题清单式迭代）（派发 prompt 里一句话提及，模型自行加载）
- force 推进时，下一阶段派发 prompt 附带"上一阶段 Gate 缺口：…，本阶段优先补上"

## 7. 决策冲突审查（decision-audit.ts）

用途：decision-log.md 积到几十条后，人眼看不出新旧拍板互相矛盾；换一个模型、独立上下文读一遍，专找冲突。

**机制：**

- 模型解析全部用 hpl-model-tiers 的正统件（与 hpl-orchestra 同构）：`parseTierReference`（解析 `tier:<opus|sonnet|haiku>[<index>]` 指代）+ `readResolvedTiersEffect`（读 model-tiers-resolved.json 档位表）+ `matchesModelPattern`（glob/具体 id 兜底）；固定 `tier:sonnet`，不做覆盖配置
- 调用走 `ctx.modelRegistry.complete(model, request, options)`（与 gateAuto 判定同一条路）
- 输入：decision-log.md 全文 + 任务目标；输出经 Schema 校验：`{ conflicts: [{ ids: ["D-001","D-004"], summary, suggestion }], ok }`——模型输出属不可信边界，解析失败按"审查失败"处理，不编造结果

不引用 hpl-safety-gate/auto-judge 的 `resolveAutoModel`：它内部把 `tier:` 指代正则重写了一遍（与 model-tiers 的 `parseTierReference` 重复），本插件不走它，不加重那份重复。

**时机：**

1. 手动：`/build-ai-flow audit` 随时（decision-log.md 存在即可）
2. 自动：`/build-ai-flow next` 通过 S9 Gate、freeze 执行前 confirm——"冻结前先跑一次决策冲突审查？"，可跳过

**失败与冲突的处理：** 超时/模型不可用/输出不合法 → 提示审查失败，不阻塞 freeze（审查是建议层，人是最终闸门）；查出冲突 → 列出冲突清单，freeze 前 confirm"仍有冲突，仍要冻结？"。审查结果追加写入工作区 `decision-audit.md`（带日期），供 Freeze 引用。

注：若解析出的模型恰与当前会话模型相同，价值仍在"独立上下文的一锤子调用"——没有会话历史偏见，专读 decision-log。

## 8. 阶段跳跃防护（guard.ts）

治的场景：你开着 flow，当前在 S2（定义问题），模型聊着聊着"手痒"，直接开始建交付物文件（比如 dashboard.html）——阶段被绕过，Gate 全被绕过。这是 GPT 流程最常见的翻车方式。

**机制：** pi 给每个扩展一个"工具调用前"事件钩子 `pi.on("tool_call")`（hpl-safety-gate 拦危险 bash 用的同一个钩子）——模型每次要写/改文件之前，事件先送到扩展手里。

**行为（提示不拦截）：** 有活跃 flow 且 stage ∈ 0–5（这些阶段的产物只有工作区 md）时，模型 write/edit 的目标在 `.hapilon/` 之外 → 不拦执行，弹提示给用户：

```
[build-ai-flow] 模型正在 S2 frame（定义问题）阶段写流程外文件 src/x.html。
若确要提前实现：/build-ai-flow goto 6 带原因；否则让它先完成 frame.md。
```

同一阶段只提示第一次（避免每次写文件都刷屏）；怎么处置由你决定。

**边界：**

- 只盯 S0–S5（思考与定义阶段，产物只有工作区 md）；S6 起要写原型与交付物，不提示
- 只盯 write/edit 两类工具；bash 重定向绕得过的写不追（诚实边界，不玩猫鼠）
- 无活跃 flow 时完全不生效——防护只在自己主动开的流程里起作用
- 提示发给用户（notify），不改模型行为；误报（与本 flow 无关的旁支工作）看到提示忽略即可

## 9. stages.ts 十阶段全表（数据即方法论）

| # | slug | 中文 | 核心问题 | 产物 | Gate 语义项（人卡） |
|---|---|---|---|---|---|
| 0 | dump | 倒出来 | 我现在到底有什么？哪怕很乱 | dump.md | AI 没直接跳成品；已知/未知/冲突成图 |
| 1 | explore | 探索事实 | 客观世界现在是什么样？ | discovery.md | 事实与建议分开；源可信度标了 |
| 2 | frame | 定义问题 | 谁要用它？看完做什么判断？ | frame.md | 定位句是否真是用户要的判断 |
| 3 | define | 钉死口径 | 这些词到底是什么意思？ | definitions.md + decision-log.md | 同一词只剩一种含义；Unknown 没被偷渡成结论 |
| 4 | design | 设计信息 | 用户按什么顺序看到什么？ | design.md | 顺着结构能完成主要判断；实现结构没绑架业务结构 |
| 5 | visual | 视觉定调 | 它该长什么气质？视觉在替哪个判断说话？ | visual-direction.md（2–3 个已渲染方向候选→拍板一个） | 色彩语义承载的是 Frame 定的判断（红=风险）；装饰没冒充信息 |
| 6 | prototype | 极端原型 | 最肥最瘦两个案例都成立吗？ | prototype.md | 缺口可见；没为单个样例破坏结构 |
| 7 | inspect | 反向验收 | 它最可能怎样误导我？ | self-review.md | 0 没被隐藏；代理指标没写成真实结果；第一眼重点被样式强化而非淹没 |
| 8 | scale | 扩全量 | 是复制模式还是重新发明？ | scale.md | 没为收全数据偷偷改口径 |
| 9 | freeze | 固化经验 | 换会话还要从头解释吗？ | spec.md + start-prompt.md | 新模型只读文件能恢复；视觉身份已锁定 |

（checklist 明细、自主权条款全文在实现时逐阶段写入 stages.ts，内容以 docs/ai-complex-task-checklist.md 为底本精简；S5 的拍板过程全程走 artifact-assist 技能。）

## 10. artifact-assist 技能（苦手视觉陪跑，同批交付）

**定位：** 给前端/UI/UX 苦手的交付物作者做视觉陪跑。设计的第一性输入是用户自己的六条苦，不是 hallmark 移植——hallmark 只在恰好回答某条苦的地方借一招。

**苦 → 行为规则（SKILL.md 的骨架，每条规则可溯源）：**

| # | 苦 | 应对 | 来源 |
|---|---|---|---|
| 1 | 开放式审美问题答不上来 | 禁开放式提问：视觉决定一律先做成 2–3 个真渲染小样让用户指认；只许问事实性问题（给谁看/投屏还是打印/深浅主题） | 自设 |
| 2 | 没词汇，"感觉不对但说不上来" | 翻译机制：模糊词当场译成具体改动并复述；仍说不清 → 争议区域两版二选一，三轮收敛 | 自设 |
| 3 | 心里没有校准器，看不出 AI 味 | 给校准物：同内容好/坏对照点破差异；用户指喜欢的参考物（截图/链接）→ 提取 DNA 应用到交付物 | 提取 DNA 借 hallmark study，其余自设 |
| 4 | 不懂前端机制，出问题自己救不了 | 只收意图级反馈（"这块该更大"），技能译成代码；产物单文件自包含 HTML，使用与交付零前端知识 | artifact 已有，技能显式承诺 |
| 5 | 决策疲劳 + 怕在领导面前翻车 | 决策瘦身：只拍 2–3 个方向级决定，细节全交 artifact 设计宪法兜底；模型出货前六轴自评、低于阈值自己返工 | 自评借 hallmark pre-emit critique，排序清单借 audit 之形 |
| 6 | "artifacts 应该有可用性但我不太会用" | 携带使用路径：小图对方向（show-me）→ 方向小样指认 → artifact 出正式件 → 问题清单式迭代，每步告知现在在哪、下一步按什么 | 自设 |

**hallmark 只借三招**（全部对着苦 3 和苦 5）：参考物提 DNA（study 动词）、排序返工清单（audit 之形）、发版前自评（pre-emit critique）。主题库、宏结构轮换、57 门全套检查**不进**——那是 landing page 的机器，求变本性与月报求稳相反。**hallmark 不安装**：适用部分（反模式清单按数据页裁剪、DNA 提取思想）已并入 artifact-assist，无运行时依赖。

**分工规则（写进 SKILL.md，防打架）：**

- artifact：报告/看板/数据页/长文交付物（主力，自带设计宪法）
- artifact-assist：交互协议层，不自己产出页面——指挥 artifact / prototype / show-me 产出，组织用户拍板

**落点：** `resources/skills/artifact-assist/SKILL.md`（内置随版本分发），SKILL.md 全文实现时产出供审；另内置主题目录 `references/themes.md`（十二个可说出口的视觉方向，报名字即开工——治苦 1 的词汇缺口）。hallmark 与 taste-skill 均不安装（taste-skill 自声明不管看板/数据表；hallmark 适用部分已并入）。

## 11. 实现与测试计划

- `machine.ts` 用 Effect：`Data.TaggedError` 定义 `FlowStateError`，fs 操作 `Effect.try`，命令边界 `Effect.runSync`
- 顺带一处小改动（safety-gate 容器化，不改行为）：hpl-safety-gate/auto-judge.ts 的 `resolveAutoModel` 去掉 `export` 改为模块私有，加设计注释。已查证全仓库无外部引用（仅 auto-judge.ts 内部调用，测试也不直接引），零风险。注释拟文：

  ```ts
  // tier 指代解析与 hpl-model-tiers 的 parseTierReference 重复，有意保留：
  // 判定层自含解析不做跨扩展依赖；新代码解析 tier 指代请直接用 parseTierReference。
  ```
- 单测（node:test，照 hpl-simplify-command.test.ts 的 mock pi 模式）：
  - stages 表完整性（0..9 连续、产物非空、自主权非空）
  - Gate 评估（tmpdir：空文件、填空句、D- 条目、visual-direction 各分支）
  - 状态机：start/advance/force/regress/freeze/reopen + reason 守卫；start 已存在 slug 报错
  - prompt 拼装：上下文注入、force 缺口附注
  - 命令 handler：注册、补全分派（含状态感知候选）、next 的 confirm 分支
  - status 渲染：状态轨标记（✓/!/●/○/frozen）、建议下一步推导各分支
  - decision-audit：mock complete 的三分支（无冲突 / 查出冲突 / 超时或坏输出回落不阻塞）；tier 解析走 parseTierReference
  - guard：S0–S5 提示工作区外写、S6 不提示、无活跃 flow 不提示、同阶段只提示一次
- 交付物：`resources/skills/artifact-assist/SKILL.md`（全文先审后落盘）
- extension-load-smoke 已有，dist 构建后自动覆盖
- `npm run build` 后 dist 同步入库

## 12. 待拍板

已定：状态文件 state.json + status ASCII 渲染；插件专用 completions.ts；单会话设计无跨会话迁移；阶段中文名沿用文档（新增 S5 视觉定调，顺移为十阶段）；decision-log 条目格式 `D-001｜已拍板｜内容｜日期`；goto 原因走命令参数；不做重放子命令；决策冲突审查在 freeze 前 confirm 可跳过、固定 tier:sonnet 无覆盖配置；guard 提示不拦截、同阶段首次去重；safety-gate 的 `resolveAutoModel` 保留自有实现，改私有 + 注释（见 §11），行为不变；artifact-assist 技能立项（六条苦为纲，hallmark 适用部分裁剪并入，§10）；hallmark 与 taste-skill 均不安装。

全部拍板完毕，无剩余问题。

## 13. 第二轮 Review 修订（2026-09-30）

1. **Gate Debt 持久化**：force（含 S9 强推）创建 open debt（G-00x，stage+gaps+createdAt），后续所有阶段 prompt 持续注入，status 显示未关闭清单；仅 `/build-ai-flow debt resolve <id> <说明>` 显式关闭（写 debt-resolve history）；freeze 前存在 open debt 仅显式 warning，不自动禁止。修复了 gaps 只注入下一阶段一次的降级问题。
2. **控制面原子写**：state.json / active.json 改为同目录 temp→rename（writeFileAtomic），失败清理 temp，原文件不被半截 JSON 替换；md 产物不强制。
3. **decision-log lifecycle**：条目状态 active/superseded/revoked + supersedes 指向 + 追加事件行；旧格式「已拍板」视为 active（兼容）。audit 只查 active 集矛盾，lifecycle 异常（引用不存在/重复取代/未知状态）进 malformed 显式报告。
4. **上下文分层**：stages.ts 新增 CONTEXT（authoritative/relevant/historical），prompt 按“必读/需要时参考/历史溯源”分层，不再平铺全部已有产物。
5. **goto 同阶段**记 revisit（不再误记 advance）。
6. **parseState fail closed**：status/stage/version/history 非法即报错（带修复指引）；name/goal 等展示字段仍宽容。
7. **Gate 结构标记**：GATE_MARKERS 按阶段声明必需关键词（如 prototype.md 需含肥/瘦），只判“明显步骤有没有做”，不判内容好坏；S0 刻意保持只查存在性+长度。
8. **guard 文案中性化**：不再预设 goto 6，改为边界提醒（调查辅助可继续/提前阶段用 goto 记录/否则先完成产物）。
9. **S9 可选 retrospective.md**：方法经验沉淀，不进 Gate、不混入 spec。
10. **跨会话表述修正**：能力本就在磁盘，文档与 start 报错文案改为真实表述（见 §5 迁移表）。

## 14. Prompt 专项修订（2026-09-30 第三轮）

只动 stages.ts / decision-audit.ts 的文案与一处不变量，不动状态机与数据结构：

1. **S0 外化不调查**：autonomy 改「高整理权低调查权」，禁止为补全 dump 主动大规模调查；待调查问题记「待探索」留给 S1；不把模型背景知识补成用户事实。
2. **S2 强制人选拍板**：多候选时必须展示让用户指认/组合/纠正；确认前 frame.md 只放候选与用户反应，定位句只能在确认后写入（与机械 Gate 天然咬合：没有定位句 Gate 不过）。
3. **S5 比较协议**：候选必须同信息结构下沿少数关键视觉变量拉开明显差异，每个候选写明强化什么判断/牺牲什么/关键差异；非专业反馈由模型翻译成视觉规则。
4. **S7 去数字自评**：六轴改为 Pass/Concern/Fail/Not verified 附证据，删除 1~5 分与「<3 返工」伪精确规则；能否进 Scale 仍由用户 Gate 决定。
5. **S8 升级规则**：新情况无法由现有定义解释/需新增核心状态/需改层级或视觉语义/会误导判断 → 停止扩量记 Unknown/Proposal，建议回退点，不自行 goto；普通数据差异继续。
6. **P-07 audit 不变量**：`ok` 在代码层完全由 `conflicts.length === 0` 推导（不信任模型自查一致）；prompt 补一句说明。
7. **P-06/P-08/P-09 刻意不动**：不建 prompt 压缩器/动态拼装；上下文分层与统一骨架维持现状；后续真实使用时观察四项过载信号再议。

## 15. 上游前提检查与 stale 重确认（2026-09-30 第四轮）

**Part A｜上游前提检查**：S4–S9 的派发 prompt 注入一段公共规则——发现无法可靠继续的原因来自已确认上游结论时：不自行修上游、不硬做；指出失效前提+新证据+影响+建议回退阶段，停下等用户 goto。AI 有回退建议权，没有回退执行权。S0–S3 不注入。

**Part B｜stale 重确认**（修实锘的 correctness 问题：regress 后旧产物直接过机械 Gate，连按 next 可空走回 S7）：

- 状态模型：`state.stale = {from, at} | null`——regress 或 frozen reopen 到 N 时，N+1 起的阶段产物进入待重确认；线性传播，无 DAG
- Gate 新增检查：stage ≥ stale.from 时，产物 mtime 必须晚于回退时刻（重新落盘 = 重新确认，确认仍有效也重存）；decision-log 豁免（追加式持久认知，不整体失效）
- 通过某阶段 Gate（含 force）后 stale.from 前移到 passedStage+1，逐阶段清洗；越末尾清除
- prompt：stale 阶段注入「旧版本仅供历史参考，需基于新上游重新验证/重写后保存」；decision-log 提示按需追加不重写
- 与 Gate Debt 分离：debt 是「当时知道没过、人决定继续」；stale 是「以前可能对，上游变了，当前有效性待确认」；status 分行展示
- force 越 stale：允许，缺口进 Gate Debt，stale 随前移
- revisit/skip 不设 stale；已知限制：revisit 后手改上游产物不会自动 stale 下游（无内容 diff 追踪）

## 16. Capability Integration（2026-02-05：artifact-assist 与 golden-case 纳入主线）

### 16.1 定位：Stage 与 Capability 的分工

Stage 回答「现在在解决什么认知问题」，拥有 stage index 与状态机推进；Capability 回答「这个阶段是否需要额外专业方法帮助」，不占 index、不建第二状态机、不改 S0–S9 顺序、可跨阶段发挥作用、可有自己的 artifact 与生命周期。启用由用户决定（`/build-ai-flow cap <id> <enable|decline> [说明]`），AI 只有推荐权。Flow 负责：何时建议、调用结果如何成为当前 Stage 的上下文；技能自身的机制（golden-case 的六审三回执、artifact-assist 的七步推理）永远留在技能内，Flow 不复刻。

第一批只有两个真实能力，抽象止于此，不建通用 plugin framework：

| 能力 | 形态 | 激活 | 持久状态 |
|---|---|---|---|
| golden-case | 跨阶段生命周期能力（业务真值 + 独立验证） | S3 主工作点（真值定义）、S6/S7 主工作点（观察与验证），S1/S4/S5/S8/S9 辅助 | `state.capabilities`（唯一需要持久化的） |
| artifact-assist | 阶段局部调用（skills 列表承载） | S5 主（stages.ts 既有）、S4/S6/S7 辅助（S4 本轮补入 skills） | 无——刻意不对称，不强行统一 |

### 16.2 golden-case 生命周期 ↔ S0–S9 映射

golden-case 自身是五阶段工作流（Draft → View/review → Freeze 封金 → Adapter → Report/audit），本设计按真实现状校正用户原始 spec 的措辞（"Draft→Review→Freeze" 实为 Draft→View/review→Freeze，封金由 Draft+View 回执把门）。逐阶段：

- **S0 Dump**：不主动启用。用户已有的业务 case、验收样例、已知正确输入输出、业务规则文档、事故案例，作为原始材料记入 dump.md 即可。
- **S1 Explore**（已启用时注入指引）：可读真实 codebase、API、domain model、persistence、observation surface、现有 tests，理解 case 所处的系统环境。边界：了解 implementation facts ≠ 从 implementation 输出推导业务真值。
- **S2 Frame**：推荐决策点。prompt 注入推荐条款与信号表（明确业务结果；正确性无法仅靠编译/单测判断；存在金额/状态/权限/流程/库存/持久化等业务真值；实现可能内部自洽但业务错误；用户能确认「什么叫对」；重构需保护既有行为）。模型命中多数信号 → 输出推荐（为什么适合/增加什么工作/保护什么风险）+ 决策命令，等用户 cap enable|decline。**机械防骚扰**：未决定 → 仅 S2/S3 出现推荐条款；已拒绝 → 全程静默；已启用 → 换成阶段指引。重新推荐只在出现实质新证据时由模型判断，机制上不再自动弹出。
- **S3 Define**：第一主工作点。按技能自身 Draft→View/review→Freeze 完成 implementation-independent 的 frozen business truth（`.hapilon/go-case/cases.yaml` + `frozen.md`）。Expected 合法来源仅三种：用户明确确认、权威业务文档、基于已确认规则的机械推导。**Gate 交互（刻意从轻）**：不做「所有 case 必须完美才能离开 S3」的粗暴规定；机械代理检查只有一条——启用 且 cases.yaml 存在 且 frozen.md 不存在 → 缺口（强推转 debt）。一个 case 都没起草不拦（启用后不起草是用户拍板，机械层不越权）；「哪些是核心 case」是语义判断，归人。未确定场景记 Unknown/Proposal，是否带着推进由用户在 Gate 决定。
- **S4 Design**：frozen cases 是权威约束——任何技术方案下已确认业务真值必须成立；Design 不得修改 expected；Frozen truth 与新证据冲突 → 走上游前提检查（§15 Part A），报告等用户。
- **S5 Visual**：golden-case 不拥有 S5（artifact-assist 主导）。frozen case 场景可作图示输入（sequence/state/failure path）；视觉表达不改 case truth，case 不决定视觉形式。两能力正交：diagram 不是 case truth，case 不决定视觉。
- **S6 Prototype**：第二主工作点开始（Implementation Observation）。样例选择优先验证高风险 case、撞击 Design 最大不确定性的 vertical slice；实现出现后走技能 Adapter 阶段——adapter 写进**项目真实测试目录**并登记 manifest.json（技能铁律，.hapilon/ 下不放可执行物），implementation → observation → actual 与 frozen expected 独立比较。
- **S7 Inspect**：主验证阶段。除 Flow 六轴 Reviewer 外，运行技能自身完整 verification（report/audit 脚本 + Adapter 回执评审）。区分两问：A. implementation 是否满足 frozen case？B. case 是否足以证明关键业务行为？A 过 B 仍可 Concern/Fail；B 失败不得自动改 expected——记 Proposal/Unknown 交用户。术语两套并行不互译：Flow 轴用 Pass/Concern/Fail/Not verified，golden-case 用 PASS/FAIL/UNKNOWN，self-review.md 引用时保持原词。
- **S8 Scale**：Scenario Expansion & Drift Protection。同类数据差异 → 沿用现有 frozen cases/pattern；真正新业务场景 → 先定真值（new scenario → 确认 → 封金 → 实现 → adapter 验证），禁止 implementation first 再照输出补 case。新场景冲击核心定义/已有真值/Design 假设 → 命中 §14-5 升级规则，停下报告等用户。
- **S9 Freeze**：spec.md/start-prompt.md 记录**位置与规则，不复制内容**——启用状态、`.hapilon/go-case/` 各文件角色（cases.yaml/frozen.md/manifest.json/runs.json）、未关闭 case 事项、后续改业务行为的重审路径（重新确认 → 新版本封金；adapter 全绿不等于业务对）、重放会话应先读哪些 case 资产。runs.json 不入版本控制。

### 16.3 Anti-Fitting Boundary（单列核心规则）

**禁止路径**：implementation → observed output → 修改 expected 以匹配 implementation。技能铁律 6（golden values 永远来自人，不来自实现快照）与铁律 4（封金后只有用户能改 Expected）在 Flow 侧的同一表述。S6 指引写明典型形态：观察到 actual=72 后「看来 expected 也该是 72」——禁止。

**允许路径**：implementation → verification → 发现 Case 不充分 → Proposal/Unknown → 回到业务依据 → 人/权威重确认 → 新 Frozen truth（新版本封金）→ 再验证 implementation。实现后可以挑战 case 的充分性，不能让实现成为 case 正确性的来源。

### 16.4 Capability 与既有机制的接口

- **Context Policy**：能力上下文独立于主线上下文分层（`CONTEXT`），按阶段注入且存在性降级：S3 cases.yaml（relevant）；S4 frozen.md（authoritative）+ cases.yaml（relevant）；S5 cases.yaml（relevant）；S6 frozen.md（authoritative）+ manifest/runs（relevant）；S7 frozen+runs（authoritative）+ manifest（relevant）；S8 frozen（authoritative）；S9 frozen+manifest（relevant）。目标是约束不是 token 洪水——未启用零注入。
- **Gate Debt**：只有 S3 代理检查命中且用户强推才生成 debt（走既有 force 机制，无新债务类型）。「27 个未来可能补的边缘 case」不进 Flow debt——capability 内部状态由 capability 自己管理，Flow debt 只记影响主线可靠性的未解决事项。
- **Upstream Assumption Check**：§15 Part A 段落补一句「能力暴露上游问题同此办理」——golden-case 发现 Frozen truth 冲突、artifact-assist 发现 Frame/Design 问题，统一走建议权通道：指出/给证据/说影响/建议回退阶段/等用户。能力可以发现上游问题，没有上游修改权。
- **artifact-assist authority**：高视觉提案权、高反馈翻译权；无 Frame/Definition 修改权、无业务拍板权、无推进权——即 stages.ts 既有的 S5 autonomy（拍板权在用户）+ §15 Part A，无新增条款。

### 16.5 state schema

```jsonc
// FlowState 新增（旧 state 缺省补 {}，version 仍 1，向后兼容）
"capabilities": {
  "golden-case": { "status": "enabled", "enabledAtStage": 2, "reason": "订单状态与金额" }
  // 或 { "status": "declined", "reason": "纯视觉任务" }
}
```

解析 fail closed：未知能力 id、非法 status、enabledAtStage 越界 → FlowStateError。历史 kind 新增 `cap-enable` / `cap-decline`（to = 决定时所在阶段）。翻转是真实用户决策：单条目覆盖 + history 留痕。

### 16.6 示例：为订单退款增加幂等处理（编码任务全流程）

| 阶段 | golden-case 参与方式 |
|---|---|
| S0 | 用户需求 + 一次重复退款事故材料入 dump.md（原始材料，无 case 动作） |
| S1 | 读退款调用链、DB schema、现有 tests——了解 observation surface 在哪（订单表/流水表）；不从现有输出推 expected |
| S2 | 命中信号（金额+状态+持久化真值）→ 模型输出推荐 → 用户 `cap golden-case enable 退款金额与状态是业务真值` |
| S3 | 起草 CASE-001 正常退款 / 002 重复同 request id / 003 首次成功后网络超时重发 / 004 DB 成功但响应失败；expected 由用户逐条确认（依据：退款规则文档+用户口径）→ View/review → 封金 |
| S4 | 幂等策略设计（request id 去重表 vs 状态机拦截）以四条 frozen case 为硬约束；发现 CASE-004 与新证据冲突 → 上游前提检查报告，等用户 |
| S5 | CASE-003 场景映射为 sequence diagram（artifact-assist 画，图不是 truth） |
| S6 | vertical slice 选 CASE-002（最高风险）；实现后写 adapter 进项目测试目录 + manifest 登记；actual 与 frozen expected 独立比较——观察到 actual=72 不得回写 expected=72 |
| S7 | 跑 report/audit + Adapter 回执评审；A（实现满足 case）全绿 + B（case 足以证明幂等行为）附证据记入 self-review.md；B 有 Concern（未覆盖并发窗口）→ Proposal 交用户 |
| S8 | 扩其他退款入口（同类差异，沿用 pattern）；发现「部分退款」新场景 → 先定真值再实现，禁止照实现补 case |
| S9 | spec.md 记录 case 资产位置与重审路径；case + adapter 成为 drift guard，保护后续重构 |

### 16.7 十二问自答（Integration Spec 完成判据）

1. **Stage vs Capability？** Stage 拥有 index 与推进语义，回答认知问题；Capability 是可选专业方法，不占 index、不推进、跨阶段服务。
2. **artifact-assist 为什么不是 Stage？** 视觉定调已是 S5；它是该阶段（及 S4/S6/S7 辅助）的方法供应商，无生命周期状态需要状态机管理。
3. **golden-case 为什么不是 S3.5/S10？** 它横跨 S1–S9（S3 定义真值、S6 观察、S7 验证、S8 防漂移、S9 资产化），切成单点阶段会切断「编码前定义/编码后验证」的同一真值链。
4. **为什么编码前后都出现？** correctness 的定义在编码前冻结（约束），验证在编码后独立执行（验收）——同一业务真值的两次使用，不是两个能力。
5. **什么必须在 observation 前 Freeze？** 被选作本轮约束的核心 case 的 expected 及其 business basis（Draft+View 回执 + 用户确认 + frozen.md 快照）。
6. **编码后发现 case 不充分？** 走允许路径（16.3）：Proposal/Unknown → 业务依据 → 人重确认 → 新版本封金 → 再验证。
7. **谁能改 expected？** 封金后只有用户（技能铁律 4）；AI 起草、评审、建议，不拍板。
8. **AI 能否自行启用？** 不能。推荐输出后等 `cap` 命令；未决定/已拒绝流程照常。
9. **能力暴露上游错误谁决定 regress？** 用户。能力与 AI 都只有建议权（§15 Part A + 能力同此办理条款）。
10. **产物如何进 Context Policy？** 16.4 的阶段化 tier 表，未启用零注入，文件不存在降级不列。
11. **未完成何时成 Gate Debt？** 仅 S3 代理检查命中且强推；边缘 case 缺口留在能力内部，不进 Flow debt。
12. **Freeze 后如何成为长期约束？** S9 记录资产位置与重审规则；重放/新任务读 frozen.md；改业务行为须重新确认+新版本封金；adapter 全绿不等于业务对。

### 16.8 实现清单与刻意不做

实现：`capabilities.ts`（推荐条款/阶段指引/上下文分层单一事实源）、`machine.ts`（capabilities 字段 + setCapabilityEffect + Gate 代理检查）、`prompts.ts`（能力区块注入 + freeze note 能力行）、`index.ts`（cap 子命令）、`completions.ts`（cap 候选）、`render.ts`（status 能力行）、`stages.ts`（S4 skills += artifact-assist）、本文档、单测。

刻意不做：不改 golden-case / artifact-assist 任何文件；无动态阶段/DAG/plugin framework；无 AI 自动 enable/regress；无 observed→expected 回写；不强制所有编码任务启用；不把能力产物塞进所有 prompt。已知边界：S3 机械检查只认默认路径 `.hapilon/go-case/`（用户搬迁根目录则静默跳过，不误伤）；「核心 case」的选取是语义判断归人。
