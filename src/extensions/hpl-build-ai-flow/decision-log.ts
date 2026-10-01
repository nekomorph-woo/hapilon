/**
 * decision-log.ts — decision-log 的 lifecycle 解析
 *
 * 条目：D-001｜active｜内容｜日期［｜supersedes D-000[,D-00x]］
 * 事件：D-000｜superseded｜by D-001｜日期   /   D-000｜revoked｜原因｜日期
 * 旧格式状态字段「已拍板」视为 active（向后兼容）。历史不可丢；
 * 当前有效集合 = 无 superseded/revoked 事件、未被 supersedes 引用、且自身非终态的条目。
 * lifecycle 异常（引用不存在的编号、重复取代、未知状态）显式进 malformed，不静默猜测。
 */

export interface DecisionEntry {
  id: string;
  /** active | 已拍板(legacy→active) | superseded | revoked（条目自带终态也算终态） */
  status: string;
  content: string;
  date?: string;
  supersedes: string[];
  line: number;
}

export interface DecisionEvent {
  id: string;
  event: "superseded" | "revoked";
  by?: string;
  note?: string;
  line: number;
}

export interface ParsedDecisionLog {
  entries: DecisionEntry[];
  events: DecisionEvent[];
  /** 当前有效决定编号（升序） */
  activeIds: string[];
  /** lifecycle 异常描述，逐条给人看 */
  malformed: string[];
}

const STATUS_ACTIVE = new Set(["active", "已拍板"]);
const STATUS_TERMINAL = new Set(["superseded", "revoked"]);

function parseRefs(text: string): string[] {
  return [...text.matchAll(/D-\d+/g)].map((m) => m[0]!);
}

export function parseDecisionLog(log: string): ParsedDecisionLog {
  const entries: DecisionEntry[] = [];
  const events: DecisionEvent[] = [];
  const malformed: string[] = [];
  const seen = new Map<string, number>();

  for (const [i, raw] of log.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!/^D-\d+｜/.test(line)) continue; // 标题/空行等非条目内容不解析

    const parts = line.split("｜");
    const id = parts[0]!;
    const lineno = i + 1;
    if (parts.length < 4) {
      malformed.push(`第 ${lineno} 行 ${id}：字段不足 4 段（应为 编号｜状态｜内容｜日期）`);
      continue;
    }
    const [, status, content, date, ...rest] = parts;

    if (STATUS_TERMINAL.has(status)) {
      // 事件行：superseded 第三段是 by D-xxx；revoked 第三段是原因
      const event = status as "superseded" | "revoked";
      if (event === "superseded") {
        const by = rest.length > 0 ? parseRefs(rest.join("｜"))[0] ?? parseRefs(content)[0] : parseRefs(content)[0];
        if (!by) malformed.push(`第 ${lineno} 行 ${id}：superseded 事件缺 by D-xxx 指向`);
        events.push({ id, event, by, line: lineno });
      } else {
        events.push({ id, event, note: [content, ...rest].filter(Boolean).join("｜"), line: lineno });
      }
      continue;
    }

    if (!STATUS_ACTIVE.has(status)) {
      malformed.push(`第 ${lineno} 行 ${id}：未知状态「${status}」（合法 active / superseded / revoked；旧格式「已拍板」视为 active）`);
      continue;
    }
    if (seen.has(id)) {
      malformed.push(`第 ${lineno} 行 ${id}：编号重复（首次出现在第 ${seen.get(id)} 行）`);
      continue;
    }
    seen.set(id, lineno);
    entries.push({
      id,
      status,
      content,
      date,
      supersedes: rest.length > 0 ? parseRefs(rest.join("｜")) : [],
      line: lineno,
    });
  }

  // 引用校验 + active 集推导
  const entryIds = new Set(entries.map((e) => e.id));
  for (const e of entries) {
    for (const ref of e.supersedes) {
      if (!entryIds.has(ref)) malformed.push(`第 ${e.line} 行 ${e.id}：supersedes 指向不存在的 ${ref}`);
    }
  }
  const supersededByEvent = new Set(events.filter((e) => e.event === "superseded").map((e) => e.id));
  const revokedByEvent = new Set(events.filter((e) => e.event === "revoked").map((e) => e.id));
  for (const ev of events) {
    if (!entryIds.has(ev.id)) malformed.push(`第 ${ev.line} 行 ${ev.id}：事件指向不存在的条目`);
  }
  const referenced = new Set(entries.flatMap((e) => e.supersedes));
  const activeIds = entries
    .filter(
      (e) =>
        STATUS_ACTIVE.has(e.status) &&
        !supersededByEvent.has(e.id) &&
        !revokedByEvent.has(e.id) &&
        !referenced.has(e.id),
    )
    .map((e) => e.id)
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));

  return { entries, events, activeIds, malformed };
}
