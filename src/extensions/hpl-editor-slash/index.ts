/**
 * hpl-editor-slash — 输入框 slash command 识别:中段补全 + 变色
 *
 * 两个能力都走 pi 公开扩展 API,零 patch:
 *  - addAutocompleteProvider:包装内置 provider,补上「中段 slash 也有命令提示」
 *    (内置唯一门槛是 beforePrefix.trim()==="",见 pi-tui autocomplete.js);
 *  - setEditorComponent:CustomEditor 子类在 render 后给正文行中的已知命令
 *    token 上色(selectList.description 色,跟随主题)。
 *
 * 语义:中段 slash 只是识别与补全辅助,不改变「命令只在行首执行」的提交行为。
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { colorizeLine, extractNames, isMidTextSlashBefore, wrapAutocomplete } from "./slash.js";
import type { AutocompleteProviderLike } from "./slash.js";

interface SlashColorizer {
	(line: string): string;
}

class HapiSlashEditor extends CustomEditor {
	slashColorize: SlashColorizer | undefined;

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.slashColorize) return lines;
		// 结构:[顶边框, ...正文行, 底边框, ...补全下拉行]。
		// 正文行数由内部计数器给出;字段是 private,读不到时(如 pi 升级改名)
		// 退化为不染色——功能关闭,不出错。
		const count = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
		if (typeof count !== "number") return lines;
		for (let i = 1; i <= count && i < lines.length - 1; i++) {
			lines[i] = this.slashColorize(lines[i]);
		}
		return lines;
	}
}

export default function hplEditorSlash(pi: ExtensionAPI): void {
	const shared: { names: Set<string> } = { names: new Set<string>() };

	const setup = (ctx: ExtensionContext): void => {
		// 补全/编辑器组件只在 TUI 生效
		if (ctx.mode !== "tui") return;
		// editor 触发门钩子(pi-tui patch 注入的两个调用点):中段打「/」或打字母时允许请求补全。
		// 缺席(未 patch 的 pi)时编辑器保持原版行首行为,扩展其余能力不受影响。
		const g = globalThis as unknown as Record<string, unknown>;
		g.__hapiMidTextSlash = isMidTextSlashBefore;
		g.__hapiMidTextSlashOpen = isMidTextSlashBefore;
		ctx.ui.addAutocompleteProvider((current) => {
			const provider = wrapAutocomplete(current as AutocompleteProviderLike);
			shared.names = extractNames((current as AutocompleteProviderLike).commands);
			return provider;
		});
		// /reload 后 pi 可能恢复默认编辑器,这里幂等重挂
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new HapiSlashEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			editor.slashColorize = (line) => colorizeLine(line, shared.names, theme.selectList.description);
			return editor;
		});
	};

	pi.on("session_start", (_event, ctx) => setup(ctx));
}
