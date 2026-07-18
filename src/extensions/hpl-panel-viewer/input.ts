/**
 * input.ts — 全局快捷键 + mouse wheel 路由
 *
 * - tui.addInputListener 注册快捷键（Shift+Alt+↓ / Ctrl+Q）打开 viewer
 * - mouse wheel 事件路由给 activeViewer.scrollBy()
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { SGR_MOUSE_RE } from "../../shared/floating-pane/index.js";
import { config, state } from "./shared.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachInputListener(tui: any): void {
  state.activeTui = tui;
  tui.addInputListener((data: string) => {
    // 快捷键打开 viewer（仅当无其他 overlay 时）
    if (!tui.hasOverlay?.() && config.keys.some((k: string) => matchesKey(data, k as any))) {
      state.openViewer?.();
      return { consume: true };
    }
    // mouse wheel 路由
    if (state.activeViewer) {
      const m = data.match(SGR_MOUSE_RE);
      if (m) {
        const btn = parseInt(m[1]!, 10);
        if ((btn & 64) !== 0 && m[4] === "M") {
          state.activeViewer.scrollBy((btn & 1) === 1 ? 3 : -3);
        }
        return { consume: true };
      }
    }
    return undefined;
  });
}
