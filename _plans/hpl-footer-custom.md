# hpl-footer — Pi TUI 状态栏定制扩展

> 状态：待实现（TODO-13）
> 决策：文本风格已选定「竖线分隔」；内容与内置 footer 保持一致，不增不减
> 调研方式：Pi 0.80.8 源码级验证（本文所有行号均指 `node_modules/@earendil-works/pi-coding-agent/`）

---

## 1. 背景与机制

Pi 内置 FooterComponent 渲染 TUI 底部状态栏（`dist/modes/interactive/components/footer.js`）。
Pi 未提供"微调"配置——footer 每一项都是硬编码拼接。定制的唯一正道是扩展 API：

```
ctx.ui.setFooter(factory)          // types.d.ts:106
factory: (tui, theme, footerData) => Component & { dispose?() }
```

调用后 Pi **移除内置 footer、挂载我们的组件**（interactive-mode.js:1552-1569），
从此 footer 区域每个字符都由我们的 `render(width): string[]` 输出。
传 `undefined` 可恢复内置 footer。

### 可定制面（全部三行）

```
┌─ setFooter() 接管的全部区域 ────────────────────────────────┐
│ 第1行  ~/hapi (main) • 会话名          ← 路径/分支/会话名   │
│ 第2行  ↑2.2k ↓1.2k ... 0.3%/1.0M   glm-4.7 • thinking off  │
│        └── 左侧统计 ──┘            └── 右侧模型名+档位 ────┘│
│ 第3行  （扩展状态行，有扩展 setStatus 时才出现）            │
└─────────────────────────────────────────────────────────────┘
```

右侧模型名、thinking 档位、provider 前缀**同样可定制**——换位、改样式、删除均可。

### 官方参考实现

`examples/extensions/custom-footer.ts` — 演示了 token 累加、分支获取、左右布局、
`onBranchChange(() => tui.requestRender())` 订阅重渲染、`dispose` 退订。

---

## 2. 全量数据清单（扩展可拿到的一切）

### 2.1 footerData: ReadonlyFooterDataProvider（footer-data-provider.d.ts:53）

| 数据 | 类型 | 说明 |
|------|------|------|
| `getGitBranch()` | `string \| null` | 当前分支；detached HEAD → `"detached"`；非仓库 → `null` |
| `getExtensionStatuses()` | `ReadonlyMap<string, string>` | 其它扩展 `ctx.ui.setStatus()` 设置的状态文本 |
| `getAvailableProviderCount()` | `number` | 可用 provider 数（>1 时内置 footer 显示 `(provider)` 前缀） |
| `onBranchChange(cb)` | `() => unsubscribe` | 分支切换订阅，用于触发重渲染 |

### 2.2 ctx: ExtensionContext（core/extensions/types.d.ts:208-241）

| 数据 | 说明 |
|------|------|
| `ctx.cwd` | 当前工作目录 |
| `ctx.model` | 当前模型：`id` / `provider` / `contextWindow` / `reasoning`（是否支持思考） |
| `ctx.getContextUsage()` | `{ percent, contextWindow, ... }` → `0.3%/1.0M` 的来源 |
| `ctx.isIdle()` | Agent 是否空闲（可做"思考中"指示灯） |
| `ctx.hasPendingMessages()` | 是否有排队消息 |
| `ctx.isProjectTrusted()` | 项目是否被信任 |
| `ctx.mode` / `ctx.hasUI` | 运行模式（tui/rpc/json/print）/ 是否有对话式 UI |
| `ctx.sessionManager` | 只读会话管理器 ↓ |

### 2.3 ctx.sessionManager: ReadonlySessionManager（session-manager.d.ts:136）

14 个只读方法：`getCwd` / `getSessionDir` / `getSessionId` / `getSessionFile` /
`getLeafId` / `getLeafEntry` / `getEntry` / `getLabel` / `getBranch` /
`buildContextEntries` / `getHeader` / `getEntries` / `getTree` / `getSessionName`

footer 常用：
- `getEntries()` — 全部会话条目，遍历 assistant 消息累加 usage（内置 footer 的做法，footer.js:83-94）
- `getSessionName()` — 会话名（第 1 行 `• 会话名`）

### 2.4 每条 assistant 消息的 Usage（pi-ai types.d.ts:251-272）

| 字段 | 对应内置显示 | 备注 |
|------|-------------|------|
| `input` / `output` | `↑` / `↓` | 输入/输出 token |
| `cacheRead` / `cacheWrite` | `R` / `W` | 缓存读/写 |
| `cacheWrite1h` | （未显示） | 1h 保留缓存写入量，仅 Anthropic |
| `reasoning` | （未显示） | 思考 token（output 的子集），可作增量展示项 |
| `totalTokens` | （未显示） | 总量 |
| `cost.{input,output,cacheRead,cacheWrite,total}` | `$`（仅 total） | 成本可分项拆开 |
| 消息级 `provider` / `model` / `responseModel` | （未显示） | 混用多模型时可分账 |

