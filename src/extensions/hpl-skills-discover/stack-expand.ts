/**
 * stack-expand.ts — /skill: 多技能展开（纯逻辑，供 hpl-skills-discover 的 input hook 调用）
 *
 * pi 原生只展开位于输入开头的单个 /skill: token，其余按字面文本传给模型。
 * 这里接管两类场景：头部堆叠多个，以及写在输入任意位置的 /skill: token——
 * 标准格式本身就是调用指令，出现即展开；口头提及不会长成这个格式，无需防误触发。
 * 开头恰好单个可解析 token 时仍返回 null 交还 pi 原生，保持既有行为不变。
 */

import { dirname } from "node:path";

export interface ResolvedSkill {
  /** SKILL.md 绝对路径 */
  filePath: string;
  /** 去掉 frontmatter 并 trim 的正文 */
  body: string;
}

/** 展开上限：hapilon skill 单体大（整篇 playbook），3 个已近千行指令 */
export const MAX_STACK = 3;

/** 与 pi 技能名规范一致：小写字母/数字/连字符 */
const SKILL_TOKEN_RE = /^\/skill:([a-z0-9-]+)$/;

/** herdr hc send 派送的消息带 <hc from="…"> 包裹，需穿透后展开内层 */
const HC_WRAP_RE = /^(<hc from="[^"]*">)([\s\S]*)(<\/hc>)$/;

/**
 * 展开输入中的 /skill: token（自动穿透 herdr 的 <hc from="…"> 包裹，展开后重新包回）。
 * 可解析 token 依出现顺序展开为 pi 原生 <skill> 块置于输出前部，其余文本按原顺序拼为尾部。
 * 未知名、重复名（第二次起）、超上限的 token 按字面保留。
 * 返回 null 的情况：无任何可解析 token，或开头恰好单个且别处没有（pi 原生单展开接管）。
 */
export function expandSkillStack(
  text: string,
  resolve: (name: string) => ResolvedSkill | null,
): string | null {
  const wrap = HC_WRAP_RE.exec(text);
  const inner = wrap ? wrap[2] : text;
  const expanded = expandInner(inner, resolve);
  if (expanded === null) return null;
  return wrap ? `${wrap[1]}${expanded}${wrap[3]}` : expanded;
}

function formatBlock(name: string, skill: ResolvedSkill): string {
  return (
    `<skill name="${name}" location="${skill.filePath}">\n` +
    `References are relative to ${dirname(skill.filePath)}.\n\n` +
    `${skill.body}\n</skill>`
  );
}

function expandInner(
  text: string,
  resolve: (name: string) => ResolvedSkill | null,
): string | null {
  const re = /\S+/g;
  const blocks: string[] = [];
  const seen = new Set<string>();
  const prose: string[] = [];
  let headBlocks = 0;
  let otherBlocks = 0;
  let headEnded = false;
  let prev = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const gap = text.slice(prev, m.index);
    prev = m.index + m[0].length;
    const name = SKILL_TOKEN_RE.exec(m[0])?.[1];
    const skill = name === undefined ? null : resolve(name);
    if (name === undefined || skill === null) {
      headEnded = true;
      prose.push(gap + m[0]);
    } else if (seen.has(name)) {
      prose.push(gap); // 重复名只展开首次，token 本身消化掉
    } else if (blocks.length >= MAX_STACK) {
      headEnded = true;
      prose.push(gap + m[0]); // 超上限按字面保留
    } else {
      seen.add(name);
      blocks.push(formatBlock(name, skill));
      if (headEnded) otherBlocks += 1;
      else headBlocks += 1;
    }
  }
  prose.push(text.slice(prev));

  if (headBlocks === 1 && otherBlocks === 0) return null;
  if (blocks.length === 0) return null;
  const tail = prose.join("").trim();
  return tail ? `${blocks.join("\n\n")}\n\n${tail}` : blocks.join("\n\n");
}
