/**
 * hpl-panel-viewer — 折叠面板浮动查看器（全量 pi-pop 对齐）
 *
 * 功能：
 *   /pop [pattern] — 打开 viewer，可选精准定位
 *   /pop-config — 配置规则（show/hide/remove/maxlines/list/reset）
 *   hapi-pop-show tool — LLM 可打开面板
 *   hapi-pop-config tool — LLM 可配置规则
 *   全局快捷键 Shift+Alt+↓ / Ctrl+Q
 *   mouse wheel 滚动
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state, POP_ICON } from "./shared.js";
import { improvePanelAppearance, findNewestPanel } from "./panels.js";
import { launchViewer } from "./viewer.js";
import { attachInputListener } from "./input.js";
import { loadPopConfig, applyPopConfig } from "./config.js";

export default function hplPanelViewer(pi: ExtensionAPI): void {
  loadPopConfig();

  pi.on("session_start", (_event, ctx) => {
    if (ctx?.hasUI !== true) return;
    state.openViewer = (target?: unknown) => launchViewer(ctx.ui, target);

    // 不可见 widget 仅用于捕获 live TUI 并注入 markers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.ui.setWidget("hapi-pop", (tui: any, theme: any) => {
      attachInputListener(tui);
      improvePanelAppearance(tui, theme);
      return { render: () => [], invalidate() {}, dispose() {} } as any;
    });
  });

  // ── /pop 命令 ─────────────────────────────────────────────────────────
  pi.registerCommand("pop", {
    description: "Open floating viewer for collapsible panels (optional: /pop <pattern>)",
    handler: async (args, ctx) => {
      const pat = (args ?? "").trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const target = pat ? findNewestPanel((state.activeTui as any), pat) : undefined;
      if (pat && !target) ctx.ui.notify(`${POP_ICON} no panel matching "${pat}"`, "info");
      launchViewer(ctx.ui, target);
    },
  });

  // ── /pop-config 命令 ─────────────────────────────────────────────────
  pi.registerCommand("pop-config", {
    description: "Configure viewer: show|hide|remove <pattern> · maxlines <n> · list|reset",
    handler: async (args, ctx) => {
      const parts = (args ?? "list").trim().split(/\s+/);
      const action = parts.shift() ?? "list";
      ctx.ui.notify(`${POP_ICON} ${applyPopConfig(action, parts.join(" "))}`, "info");
    },
  });

  // ── hapi-pop-show tool（LLM 可打开面板）─────────────────────────────
  pi.registerTool({
    name: "hapi-pop-show",
    label: "Show panel",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } as any,
    description:
      "Open the hapi-pop floating viewer showing a specific panel's content. " +
      "Give a 'pattern' matched (case-insensitive) against panel titles. " +
      "Use when the user asks to see a panel's output — e.g. 'show the bash result'.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, params: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tui = state.activeTui as any;
      const target = tui ? findNewestPanel(tui, params.pattern) : null;
      if (!target) {
        return { content: [{ type: "text", text: `No panel matching "${params.pattern}"` }], details: {} };
      }
      state.openViewer?.(target);
      return {
        content: [{ type: "text", text: `Opened panel matching "${params.pattern}" in viewer` }],
        details: {},
      };
    },
  });

  // ── hapi-pop-config tool（LLM 可配置规则）────────────────────────────
  pi.registerTool({
    name: "hapi-pop-config",
    label: "Pop config",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: { type: "object", properties: { action: { type: "string" }, pattern: { type: "string" } }, required: ["action"] } as any,
    description:
      "Configure hapi-pop viewer. Actions: 'show' <pattern>, 'hide' <pattern>, " +
      "'remove' <pattern>, 'maxlines' <n>, 'list', 'reset'. " +
      "Use when user asks to show/hide certain outputs in the panel viewer.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_id: string, params: any) {
      const text = applyPopConfig(params.action, params.pattern);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
