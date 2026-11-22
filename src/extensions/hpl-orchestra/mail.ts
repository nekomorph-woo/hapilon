/**
 * mail.ts — 团队信箱：每 pane 一个 JSONL 文件，发送方 append、接收方 drain。
 * 替代向目标 pane 输入框写文本+回车的 keystroke 通道：接收方忙时消息排队，
 * 回合结束自动送达，不再被拒。信箱目录与任务列表同层（teams 目录）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Data, Effect } from "effect";
import { teamsDir } from "./state.js";

export class MailError extends Data.TaggedError("MailError")<{
  message: string;
}> {}

export type MailKind = "done" | "decision" | "dispatch";

export interface MailMessage {
  id: string;
  /** 发送方 pane id */
  from: string;
  /** 接收方 pane id */
  to: string;
  kind: MailKind;
  /** 一行结论 */
  text: string;
  reportPath?: string;
}

const MAIL_KINDS: readonly MailKind[] = ["done", "decision", "dispatch"];

export function isMailMessage(value: unknown): value is MailMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  return typeof msg.id === "string"
    && typeof msg.from === "string"
    && typeof msg.to === "string"
    && typeof msg.kind === "string"
    && (MAIL_KINDS as readonly string[]).includes(msg.kind)
    && typeof msg.text === "string"
    && (msg.reportPath === undefined || typeof msg.reportPath === "string");
}

export function mailPath(storeKey: string, paneId: string): string {
  return join(teamsDir(), `${storeKey.replaceAll(":", "_")}.mail`, `${paneId.replaceAll(":", "_")}.jsonl`);
}

export function newMailId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** 单行小写入走 O_APPEND：多进程并发 append 不互相截断，一行一条完整 JSON。 */
export const postMail = (storeKey: string, msg: MailMessage): Effect.Effect<void, MailError> =>
  Effect.try({
    try: () => {
      const path = mailPath(storeKey, msg.to);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(msg)}\n`);
    },
    catch: (error) => new MailError({ message: `写信箱失败：${String(error)}` }),
  });

const readMailFile = (path: string): Effect.Effect<string | undefined, MailError> =>
  Effect.try({
    try: () => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    catch: (error) => new MailError({ message: `读信箱失败：${String(error)}` }),
  });

const rewriteMail = (path: string, remaining: readonly MailMessage[]): Effect.Effect<void, MailError> =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        remaining.map((msg) => JSON.stringify(msg)).join("\n") + (remaining.length > 0 ? "\n" : ""),
      );
    },
    catch: (error) => new MailError({ message: `重写信箱失败：${String(error)}` }),
  });

/**
 * 坏行（非 JSON / 缺字段）丢弃：信箱只收自家 postMail 的写入，坏行只可能是
 * 外部垃圾或半截崩溃残留，不投也不保留。
 */
function parseMailLines(raw: string): MailMessage[] {
  const messages: MailMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isMailMessage(parsed)) messages.push(parsed);
    } catch {
      // 坏行跳过
    }
  }
  return messages;
}

/**
 * 读尽 → 逐条 deliver → 全部成功则清空；首个失败立即停，文件重写为未投递
 * 剩余（含失败这条），下个 tick 重试。崩溃窗口选「最多重复」不选「可能丢失」。
 */
export const drainMail = (
  storeKey: string,
  paneId: string,
  deliver: (msg: MailMessage) => Effect.Effect<boolean, MailError>,
): Effect.Effect<void, MailError> =>
  Effect.gen(function* () {
    const path = mailPath(storeKey, paneId);
    const raw = yield* readMailFile(path);
    if (raw === undefined) return;
    const messages = parseMailLines(raw);
    if (messages.length === 0) {
      yield* rewriteMail(path, []);
      return;
    }
    for (let index = 0; index < messages.length; index++) {
      const delivered = yield* deliver(messages[index]!);
      if (!delivered) {
        yield* rewriteMail(path, messages.slice(index));
        return;
      }
    }
    yield* rewriteMail(path, []);
  });

/** 新会话启动清空：滞留邮件一律丢弃不做补投——收方上下文已换，旧邮件没有意义。 */
export const clearMail = (storeKey: string, paneId: string): Effect.Effect<void, MailError> =>
  Effect.try({
    try: () => {
      const path = mailPath(storeKey, paneId);
      if (existsSync(path)) writeFileSync(path, "");
    },
    catch: (error) => new MailError({ message: `清空信箱失败：${String(error)}` }),
  });
