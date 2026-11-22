/**
 * stack-expand.ts — /skill: 多技能展开（纯逻辑，供 hpl-skills-discover 的 input hook 调用）
 *
 * pi 原生只展开位于输入开头的单个 /skill: token 且原位挖空，其余按字面文本传给模型。
 * 这里接管所有位置的 /skill: token——标准格式本身就是调用指令，出现即展开；
 * 口头提及不会长成这个格式，无需防误触发。所有已展开 token 在原位留 [skill:name]
 * 占位符，块统一置于输出前部，指令位置与正文都保持可读。
 */
import { dirname } from "node:path";
/** 展开上限：hapilon skill 单体大（整篇 playbook），3 个已近千行指令 */
export const MAX_STACK = 3;
/** 与 pi 技能名规范一致：小写字母/数字/连字符 */
const SKILL_TOKEN_RE = /^\/skill:([a-z0-9-]+)$/;
/** herdr hc send 派送的消息带 <hc from="…"> 包裹，需穿透后展开内层 */
const HC_WRAP_RE = /^(<hc from="[^"]*">)([\s\S]*)(<\/hc>)$/;
/**
 * 展开输入中的 /skill: token（自动穿透 herdr 的 <hc from="…"> 包裹，展开后重新包回）。
 * 可解析 token 依出现顺序展开为 pi 原生格式的 <skill> 块置于输出前部，原位留 [skill:name]。
 * 未知名、重复名（第二次起）、超上限的 token：未知名与超上限按字面保留，重复名原位占位。
 * 无任何可解析 token 时返回 null，交还 pi 原生流程。
 */
export function expandSkillStack(text, resolve) {
    const wrap = HC_WRAP_RE.exec(text);
    const inner = wrap ? wrap[2] : text;
    const expanded = expandInner(inner, resolve);
    if (expanded === null)
        return null;
    return wrap ? `${wrap[1]}${expanded}${wrap[3]}` : expanded;
}
function formatBlock(name, skill) {
    return (`<skill name="${name}" location="${skill.filePath}">\n` +
        `References are relative to ${dirname(skill.filePath)}.\n\n` +
        `${skill.body}\n</skill>`);
}
function expandInner(text, resolve) {
    const re = /\S+/g;
    const blocks = [];
    const seen = new Set();
    const prose = [];
    let prev = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const gap = text.slice(prev, m.index);
        prev = m.index + m[0].length;
        const name = SKILL_TOKEN_RE.exec(m[0])?.[1];
        const skill = name === undefined ? null : resolve(name);
        if (name === undefined || skill === null || blocks.length >= MAX_STACK) {
            prose.push(gap + m[0]); // 普通词、未知名、超上限：按字面保留
        }
        else if (seen.has(name)) {
            prose.push(gap + `[skill:${name}]`); // 重复名只展开首次，原位占位
        }
        else {
            seen.add(name);
            blocks.push(formatBlock(name, skill));
            prose.push(gap + `[skill:${name}]`); // 原位占位，块统一放上方
        }
    }
    prose.push(text.slice(prev));
    if (blocks.length === 0)
        return null;
    return `${blocks.join("\n\n")}\n\n${prose.join("").trim()}`;
}
