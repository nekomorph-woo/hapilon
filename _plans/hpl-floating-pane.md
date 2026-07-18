# hpl-floating-pane v2：通用浮层组件 + hpl-panel-viewer 全量 pi-pop 对齐

> **Context**: 当前 FloatingPane + hpl-panel-viewer 只实现了 pi-pop 功能的 3/11。用户要求补全全部 11 项功能，即使实现方式需要改变（如从 session entries 改为 TUI component tree）。

---

## §1 pi-pop 全功能对照与实现策略

| # | pi-pop 功能 | 当前状态 | v2 实现策略 |
|---|-----------|---------|------------|
| ① | TUI component tree 面板发现 | ❌ session entries | ✅ 遍历 `tui.children` 找 `setExpanded` 组件 |
| ② | 渲染后内容提取（含 ANSI） | ❌ 原始 JSON | ✅ `panelContent()` — 临时 expand→render→restore |
| ③ | ▶/▼ gutter 标记 + collapse cap | ❌ | ✅ monkey-patch `render()` 注入标记 |
| ④ | Viewer 浮层 + ←→ + 滚动 | ✅ 已有 | 🔧 增强：面板实时同步 + 内容从 TUI 读取 |
| ⑤ | 面板实时同步 | ❌ | ✅ viewer 打开期间 `sync()` 扫描新面板 |
| ⑥ | mouse wheel 滚动 | ❌ | ✅ SGR mouse reporting + `tui.addInputListener` |
| ⑦ | 全局快捷键 Shift+Alt+↓ | ❌ | ✅ `tui.addInputListener` + `matchesKey` |
| ⑧ | /pop \<pattern\> 精准打开 | ❌ | ✅ `findNewestPanel(tui, pattern)` 标题匹配 |
| ⑨ | LLM-callable tool | ❌ | ✅ `pi.registerTool("hapi-pop-show")` + `pi.registerTool("hapi-pop-config")` |
| ⑩ | 配置持久化 | ❌ | ✅ `~/.hapilon/config.json`（hapilon 统一配置文件）存 pop 段配置 |
| ⑪ | 折叠行数上限 | ❌ | ✅ `config.maxLines` 截断 + "…N more lines" footer |

---

## §2 架构变更

### FloatingPane → 目录组织

`src/shared/floating-pane.ts` 目前 ~210 行，加上 mouse 支持后可能超 300 行。拆为目录：

```
src/shared/floating-pane/
├── index.ts          重导出 + show() 静态入口
├── pane.ts           FloatingPane 类（Component 接口 + render + 滚动）
├── options.ts        FloatingPaneOptions 类型
└── mouse.ts          SGR mouse reporting 序列 + wheel 路由
```

### hpl-panel-viewer → 全量扩展

```
src/extensions/hpl-panel-viewer/
├── index.ts          扩展入口：注册 /pop + /pop-config 命令 + tool + session_start
├── shared.ts         全局 state（同 pi-pop 模式）
├── panels.ts         TUI component tree 遍历 + panelContent + ▶/▼ markers + findNewestPanel
├── viewer.ts         Viewer 类（@FloatingPane 替代，按 TUI 内容渲染）
├── input.ts          全局快捷键 + mouse wheel 路由（tui.addInputListener）
└── config.ts         ~/.hapilon/config.json 持久化 + applyPopConfig
```

### hpl-context-viewer → 保持不变

只是改用目录化的 FloatingPane import 路径。

---

## §3 核心实现细节

### 3.1 TUI 面板发现 (panels.ts)

```typescript
// 判断组件是否可折叠
function isExpandable(comp: unknown): boolean {
  return typeof comp === "object" && comp !== null
    && typeof (comp as any).setExpanded === "function";
}

// 递归收集所有可折叠组件（深度优先，保持渲染顺序）
function collectExpandables(node: any, out: any[]): any[] {
  if (isExpandable(node)) out.push(node);
  if (Array.isArray(node?.children))
    for (const child of node.children) collectExpandables(child, out);
  return out;
}

// 读取面板渲染后内容（临时 expand→render→restore，conversation 无感知）
function panelContent(panel: any, width: number): string[] {
  const render = panel.__hapiRender || panel.render.bind(panel);
  const was = panel.expanded ?? false;
  let lines: string[];
  try { panel.setExpanded(true); lines = render(width); }
  finally { panel.setExpanded(was); }
  return Array.isArray(lines) ? lines.filter((l: unknown) => typeof l === "string") : [];
}
```

