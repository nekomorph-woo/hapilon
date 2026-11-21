/**
 * hpl-editor-slash 的纯逻辑:中段 slash 补全 wrapper 与编辑器染色。
 * 全部函数无副作用,便于单测;pi 交互面(ExtensionAPI)只在 index.ts。
 */

/** CombinedAutocompleteProvider 里 commands 的成员形状(built-in SlashCommand 或普通 item) */
export interface CommandEntryLike {
	name?: string;
	value?: string;
	label?: string;
	description?: string;
	argumentHint?: string;
}

export interface SuggestionItem {
	value: string;
	label: string;
	description?: string;
}

export interface Suggestions {
	items: SuggestionItem[];
	prefix: string;
}

export interface AutocompleteProviderLike {
	commands?: CommandEntryLike[];
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<Suggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: SuggestionItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/** 光标前文本是否处于中段 slash 片段(与补全建议同一判定,供 editor 触发门钩子用) */
export function isMidTextSlashBefore(before: string): boolean {
	return /(?:^|\s)\/[\w:.:-]*$/.test(before);
}

/** 光标前文本的中段 slash 片段(须以行首或空白为界,避免劫持 URL 与路径) */
export function midTextSlashFragment(line: string, cursorCol: number): string | null {
	const before = line.slice(0, cursorCol);
	const match = /(?:^|\s)\/([\w:.:-]*)$/.exec(before);
	return match ? match[1] : null;
}

export function extractNames(commands: CommandEntryLike[] | undefined): Set<string> {
	const names = new Set<string>();
	for (const entry of commands ?? []) {
		// pi 侧数组可能有空洞/空槽（内置命令表被补丁移除条目时留下 elision）——跳过
		if (entry === null || entry === undefined) continue;
		const name = entry.name ?? entry.value;
		if (name) names.add(name);
	}
	return names;
}

/**
 * 包装内置 provider:中段 slash 片段(空白为界)借道内置行首分支 —— 把片段改写到
 * 行首后委托(force:false 触发其自然路径)，模糊命中、skill 裸名、参数提示与行首
 * 完全同语义，不用本地过滤重造一套；行首/其余场景原样委托。落词仍由本 wrapper
 * 接住中段命令(内置按 beforePrefix 判行首会拒掉)。
 */
export function wrapAutocomplete(current: AutocompleteProviderLike): AutocompleteProviderLike {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const fragment = midTextSlashFragment(line, cursorCol);
			const slashIndex = fragment === null ? -1 : cursorCol - fragment.length - 1;
			if (fragment === null || slashIndex === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const doctored = [...lines];
			doctored[cursorLine] = `/${fragment}`;
			return current.getSuggestions(doctored, cursorLine, fragment.length + 1, {
				signal: options.signal,
				force: false,
			});
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const beforePrefix = line.slice(0, cursorCol - prefix.length);
			// 内置会处理的场景(行首命令、@文件、含路径分隔)全部委托;
			// 这里只接住内置拒掉的中段命令补全。公式与内置 slash 分支一致。
			const midTextCommand = prefix.startsWith("/")
				&& !prefix.slice(1).includes("/")
				&& beforePrefix.trim() !== "";
			if (!midTextCommand) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const afterCursor = line.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2,
			};
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	};
}

/**
 * 给渲染行中的已知命令 token 上色。按 ANSI 转义分段后只处理纯文本段:
 * 光标反显区不受影响;被光标切开的不完整 token 本帧不染色(纯视觉,可接受)。
 * 只包裹可见字符,零宽不破坏 Editor 的 padding/可见宽度计算。
 */
export function colorizeLine(line: string, names: Set<string>, style: (text: string) => string): string {
	if (!line.includes("/") || names.size === 0) return line;
	const parts = line.split(/(\x1b\[[0-9;]*m)/);
	return parts
		.map((part, index) => {
			if (index % 2 === 1) return part;
			return part.replace(
				/(^|[^\w/])\/([\w][\w:.:-]*)/g,
				(full, boundary: string, word: string) => {
					if (!names.has(word)) return full;
					return boundary + style(`/${word}`);
				},
			);
		})
		.join("");
}
