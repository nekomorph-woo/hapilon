/**
 * hpl-startup-header — Claude Code 风格自定义启动头部
 *
 * 通过 ctx.ui.setHeader() 替换 Pi 内置 header，展示：
 * - Hapilon mascot（Claude Code 风格 + 像素角）
 * - Welcome back / provider·model / workspace
 * - 扩展列表 / Pi 版本更新 / 快捷键提示
 *
 * 配合 cli.ts 的 quietStartup + PI_SKIP_VERSION_CHECK + 环境变量传递。
 */
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createStartupHeader } from "./content.js";
import { fetchLatestPiVersion } from "./version-check.js";
export default function hplStartupHeader(pi) {
    pi.on("session_start", (_event, ctx) => {
        if (!ctx.hasUI || ctx.mode !== "tui")
            return;
        const state = { expanded: false, piUpdate: undefined };
        let versionChecked = false;
        let cachedComponent = null;
        // NOTE: tui/theme type as any — nested pi-tui instances cause
        // incompatible private-property errors. Tracked in backlog:
        // _backlog/pi-tui-runtime-dependency.md
        ctx.ui.setHeader((tui, theme) => {
            // 复用单例组件，避免每次 render 创建新对象
            if (cachedComponent)
                return cachedComponent;
            cachedComponent = createStartupHeader(ctx, tui, theme, state);
            // 仅在首次渲染时发起版本检查，防止重绘产生冗余请求
            if (!versionChecked) {
                versionChecked = true;
                void fetchLatestPiVersion(VERSION).then((latest) => {
                    if (latest) {
                        state.piUpdate = latest;
                        try {
                            tui.requestRender();
                        }
                        catch (err) {
                            console.warn("[hpl-startup-header] requestRender failed:", err);
                        }
                    }
                });
            }
            return cachedComponent;
        });
    });
}