### 3.2 ▶/▼ gutter 标记 (panels.ts)

monkey-patch 每个可折叠组件的 `render()`：

```typescript
function decorateExpandable(comp: any, theme: Theme, configMaxLines: number): void {
  const original = comp.render.bind(comp);
  comp.render = (width: number) => {
    let lines = original(width);
    const expanded = comp.expanded ?? false;
    // 折叠时截断到 maxLines
    if (configMaxLines > 0 && !expanded && lines.length > configMaxLines) {
      const hidden = lines.length - configMaxLines;
      lines = [...lines.slice(0, configMaxLines),
        ` …${hidden} more lines (hapi-pop)`];
    }
    // 注入 ▶/▼ 到第一行左侧
    if (lines.length > 0 && typeof lines[0] === "string") {
      const marker = expanded ? "▼" : "▶";
      lines[0] = theme.fg("dim", marker) + " " + lines[0];
    }
    return lines;
  };
}
```

### 3.3 Viewer (viewer.ts)

复用 FloatingPane 的 render 框架，但内容从 TUI panel 读取：

```typescript
class PanelViewer extends FloatingPane {
  private panels: any[];
  private sel = 0;
  private tui: any;

  // 实时同步：扫描新面板，按对象引用保持选中
  sync(): void {
    const current = this.panels[this.sel];
    this.panels = collectExpandables(this.tui, []);
    const idx = current ? this.panels.indexOf(current) : -1;
    this.sel = idx >= 0 ? idx : Math.min(this.sel, this.panels.length - 1);
  }

  // 读取当前面板的渲染后内容
  getContent(): string[] {
    if (!this.panels.length) return ["No panels available"];
    return panelContent(this.panels[this.sel], this.tui.terminal.columns);
  }
}
```

### 3.4 全局快捷键 + mouse wheel (input.ts)

```typescript
function attach(tui: any, state: State): void {
  tui.addInputListener((data: string) => {
    // 快捷键打开 viewer
    if (!tui.hasOverlay?.() && config.keys.some((k) => matchesKey(data, k))) {
      state.openViewer?.();
      return { consume: true };
    }
    // mouse wheel 路由给 viewer
    if (state.activeViewer) {
      const m = data.match(SGR_MOUSE_RE);
      if (m) {
        const btn = parseInt(m[1], 10);
        if ((btn & 64) !== 0 && m[4] === "M")
          state.activeViewer.scrollBy((btn & 1) === 1 ? 3 : -3);
        return { consume: true };
      }
    }
  });
}
```

### 3.5 配置持久化 (config.ts)

```typescript
// ~/.hapilon/config.json
interface PopConfig {
  include: string[];    // 强制显示的面板（标题匹配）
  exclude: string[];    // 隐藏的面板
  keys: string[];       // 快捷键 ["shift+alt+down", "ctrl+q"]
  maxLines: number;     // 折叠行数上限（0=关闭）
}
```

### 3.6 LLM-callable tools (index.ts)

```typescript
// hapi-pop-show: LLM 可打开指定面板
pi.registerTool({
  name: "hapi-pop-show",
  description: "Open the hapi-pop viewer on a panel matching the pattern",
  parameters: Type.Object({ pattern: Type.String() }),
  async execute(_id, params) {
    const target = findNewestPanel(state.activeTui, params.pattern);
    if (!target) return { content: [{ type: "text", text: `No panel matching "${params.pattern}"` }] };
    state.openViewer?.(target);
    return { content: [{ type: "text", text: `Opened panel matching "${params.pattern}"` }] };
  },
});

// hapi-pop-config: LLM 可配置规则
pi.registerTool({
  name: "hapi-pop-config",
  description: "Configure hapi-pop viewer rules",
  parameters: Type.Object({
    action: Type.String(),
    pattern: Type.Optional(Type.String()),
  }),
  async execute(_id, params) {
    const text = applyPopConfig(params.action, params.pattern);
    return { content: [{ type: "text", text }] };
  },
});
```

