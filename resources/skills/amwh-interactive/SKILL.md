---
name: amwh-interactive
description: answer-me-with-html 产页时的交互形态决策与写法：内容含过程、对比、分层或状态切换特征时判定用静态还是交互、选哪种纯 CSS 交互模式（9 种，含写法骨架与降级要求）；用户点名要可交互页面时也使用。
---

# amwh 交互配方

amwh 页面无脚本（CSP `script-src` 锁哈希），交互全部用纯 CSS/HTML 声明式状态实现。本配方决定**何时用交互、用哪种、怎么降级**；与 answer-me-with-html 配对使用，交互代码经其 ```` ```html ```` 块嵌入。

## 静态优先

amwh 已有的静态模式（组件、表格、图、diff、标注）是主体，在绝大多数场景已经足够好。本配方不是鼓励用交互，是给「确实该交互的少数场景」一条正路；不要为了动态而动态。

用交互前必须先回答：**静态版本会损失什么？** 说不出具体损失，就用静态。合格的损失长这样：对齐负担（读者要在脑子里对齐 N 张并排的图）、细节淹没（概览和全量被迫挤在一屏）、关系过密（稀疏关系画成满屏箭头）。「页面更生动」「更有技术感」不是损失，是借口。

两道筛，按序过：

1. 静态会亏吗？——不会 → 静态，结束。
2. 亏处有对应模式吗（见下表）？——没有 → 仍静态，把状态拆成相邻 panel。

## 决策框架

**一条判据**：状态空间大、读者每次只看一个态 → 交互；状态只有一两个 → 直接画。文字最擅承载抽象概念，图最擅全局关系，动画最擅时序，**交互最擅过程、系统、模型**——交互只用在它赢的地方，其余交给静态文字与组件。

- 两道筛过完仍拿不准 → 静态（静态永远不错，交互可能错）。
- 用户点名交互或点名模式 → 从之，降级约束仍强制。
- 每页交互件 ≤ 3 类；超过三类，读者在学「怎么操作页面」而不是内容。
- 连续参数（拖滑杆联动数值）纯 CSS 做不到，不要尝试；用离散档位代替（如「低/中/高」三态切换）。

**降级硬要求**：任何交互内容，在默认态（不点任何东西）、打印、复制到别处三个场景下主干事实仍完整。检查法：想象关掉全部交互后读一遍页面——读得通才合格；弹层、揭示答案这类默认隐藏的内容只放增益，不放主干，且答案文本须在页面他处静态可寻（如折叠 details 内）。

## 九种模式

前 8 种为离散状态族（radio/checkbox/details/popover/:target，2023 底浏览器基线，全平台稳）；第 9 种为滚动驱动族（Chromium 最稳，其余浏览器退化为静态长页，天然满足降级要求）。

| # | 模式 | 何时用 | 写法核心 |
|---|------|--------|----------|
| 1 | 步进器 | 时序/因果过程，分步走读 | radio 链 + `:checked ~` 切面板 |
| 2 | 对照切换 | 同一骨架的两三种状态 | 上游 Before/After 组件；多态用 radio tabs |
| 3 | 折叠 / 互斥手风琴 | 概览少字、深究全量 | `<details>`；互斥加 `name="同组名"` |
| 4 | 悬停联动 | 稀疏但重要的跨图关系，点谁亮谁 | `:hover` / `:focus-within` + 兄弟/祖先 `:has()` |
| 5 | 图层开关 | 多组元素按需显隐 | checkbox + `:has()`；结尾可做「自由探索区」 |
| 6 | 弹层深究框 | 术语首现解释、旁注、参考卡，不打断主线 | `<button popovertarget="id">` + `<div id popover>`；弹层内容仅增益 |
| 7 | 预测-揭示 | 读者有直觉且直觉常错的知识点：先押注再揭示，落差制造记忆 | radio 押注 + `:checked ~` 显示对错块 |
| 8 | 锚点导航 | 多 panel 长页定位回跳 | `:target` + 折叠目录，panel 加 id |
| 9 | 滚动步进 | 长流程随阅读逐段展开，图随文变（滚动条即播放头） | `animation-timeline: view()`/`scroll()`；整页须可纯静态读 |

## 写法骨架

骨架 1 —— 步进器（模式 1，预测-揭示同构）：

```html
<div class="stepper">
  <input type="radio" id="s1" name="st" checked><label for="s1">第 1 步</label>
  <input type="radio" id="s2" name="st"><label for="s2">第 2 步</label>
  <div class="stage stage1">…第 1 步内容…</div>
  <div class="stage stage2">…第 2 步内容…</div>
</div>
<style>
.stepper input { position:absolute; opacity:0; }
.stepper label { cursor:pointer; display:inline-block; padding:2px 10px; }
.stepper .stage { display:none; }
#s1:checked ~ .stage1, #s2:checked ~ .stage2 { display:block; }
#s1:checked + label, #s2:checked + label { font-weight:700; }
</style>
```

骨架 2 —— 图层开关（模式 5，悬停联动同构，把 `:hover` 换 `:has(:checked)`）：

```html
<div class="layers">
  <input type="checkbox" id="lyA" checked><label for="lyA">显示分层 A</label>
  <div class="layerA">…A 组内容…</div>
  <div class="layerB">…B 组内容…</div>
</div>
<style>
.layers input { position:absolute; opacity:0; }
.layers label { cursor:pointer; display:inline-block; padding:2px 10px; }
.layers:not(:has(#lyA:checked)) .layerA { display:none; }
.layers #lyA:checked + label { font-weight:700; }
</style>
```

骨架 3 —— 弹层深究框（模式 6）：

```html
<p>主线一句事实。<button popovertarget="def-term" class="pop-btn">术语是什么</button></p>
<div id="def-term" popover class="pop-card">仅增益的深究解释，主干不依赖它。</div>
<style>
.pop-btn { border:1px solid #888; border-radius:6px; padding:2px 8px; cursor:pointer; }
.pop-card { border:2px solid #444; border-radius:8px; padding:12px 16px; max-width:320px; margin:auto; }
</style>
```

## 硬约束

- 交互代码只经 answer-me-with-html 草稿的 ```` ```html ```` 块嵌入；上游组件（Before/After、ask、annot、折叠目录）能表达的不写 html 块（上游规则：仅当无组件可表达时使用）。
- 无脚本、无外部资源、无表单提交；`<style>` 内嵌实测放行。
- 状态切换只能是离散开关；radio/checkbox 必须配可见 `<label for>`（可点、可聚焦、可复制）。
- 渲染后实测一次：默认态通读完整 + 逐个交互点一遍（amwh 渲染管线不剥属性，实测基线：popover / details name / radio 选择器 / 内嵌 style 全部存活）。

## 模式出处

判据与结构思想源自 Nicky Case 的 explorable explanations 系列（Do & Show & Tell 分工、先押注后揭示、结尾 sandbox 自由区）；滚动步进源自 CSS scroll-driven animations（MDN）与 scrollytelling 实践（静态降级为 chapter contract 硬要求）。2026-10-25 本仓库探针页实测：popover、预测-揭示、互斥手风琴经 amwh 渲染全部存活可用。
