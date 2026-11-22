/**
 * stack-expand.ts — /skill: 头部堆叠展开（纯逻辑，供 hpl-skills-discover 的 input hook 调用）
 *
 * pi 原生 _expandSkillCommand 只展开首个 /skill: token，后续按字面文本传给模型。
 * 这里把头部连续的多个 /skill: token 全部展开为 pi 原生 <skill> 块格式，
 * 尾部剩余文本作为公共参数。可解析 skill 不足 2 个时返回 null，
 * 交还 pi 原生单展开，保持既有行为不变。
 */

import { dirname } from "node:path";

export interface ResolvedSkill {
  /** SKILL.md 绝对路径 */
  filePath: string;
  /** 去掉 frontmatter 并 trim 的正文 */
  body: string;
}

/** 头部堆叠上限：hapilon skill 单体大（整篇 playbook），3 个已近千行指令 */
export const MAX_STACK = 3;

/** 与 pi 技能名规范一致：小写字母/数字/连字符 */
const SKILL_TOKEN_RE = /^\/skill:([a-z0-9-]+)$/;

/** herdr hc send 派送的消息带 <hc from="…"> 包裹，需穿透后展开内层 */
const HC_WRAP_RE = /^(<hc from="[^"]*">)([\s\S]*)(<\/hc>)$/;

/**
 * 展开 /skill: 堆叠输入（自动穿透 herdr 的 <hc from="…"> 包裹，展开后重新包回）。
 * 返回完整替换文本；不满足堆叠条件（非 /skill: 开头、可解析 skill 少于 2 个）返回 null。
 * resolve 返回 null 表示名字不可解析，游走在那个 token 处停止，其后全部算尾部参数。
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

function expandInner(
  text: string,
  resolve: (name: string) => ResolvedSkill | null,
): string | null {
  if (!text.startsWith("/skill:")) return null;

  const blocks: string[] = [];
  const seen = new Set<string>();
  let tailStart = text.length;

  const tokens = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(text)) !== null) {
    const skillMatch = SKILL_TOKEN_RE.exec(m[0]);
    if (!skillMatch) {
      tailStart = m.index;
      break;
    }
    const name = skillMatch[1];
    const skill = resolve(name);
    if (!skill) {
      tailStart = m.index;
      break;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    blocks.push(
      `<skill name="${name}" location="${skill.filePath}">\n` +
        `References are relative to ${dirname(skill.filePath)}.\n\n` +
        `${skill.body}\n</skill>`,
    );
    tailStart = m.index + m[0].length;
    if (blocks.length >= MAX_STACK) break;
  }

  if (blocks.length < 2) return null;
  const tail = text.slice(tailStart).trim();
  return tail ? `${blocks.join("\n\n")}\n\n${tail}` : blocks.join("\n\n");
}
