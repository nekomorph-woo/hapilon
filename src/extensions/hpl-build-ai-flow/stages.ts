/**
 * stages.ts — 十阶段定义（单一事实源）
 *
 * 全插件（派发 prompt、status 渲染、Gate 检查、补全候选）都从这张表读，
 * 不在别处存副本。内容以 docs/ai-complex-task-checklist.md 为底本精简；
 * S5 visual 为 GPT 流程缺位的补入（设计文档 §9）。
 */

export interface StageDef {
  index: number;
  slug: string;
  zh: string;
  coreQuestion: string;
  /** 本阶段自主权条款，注入派发 prompt */
  autonomy: string;
  checklist: string[];
  /** 本阶段要求产物（工作区相对路径） */
  artifacts: string[];
  /** 产物内容要求，注入派发 prompt */
  artifactNote: string;
  /** Gate 语义项（人卡），status 渲染用 */
  gateNote: string;
  /** 停止条件，注入派发 prompt 尾部 */
  stopCondition: string;
  /** 附加技能提示（派发 prompt 一句话提及） */
  skills: string[];
}

export const LAST_STAGE = 9;

export const STAGES: StageDef[] = [
  {
    index: 0,
    slug: "dump",
    zh: "倒出来",
    coreQuestion: "我现在到底有什么？哪怕很乱。",
    autonomy:
      "高整理权低调查权：优先整理用户已提供、指向或明确提及的材料；可提问补缺，不为了 dump 看起来完整而主动开展大规模调查（读仓库、搜资料、解释业务背景）；需要调查的问题记为待探索项留给 S1；不把自己的背景知识补成用户事实；不可替用户拍板最终方案，不可直接做成品。",
    checklist: [
      "把手头材料列全：领导一句话、旧报告、数据源、截图、链接、抱怨、直觉",
      "说明大致给谁看（不确定就写不确定）",
      "说出最困惑或最不满意的地方——哪怕只是「看着就怪，说不上来哪怪」",
      "允许「不知道」存在，不要为了完整而补全",
      "区分：事实、我的猜测、待确认项",
      "值得调查但手头没有的问题 → 记入「待探索」清单留给 S1，不在本阶段动手",
    ],
    artifacts: ["dump.md"],
    artifactNote: "材料清单（每项一句话说明）+ 已知情况摘要 + 你的困惑与不满。不需要结构完美，需要的是倒全。",
    gateNote: "AI 没有直接跳成品；已知/未知/冲突开始成图",
    stopCondition: "写完 dump.md 即停，不写代码，不做成品。",
    skills: [],
  },
  {
    index: 1,
    slug: "explore",
    zh: "探索事实",
    coreQuestion: "客观世界现在是什么样？",
    autonomy:
      "高提问权低决策权：可自由调查并标记推断；不可把建议混成事实，不可替用户拍板口径。重调查默认委派 subagent：读仓库、搜外部资料、跑数据探查这类会产生大量中间输出的调查，派子代理执行，主会话只收结论与出处；明确只需读一两个文件的小调查可直接做，不为委派而委派。",
    checklist: [
      "数据源清单及各自可信度（哪个是权威源、哪个是历史遗留）",
      "字段 / 文件 / 仓库分别代表什么",
      "哪里冲突、重复、缺失",
      "哪些术语看似相同、含义不同",
      "哪些判断只是推断——推断一律显式标记",
    ],
    artifacts: ["discovery.md"],
    artifactNote: "分节：已确认事实 / 数据源与可信度 / 术语含义 / 冲突与缺失 / 当前无法确认项。推断必须标「推断」。",
    gateNote: "事实与建议分开；主要口径冲突已暴露",
    stopCondition: "写完 discovery.md 即停，不做方案，不做成品。",
    skills: ["research", "understand-this-codebase"],
  },
  {
    index: 2,
    slug: "frame",
    zh: "定义问题",
    coreQuestion: "谁要用这个东西？他看完要做什么判断？",
    autonomy:
      "可提出 2~3 个明显不同的问题定义候选；存在多个合理 Frame 时，必须先向用户展示候选并要求指认/组合/纠正——用户没有明确确认前，只写候选与用户反应，不得把任何候选记成最终定位句，不得宣称本阶段完成。用户用大白话回应即可（如「B 更接近，但我关心的是风险」），正式定位句由你负责收敛。",
    checklist: [
      "主要用户是谁；是什么角色、不是什么角色",
      "用户最重要的 3~5 个判断是什么",
      "什么信息是噪音，不该进入主线",
      "做错最可能怎样误导用户",
      "多个合理定位并存时：展示 2~3 个明显不同的候选，等用户反应（指认/组合/纠正）后再定稿",
      "定位句确认后：提炼一句话定位句 + 验收要点清单（逐条可判定、可打勾，覆盖交付边界），请用户执行 /build-ai-flow goal <定位句>（换行后每行一条验收要点）写回——S8 覆盖盘点与冻结检查以此为准，goal 原文只是线索源不是承诺书",
    ],
    artifacts: ["frame.md"],
    artifactNote:
      '必须含一句填满的定位句："这是给___看，用来判断___的，不是用来___的"——此句只能在用户确认后写入；确认前 frame.md 只放候选与用户反应记录。',
    gateNote: "定位句是否真的是用户要的判断",
    stopCondition: "候选未经用户确认即停——不写最终定位句，不做信息架构，不写代码。",
    skills: [],
  },
  {
    index: 3,
    slug: "define",
    zh: "钉死口径",
    coreQuestion: "我们嘴里说的这些词，到底是什么意思？",
    autonomy: "可发现术语冲突并提议口径；不可自己发明口径拍板——拍板必须记入 decision-log 并由用户确认。",
    checklist: [
      "每个核心概念：是什么 / 不是什么 / 数据从哪来 / 能否可靠计算",
      "什么明确不算（反定义）",
      "哪些状态允许「不知道」存在",
      "是否用了代理指标——代理必须显式标记，不得包装成真实结果",
      "四分类维护：Fact / Decision / Unknown / Proposal",
      "拍板演进用 lifecycle 表达（active / superseded / revoked + supersedes 指向），不靠自然语言猜新旧",
    ],
    artifacts: ["definitions.md", "decision-log.md"],
    artifactNote:
      "definitions.md 写概念口径；decision-log.md 条目固定格式：D-001｜active｜内容｜2026-09-30。拍板演进用 lifecycle 表达：取代旧决定时新条目追加第 5 段 supersedes D-000，并追加事件行 D-000｜superseded｜by D-001｜日期；废弃用事件行 D-000｜revoked｜原因｜日期。只追加不改旧条目；旧格式状态「已拍板」视为 active。",
    gateNote: "同一个词只剩一种含义；Unknown 没被偷渡成结论",
    stopCondition: "写完两个文件即停，不做信息架构，不做成品。",
    skills: ["domain-modeling"],
  },
  {
    index: 4,
    slug: "design",
    zh: "设计信息",
    coreQuestion: "用户应该按什么顺序看到什么？",
    autonomy: "在已确认边界内提出信息结构方案；不可重新发明业务结构，不可改已拍板口径。",
    checklist: [
      "第一眼看什么、第二眼看什么，主阅读顺序是什么",
      "什么默认隐藏、什么只能下钻",
      "空数据 / 缺口 / 待确认状态如何展示",
      "信息层级是否与业务层级一致——实现结构不许绑架业务结构",
    ],
    artifacts: ["design.md"],
    artifactNote: "信息架构 / wireframe 级结构（Markdown 即可），含主阅读顺序、层级、各状态的展示约定。不写代码。",
    gateNote: "顺着结构能完成主要判断；实现结构没绑架业务结构",
    stopCondition: "写完 design.md 即停，不写代码，不做页面。",
    skills: ["design-before-code", "artifact-diagramming", "artifact-assist"],
  },
  {
    index: 5,
    slug: "visual",
    zh: "视觉定调",
    coreQuestion: "它该长什么气质？视觉在替哪个判断说话？",
    autonomy: "高提案权：给出 2~3 个真渲染出来的方向候选；拍板权完全在用户——用户指认之前不许开做正式交付物。",
    checklist: [
      "用 artifact-assist 生成 2~3 个真渲染方向候选（不是文字描述）——同一信息结构下沿少数关键视觉变量拉开明显差异（如密度/层级强度/阅读场景），不做三个形容词套餐",
      "每个候选写明三件事：强化 Frame 里的哪个判断、牺牲了什么、与其他候选最关键的差异",
      "色彩语义必须对应 Frame 定的判断（如红=风险、绿=通过），不是装饰",
      "用户指认一个方向并记一句拍板理由；反馈可能很非专业（「B 看着舒服」「A 的密度+B 的标题」「都不像」）——你负责翻译成明确的视觉规则并复述确认",
      "用户给不出词时：贴他喜欢的参考物（截图/链接），提取 DNA 做候选",
    ],
    artifacts: ["visual-direction.md"],
    artifactNote:
      "记录：候选方向清单（各一段描述+小样路径+强化什么/牺牲什么/关键差异）、拍板结果、一句理由。后续阶段不许换皮。",
    gateNote: "色彩语义承载的是 Frame 定的判断；装饰没冒充信息",
    stopCondition: "拍板写入 visual-direction.md 即停，不开始做正式交付物。",
    skills: ["artifact-assist", "prototype", "show-me"],
  },
  {
    index: 6,
    slug: "prototype",
    zh: "极端原型",
    coreQuestion: "最肥最瘦两个案例都成立吗？",
    autonomy:
      "高执行权低需求修改权：可自由实现两个样例；不可改已拍板的口径与视觉方向。实现与验证默认委派 subagent：把 design.md、visual-direction.md 与两个样例的要求交给子代理搭建并跑通，主会话只收报告、抽查关键文件、向用户汇报；发现结构撑不住时建议回到上游阶段处理（goto 建议），不自行改设计。例外仅限改动个位数文件的小修补。",
    checklist: [
      "一肥：选数据最多 / 最复杂 / 信息密度最高的案例",
      "一瘦：选数据最少 / 缺口最大 / 异常最明显的案例",
      "验证：最复杂案例不撑爆结构；空数据不被隐藏；少量证据不被误判成完成",
      "同一结构兼容两极，无样例特判",
    ],
    artifacts: ["prototype.md"],
    artifactNote: "记录两个样例的实际文件路径 + 验证结论（结构 / 异常 / 缺口的表现）。",
    gateNote: "缺口可见；没为单个样例破坏结构",
    stopCondition: "两个样例验证完即停，不铺全量。",
    skills: ["prototype"],
  },
  {
    index: 7,
    slug: "inspect",
    zh: "反向验收",
    coreQuestion: "它最可能怎样误导我？",
    autonomy:
      "审查由未参与实现的 subagent 执行：派发时只给产物文件、frame 与验收清单，不给实现过程的对话上下文——审查者的价值在陌生眼睛。主会话负责汇总裁决（Fail 修复、Concern 列单）与执行修复。高质疑权，零粉饰权——只挑问题，不夸自己。可用性实测由主会话驾驶：先按维度生成体验条目再逐条实测，条目先行避免走到哪算哪；用 computer_use/browser_use 工具像真实用户一样操作产物（点击、滚动、输入、截图），不止读代码和跑测试；发现阻塞级问题（功能不可用/崩溃/死路）立即修复不待决策，体验级问题（不顺手、文案、层次）记 Concern 清单交用户裁决。报告口径：任何「完成/收口」表述必须附未关账计数（Concern/Unknown/欠账），仍有未关账项时不得宣称「无未办/全部完成」。",
    checklist: [
      "先从 goal、design 与产物实际形态生成体验测试条目——维度：主流程 / 空态与异常 / 乱序与非常规操作 / 边界输入；条目按项目实际写，不套固定清单，用户口头补充的要求并入条目",
      "先用 computer_use/browser_use 逐条实测（点击/滚动/输入/截图），记录每条结果与卡点，不止读代码和跑测试；实测截图落盘并把路径交 vision 子代理分析（多模态），主会话只依据其文字结论汇总裁决，不直接读图",
      "0 有没有被隐藏；Unknown 有没有被包装成结论",
      "代理指标有没有写成真实结果；数量有没有被误读成质量",
      "默认展开与文案是否一致；第一眼重点是被样式强化还是淹没",
      "结论有没有超出证据边界",
      "六轴自评（清晰 / 层级 / 诚实 / 密度 / 一致性 / 可达性）：每轴给 Pass / Concern / Fail / Not verified 并附一句证据（如「诚实性：Concern——执行状态是代理指标，但主标签写成了已执行」）；Fail 先修复再交付，Concern 进问题清单由用户裁决，Not verified 说明缺了什么检查——不打数字分",
    ],
    artifacts: ["self-review.md"],
    artifactNote: "问题清单（按严重度排序，阻塞级标注已即时修复）+ 体验条目清单及逐条实测结果（含操作序列与截图/现象）+ 六轴自评（每轴 Pass/Concern/Fail/Not verified 附证据）+ 已修复项 + 遗留项。",
    gateNote: "0 没被隐藏；代理指标没写成真实结果",
    stopCondition: "写完 self-review.md 并修复明确问题后即停，不加新功能。",
    skills: ["verify", "artifact-assist", "ui-automation"],
  },
  {
    index: 8,
    slug: "scale",
    zh: "扩全量",
    coreQuestion: "是在复制已验证模式，还是重新发明系统？",
    autonomy:
      "高执行权低需求修改权：只扩数据不改结构；要改规则先出 Proposal 追加 decision-log——推翻旧口径时用 supersedes 事件行，不许偷改。扩全量的批量实现默认委派 subagent：子代理按 prototype/self-review 确认过的模式复制执行，主会话收进度与结果、裁决偏差；规则级改动仍由主会话出 Proposal 留痕。报告口径：任何「完成/收口」表述必须附未关账计数（Concern/Unknown/欠账各几项），仍有未关账项时不得宣称「无未办/全部完成」。",
    checklist: [
      "只扩数据，不动已确认的信息架构与视觉身份",
      "新情况先标 Unknown / Proposal，不偷偷改口径",
      "新异常状态有显式说明",
      "保留一肥一瘦两个样例做回归检查",
      "goal 覆盖盘点（必写，冻结闸门机械检查）：验收要点逐条各占一行（已拍板时）或 goal 与 frame 承诺每一项各占一行（未拍板时），Markdown 表格三态标记 ✅已实现 / ◐部分实现 / ❌未实现；未实现与部分项同格写去向（→ 拍板 D-xxx / 用户裁决原话 / 流程后续+拍板记录），验收要点文本需原样入表（机械匹配），无去向或缺席的项冻结时会被拦",
      "升级规则：新情况若无法由现有定义解释、需要新增核心状态、需要改信息层级或已锁定视觉语义、或会使现有判断被误导 → 立即停止扩量，记 Unknown/Proposal，向用户说明影响并建议回到哪个阶段（Define/Design/Prototype）处理，不自行 goto、不自行改规则",
      "普通数据差异（多/少/空/命名不一）不触发升级，继续扩量",
    ],
    artifacts: ["scale.md"],
    artifactNote: "全量执行记录：扩了什么、遇到的新情况及处理（Unknown/Proposal）、回归检查结果、若命中升级规则则记录影响与建议回到哪个阶段处理；末尾必含「## goal 覆盖盘点」表（格式见清单项，每行一个承诺项）。",
    gateNote: "没为收全数据偷偷改口径",
    stopCondition: "全量完成并写完 scale.md 即停；命中升级规则时立即停止扩量并报告，回到上游或放行由用户决定。",
    skills: [],
  },
  {
    index: 9,
    slug: "freeze",
    zh: "固化经验",
    coreQuestion: "下次换会话，还要从头解释吗？",
    autonomy: "收口模式：只固化已确认的东西，不设计新方案。",
    checklist: [
      "最终 spec：口径、边界、验收规则、锁定的视觉身份（重放不换皮）",
      "decision-log 补全到最新：active 集一致，被取代/废弃的决定都有事件行",
      "仍然存在的 Unknown / Backlog",
      "被否决方案及原因",
      "下次重启最少需要读取的文件清单",
      "新 Start Prompt：新会话读哪些文件、从哪继续",
      "可选：retrospective.md 沉淀方法经验——最初哪里理解错了、哪个 Gate 最有价值、哪次 goto 回跳及原因、哪条规则可复用到其他任务；与 spec 分开，spec 记项目知识，retrospective 记流程经验",
    ],
    artifacts: ["spec.md", "start-prompt.md"],
    artifactNote: "spec.md 写最终口径与视觉身份；start-prompt.md 写重放入口（先读哪些文件、只许做什么、完成后停）。",
    gateNote: "新模型只读这些文件能恢复；视觉身份已锁定",
    stopCondition: "写完两个文件即停，提示用户可执行 /build-ai-flow audit 做决策冲突审查。",
    skills: [],
  },
];