---

## §4 实现步骤

### Step 1: FloatingPane 目录化

- 拆 `src/shared/floating-pane.ts` → `src/shared/floating-pane/` (index / pane / options)
- 添加 mouse.ts（SGR sequences + wheel 路由）
- 更新所有 import 路径

### Step 2: hpl-panel-viewer 全量升级

按文件逐一实现：
1. **shared.ts** — state + config + constants + mouse sequences
2. **panels.ts** — collectExpandables + panelContent + decorateExpandable + findNewestPanel
3. **viewer.ts** — PanelViewer extends FloatingPane，sync + getContent
4. **input.ts** — 全局快捷键 + mouse wheel
5. **config.ts** — ~/.hapilon/config.json 读写 + applyPopConfig
6. **index.ts** — 注册 /pop + /pop-config 命令 + hapi-pop-show/hapi-pop-config tools + session_start

### Step 3: hpl-context-viewer import 路径更新

- `FloatingPane` import 改为 `../../shared/floating-pane/index.js`

---

## §5 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/shared/floating-pane/index.ts` | **新建** | 重导出 + show() |
| `src/shared/floating-pane/pane.ts` | **新建** | FloatingPane 类（从 floating-pane.ts 迁入） |
| `src/shared/floating-pane/options.ts` | **新建** | FloatingPaneOptions 类型 |
| `src/shared/floating-pane/mouse.ts` | **新建** | SGR mouse sequences |
| `src/shared/floating-pane.ts` | **删除** | 迁移到目录 |
| `src/extensions/hpl-panel-viewer/shared.ts` | **新建** | state + config 默认值 + constants |
| `src/extensions/hpl-panel-viewer/panels.ts` | **新建** | TUI 面板发现 + 内容提取 + markers |
| `src/extensions/hpl-panel-viewer/viewer.ts` | **新建** | PanelViewer（extends FloatingPane） |
| `src/extensions/hpl-panel-viewer/input.ts` | **新建** | 快捷键 + mouse wheel |
| `src/extensions/hpl-panel-viewer/config.ts` | **新建** | ~/.hapilon/config.json 持久化 |
| `src/extensions/hpl-panel-viewer/index.ts` | **重写** | 全量注册 |
| `src/extensions/hpl-panel-viewer/panel-source.ts` | **删除** | 被 panels.ts 替代 |
| `src/extensions/hpl-context-viewer/index.ts` | **修改** | import 路径更新 |
| `src/test/unit/floating-pane.test.ts` | **修改** | import 路径更新 |
| `src/test/unit/hpl-panel-viewer.test.ts` | **重写** | 覆盖新 panels.ts 逻辑 |

---

## §6 验收标准

### FloatingPane 目录化
- [ ] `import { FloatingPane } from "../../shared/floating-pane/index.js"` 正常工作
- [ ] 所有现有功能不变（边框、滚动、show()、width/maxHeight 参数）
- [ ] 全量测试不受影响

### hpl-panel-viewer 全量功能
- [ ] ① TUI component tree 面板发现 — viewer 列出所有 `setExpanded` 组件
- [ ] ② 渲染后内容 — viewer 显示 Pi 渲染过的面板（含 ANSI color），非原始 JSON
- [ ] ③ ▶/▼ gutter 标记 — 每个可折叠面板左侧有 `▶`/`▼`
- [ ] ④ Viewer 浮层 — ← → 切换 + ↑↓ 滚动 + 面板实时同步
- [ ] ⑤ 面板实时同步 — viewer 打开期间新面板自动出现
- [ ] ⑥ mouse wheel 滚动 — 滚轮路由给 viewer
- [ ] ⑦ 全局快捷键 — Shift+Alt+↓ 打开 viewer
- [ ] ⑧ /pop \<pattern\> — 精准打开标题匹配的最新面板
- [ ] ⑨ LLM tools — hapi-pop-show + hapi-pop-config 注册成功
- [ ] ⑩ 配置持久化 — ~/.hapilon/config.json
- [ ] ⑪ 折叠行数上限 — maxLines 截断 + "…N more lines" footer

### 整体
- [ ] 全量测试通过 | TS 编译 0 错误
