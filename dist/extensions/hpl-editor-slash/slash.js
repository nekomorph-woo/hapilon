/**
 * hpl-editor-slash 的纯逻辑:中段 slash 补全 wrapper 与编辑器染色。
 * 全部函数无副作用,便于单测;pi 交互面(ExtensionAPI)只在 index.ts。
 */
/** 光标前文本是否处于中段 slash 片段(与补全建议同一判定,供 editor 触发门钩子用) */
export function isMidTextSlashBefore(before) {
    return /(?:^|\s)\/[\w:.:-]*$/.test(before);
}
/** 光标前文本的中段 slash 片段(须以行首或空白为界,避免劫持 URL 与路径) */
export function midTextSlashFragment(line, cursorCol) {
    const before = line.slice(0, cursorCol);
    const match = /(?:^|\s)\/([\w:.:-]*)$/.exec(before);
    return match ? match[1] : null;
}
function toItem(entry) {
    if (typeof entry.value === "string") {
        return { value: entry.value, label: entry.label ?? entry.value, description: entry.description };
    }
    const name = entry.name ?? "";
    return {
        value: name,
        label: entry.argumentHint ? `${name} ${entry.argumentHint}` : entry.label ?? name,
        description: entry.description,
    };
}
export function extractNames(commands) {
    const names = new Set();
    for (const entry of commands ?? []) {
        const name = entry.name ?? entry.value;
        if (name)
            names.add(name);
    }
    return names;
}
/**
 * 包装内置 provider:中段 slash 片段(空白为界)命令优先 —— 内置会把它当路径
 * 返回文件建议(唯一中段门槛 beforePrefix.trim()==="" 挡不住路径分支);行首
 * 片段仍归内置(原行为不变),其余场景原样委托。
 */
export function wrapAutocomplete(current) {
    return {
        async getSuggestions(lines, cursorLine, cursorCol, options) {
            const fragment = midTextSlashFragment(lines[cursorLine] ?? "", cursorCol);
            const slashIndex = fragment === null ? -1 : cursorCol - fragment.length - 1;
            if (fragment === null || slashIndex === 0) {
                return current.getSuggestions(lines, cursorLine, cursorCol, options);
            }
            const query = fragment.toLowerCase();
            const items = (current.commands ?? [])
                .map(toItem)
                .filter((item) => item.value.toLowerCase().startsWith(query));
            return items.length > 0 ? { items, prefix: `/${fragment}` } : null;
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
export function colorizeLine(line, names, style) {
    if (!line.includes("/") || names.size === 0)
        return line;
    const parts = line.split(/(\x1b\[[0-9;]*m)/);
    return parts
        .map((part, index) => {
        if (index % 2 === 1)
            return part;
        return part.replace(/(^|[^\w/])\/([\w][\w:.:-]*)/g, (full, boundary, word) => {
            if (!names.has(word))
                return full;
            return boundary + style(`/${word}`);
        });
    })
        .join("");
}