派生指标：`CH%`（缓存命中率）= 最近一条消息的 `cacheRead / (input + cacheRead + cacheWrite) × 100`（footer.js:90-92）。

### 2.5 theme（工厂函数入参）

`theme.fg("dim"|"warning"|"error", text)`、`theme.bold(text)`。
内置配色逻辑：上下文占用 >70% 黄、>90% 红（footer.js:138-146）。

### 2.6 布局工具（@earendil-works/pi-tui）

`visibleWidth(str)`（含 ANSI 码的可见宽度）、`truncateToWidth(str, width, ellipsis)`。

### 2.7 拿不到的（诚实清单）

| 内置 footer 有、扩展 API 未暴露 | 处理方案 |
|-------------------------------|----------|
| `session.modelRuntime.isUsingOAuth()` → `(sub)` 标记 | 省略。需要确认：实现时验证 `ctx.modelRegistry` 能否间接判断 |
| `autoCompactEnabled` → `(auto)` 标记 | 省略（已 grep 确认扩展 types 中无 autoCompact 相关 API） |
| `state.thinkingLevel` | 用 `getThinkingLevel()` 替代——挂在 ExtensionCommandContext（types.d.ts:927）。需要确认：session_start 事件的 ctx 是否含此方法；不含则右侧仅显示模型名 |

---

## 3. 实现设计

> 本节按 2026-07-18 用户最终版式需求编写，取代文件头部「内容与内置一致，不增不减」的旧决策。

### 3.0 最终版式（用户确认）

```
第1行  ~/hapi | main                              ← 工作目录 | 分支（非 git 仓库时仅目录，无竖线）
第2行  up.2.2k | down.1.2k | hit: 86.6% | ctx/win: 41.2%/1m | [DING]     glm-4.7 • thinking off
       └────────────────── 左侧统计 ──────────────────────┘             └─── 右侧 ───┘
第3行  状态A | 状态B                               ← 扩展状态；无状态时整行隐藏，仅 1 条时无分隔符
```

**与内置 footer 的差异**：

| 项 | 内置 | 本设计 |
|----|------|--------|
| 分支 | `(main)` 括号 | `\| main` 竖线分隔 |
| 会话名 | `• 会话名` | 移除 |
| 输入/输出 | `↑` / `↓` | `up.` / `down.` 前缀 |
| 缓存读写 R/W | 显示 | **移除** |
| 成本 $ | 显示 | **移除** |
| 命中率 | `CH86.6%` | `hit: 86.6%` |
| 上下文 | `0.3%/1.0M (auto)` 文字变色 | `ctx/win: 41.2%/1m`，文字不变色，占用语义由 [DING] 表达 |
| 上下文指示 | 无 | **[DING] 按钮式指示灯**（新增） |

**已确认的解释性假设**：`up.` 后数值自适应（`up.234` / `up.2.2k` / `up.1.0M`，<1000 无单位）；窗口格式小写紧凑（`1m` / `200k`）。

### 3.1 文件组织（遵循扩展目录规范，一个文件一个职责）

```
src/extensions/hpl-footer/
├── index.ts    # 扩展入口：setFooter 工厂、订阅/dispose、组件壳
├── format.ts   # 纯函数：usage 累加、三行文本拼装、宽度布局（可单元测试）
└── ding.ts     # 纯函数：[DING] 文案分级 + 渐变色计算（可单元测试）
```

### 3.2 ding.ts — [DING] 指示灯（TDD 对象）

**文案分级**（阈值取 `>=`）：

| 占用率 | 文案 |
|--------|------|
| < 70% | `[DING]` |
| ≥ 70% | `[DING!]` |
| ≥ 80% | `[DING!!]` |
| ≥ 85% | `[DING!!!]` |
| ≥ 90% | `[DING!!!!]` |
| ≥ 95% | `[DING!!!!!]` |

**背景色分段线性插值**：

```
占用率  0%        70%        90%    95%
        ├──────────┼──────────┼──────┼────────►
背景    无背景 ─►  正黄       红     深红(恒定)

  p = 0        : 无背景（终端默认）
  (0, 70]      : lerp( 暗黄(64,52,0)  → 正黄(255,200,0) )   同色系由暗变亮
  (70, 90]     : lerp( 正黄(255,200,0) → 红(220,40,30) )
  (90, 95]     : lerp( 红(220,40,30)  → 深红(139,0,0) )
  > 95         : 深红(139,0,0) 恒定
```

**字色自适应**（保证可读）：按背景相对亮度 `L = 0.2126R + 0.7152G + 0.0722B` 判断——
`L > 140`（0-255 尺度）→ 黑字 `(30,30,30)`；否则 → 白字 `(245,245,245)`。
效果：黄色背景配黑字，红/深红背景配白字。

**接口**：

```typescript
dingLabel(percent: number | null): string          // 文案 + 感叹号分级
dingColor(percent: number | null): { bg: RGB | null; fg: RGB | null }
renderDing(percent: number | null): string          // 组合：ANSI 真彩码包裹的最终字符串
```

