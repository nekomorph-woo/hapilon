/**
 * argument-completion — 扩展 slash 命令的参数补全。
 *
 * pi 的补全由 registerCommand 的 getArgumentCompletions 回调提供（内置命令都挂了
 * 它，不挂则敲参数时无提示）。回调传入的是命令名之后、光标之前的整段参数文本，
 * 且选中候补后做整段替换——因此多词用法的候选要把 value 写成「替换后的完整合法
 * 文本」，搜索文本按用法全文设计。
 *
 * 匹配用 pi-tui 公开的 fuzzyFilter：按空格/斜杠拆 token 做子序列匹配，全部 token
 * 命中才算；query 为空返回全量，无命中返回 null（pi 约定 null = 无补全）。
 */
import { fuzzyFilter } from "@earendil-works/pi-tui";
export function argumentCompletions(candidates, query) {
    const hits = fuzzyFilter([...candidates], query, (c) => `${c.value} ${c.searchText ?? c.description ?? ""}`);
    return hits.length === 0 ? null : hits.map(({ searchText: _ignored, ...item }) => item);
}
