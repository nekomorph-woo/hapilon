export interface RecapEntry {
  type: string;
  message?: unknown;
  summary?: string;
  content?: unknown;
}

export interface RecapUserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : String(content);
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as Record<string, unknown>;
    if (typeof item.text === "string") return item.text;
    if (typeof item.thinking === "string") return item.thinking;
    if (item.type === "toolCall") {
      const name = typeof item.name === "string" ? item.name : "tool";
      return `[${name}] ${typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})}`;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function entryText(entry: RecapEntry): string {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "message";
    return `${role}: ${contentText(message.content)}`;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return `summary: ${entry.summary ?? ""}`;
  }
  if (entry.type === "custom_message") {
    return `custom: ${contentText(entry.content)}`;
  }
  return "";
}

/** 将当前 branch 的最近条目压成一个 recap user message，严格保留尾部预算。 */
export function buildRecapMessages(
  entries: readonly RecapEntry[],
  maxContextChars: number,
  timestamp = Date.now(),
): RecapUserMessage[] {
  const budget = Math.max(1, Math.floor(maxContextChars));
  const text = entries.map(entryText).filter(Boolean).join("\n");
  if (!text) return [];
  return [{ role: "user", content: text.length > budget ? text.slice(-budget) : text, timestamp }];
}