**渲染方式**：24 位真彩 ANSI 转义码——背景 `\x1b[48;2;R;G;Bm`、前景 `\x1b[38;2;R;G;Bm`、复位 `\x1b[0m`。
`render()` 返回的字符串由 pi-tui 原样输出，我们可直接内嵌转义码。

**异常路径**：`percent` 为 `null`（压缩后占用未知，内置显示 `?`）→ 无背景 + `[DING]` 无感叹号。

### 3.3 format.ts 纯函数接口（TDD 对象）

```typescript
interface FooterStats { input: number; output: number; cacheHitRate?: number }

aggregateUsage(entries): FooterStats               // 遍历累加 assistant usage + 最新命中率
formatTokens(n): string                            // 自适应：<1000 原样 / 2.2k / 34k / 1.0M
formatWindow(n): string                            // 小写紧凑：200k / 1m
buildLine1(cwd, branch): string                    // `cwd | branch`；branch 为 null 时仅 cwd
buildStatsLeft(stats, ctxPercent, ctxWindow, ding): string
                                                   // "up.N | down.N | hit: N% | ctx/win: N%/W | [DING]"
                                                   // 0 值项跳过；ding 为已渲染的 [DING] 字符串
layoutLine(left, right, width): string             // 左右两端对齐；宽度不足时先截右侧
buildStatusLine(statuses: string[]): string | null // " | " 分隔；空数组返回 null（整行隐藏）
```

### 3.4 index.ts 要点

- `session_start` 事件中调用 `ctx.ui.setFooter(factory)`（`ctx.hasUI` 且 `ctx.mode === "tui"` 才启用）
- 工厂内订阅 `footerData.onBranchChange(() => tui.requestRender())`，`dispose` 退订
- `render(width)` 输出：第 1 行 + 第 2 行（左统计 + 右 `模型名 • thinking 档位`）+ 第 3 行（有状态时）
- 第 1/3 行整体 dim 着色；第 2 行左侧 dim，[DING] 用自身真彩色（不被 dim 包裹）

### 3.5 与现有体系的关系

- `--no-safety` 只过滤 safety-gate / protected-paths，hpl-footer 不受影响（cli.ts 白名单式过滤，无需改动）
- `discoverExtensions()` 自动发现 `hpl-footer/index.js`，无需注册代码

### 3.6 实现时验证点（已实测回填，2026-07-18）

| # | 验证点 | 实测结论 |
|---|--------|----------|
| 1 | `getThinkingLevel()` 可达性 | ✅ **比预期更好**：它挂在 `ExtensionAPI`（`pi` 对象）上而非 ctx，扩展内 `pi.getThinkingLevel()` 随时可调，无需降级。展示条件与内置一致：`ctx.model.reasoning` 为真才显示 |
| 2 | pi-tui `visibleWidth` 可达性 | ❌ pi-tui 未被 hoisted（嵌套在 pi-coding-agent/node_modules 下），hapilon 源码无法 import → 已在 format.ts 自实现 `visibleWidth`/`truncatePlain`/`layoutLine`（ANSI 剥离正则 + 单测覆盖） |
| 3 | 终端真彩支持 | ⏳ 待用户端到端手测确认（[DING] 背景色是否正常渲染）；异常时降级记入 `_backlog/` |

---

## 4. 任务拆分

| # | 任务 | 验证方式 |
|---|------|----------|
| 1 | ding.ts 纯函数 + 单元测试（TDD） | 三层覆盖：阈值边界（69.9/70/80/85/90/95/100）/ 渐变分段端点 / null 占用 |
| 2 | format.ts 纯函数 + 单元测试（TDD） | 三层覆盖：正常 / 边界（0 值、空会话、无分支、单条状态）/ 异常（无模型） |
| 3 | index.ts 组件壳 + setFooter 接线 | tsc 编译通过 |
| 4 | §3.6 三个验证点实测 | 记录结论，plan 回填 |
| 5 | 端到端手测 | 启动 hapilon 对照验收标准 |

## 5. 验收标准

- [ ] 三行版式与 §3.0 逐项一致（第 2 行不显示 R/W/$，第 1 行无会话名）
- [ ] [DING] 感叹号在 70/80/85/90/95 阈值处分别为 1~5 个
- [ ] [DING] 背景按分段渐变：0% 无背景；(0,70] 暗黄→正黄；(70,90] 黄→红；(90,95] 红→深红；>95% 深红恒定
- [ ] 背景亮时黑字、暗时白字（亮度公式自动判断）
- [ ] 占用未知（`null`）时 [DING] 无背景无感叹号
- [ ] 右侧 `模型名 • thinking 档位`（thinking 拿不到时仅模型名）
- [ ] 第 3 行仅在有扩展状态时出现；单条无分隔符，多条 ` | ` 分隔
- [ ] ding.ts + format.ts 单元测试全过（三层覆盖）
- [ ] `--no-safety` 下 hpl-footer 仍加载