export function stageByIndex(index: number): StageDef {
  const stage = STAGES[index];
  if (!stage) throw new Error(`非法阶段号：${index}（合法 0..${LAST_STAGE}）`);
  return stage;
}

/** Guard 生效范围：这些阶段的产物只有工作区 md（设计 §8） */
export const GUARD_STAGE_MAX = 5;

/**
 * 上下文分层（单一事实源，prompts.ts 从这读，不存副本）：
 * authoritative 必读 / relevant 需要时参考 / historical 溯源才读。
 * 文件不存在时由 prompt 拼装层自动降级不列。
 */
export const CONTEXT: Record<string, { authoritative: string[]; relevant?: string[]; historical?: string[] }> = {
  dump: { authoritative: [] },
  explore: { authoritative: ["dump.md"] },
  frame: { authoritative: ["dump.md", "discovery.md"] },
  define: { authoritative: ["discovery.md"], relevant: ["dump.md"] },
  design: { authoritative: ["frame.md", "definitions.md", "decision-log.md"], relevant: ["discovery.md"] },
  visual: { authoritative: ["frame.md", "design.md", "decision-log.md"], relevant: ["definitions.md"] },
  prototype: { authoritative: ["design.md", "visual-direction.md", "decision-log.md"], relevant: ["definitions.md", "frame.md"] },
  inspect: { authoritative: ["frame.md", "definitions.md", "decision-log.md", "design.md", "visual-direction.md"], relevant: ["prototype.md"] },
  scale: { authoritative: ["design.md", "visual-direction.md", "prototype.md", "self-review.md", "decision-log.md"] },
  freeze: { authoritative: ["definitions.md", "decision-log.md", "design.md", "visual-direction.md", "self-review.md", "scale.md"], relevant: ["frame.md"] },
};

/**
 * 结构性 Gate 标记（机械检查"明显步骤有没有做"，不判内容好坏）：
 * slug → { 产物文件 → 必须出现的关键词 }。未列出的阶段靠存在性+长度。
 */
export const GATE_MARKERS: Record<string, Record<string, string[]>> = {
  explore: { "discovery.md": ["已确认事实", "无法确认"] },
  design: { "design.md": ["阅读顺序", "空数据"] },
  visual: { "visual-direction.md": ["候选", "拍板"] },
  prototype: { "prototype.md": ["肥", "瘦"] },
  inspect: { "self-review.md": ["自评", "问题"] },
  scale: { "scale.md": ["回归", "覆盖盘点"] },
};

/** stale 检查豁免：decision-log 是追加式持久认知，不因上游回退整体失效（按需追加条目即可） */
export const STALE_EXEMPT = new Set(["decision-log.md"]);
