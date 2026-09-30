/**
 * skill-usage.ts — 从会话 JSONL 重放 skill 与命令的使用事件（只读，不落盘）。
 *
 * 三类信号（形态经真实会话文件验证）：
 *   explicit：/skill:xxx 触发时 user 消息 text 以 `<skill name="xxx" location="…">` 开头，
 *             `</skill>` 之后是用户原话参数（「干了什么」的事实层）。
 *   model   ：模型自动加载 = assistant 的 read toolCall，path 以 skills/<name>/SKILL.md 结尾。
 *             bash 命令里的 SKILL.md 字样与 system prompt 的 available_skills 列表是噪声，不算。
 *   command ：user 消息以 /cmd 开头的 slash 命令（含二级路径如 /ne/settings）。
 *             /skill: 前缀与「命令名与显式 skill 同名」的原始输入行都指向注入块，去重不计。
 *
 * 另采集 sessionPreview（每会话首条用户消息的前 72 字）作为自动加载事件的「当日正在办」线索。
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hapilonHomes, listSessionFiles } from "../sessions.js";
import { readExcludedSkills } from "./storage.js";

export type SkillSource = "explicit" | "model" | "command";
export type SkillOrigin = "builtin" | "user" | "project";

export interface SkillUsageEvent {
  /** 消息时间戳 ms */
  ts: number;
  skill: string;
  source: SkillSource;
  /** explicit/command：用户原话参数；model：空串 */
  args: string;
  /** 会话文件名（去 .jsonl） */
  session: string;
  /** 会话 cwd */
  project: string;
  origin: SkillOrigin;
  /** 会话首条用户消息前 72 字（「当日正在办」线索） */
  sessionPreview: string;
}

const SKILL_INJECT_RE = /^<skill name="([^"]+)" location="([^"]+)">/;
const SKILL_READ_RE = /\/skills\/([A-Za-z0-9_-]+)\/SKILL\.md$/;
const COMMAND_RE = /^\/(?!skill:)([a-z][a-z0-9:_/-]{1,40})(\s|$)/;
const COMMAND_LINE_MAX = 300;
const PREVIEW_MAX = 72;

export interface ParsedInjection {
  skill: string;
  location: string;
  args: string;
}

/** 解析 skill 注入 user 消息：`</skill>` 之后的文本是用户参数原话 */
export function parseSkillInjection(text: string): ParsedInjection | undefined {
  const match = SKILL_INJECT_RE.exec(text);
  if (!match) return undefined;
  const end = text.indexOf("</skill>");
  const args = end >= 0 ? text.slice(end + "</skill>".length).trim() : "";
  return { skill: match[1]!, location: match[2]!, args };
}

/** origin 按绝对路径判：home 下 agent/skills = 用户外置，项目 .pi/skills = 项目，其余 = 内置 */
export function originOf(location: string, home: string): SkillOrigin {
  if (location.startsWith(join(home, "agent", "skills") + "/")) return "user";
  if (location.includes("/.pi/skills/")) return "project";
  return "builtin";
}

/** 会话记录的时间戳：毫秒数字或 ISO 字符串，都收 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export interface ParsedCommand {
  name: string;
  skill: string;
  args: string;
}

/** 解析 slash 命令行：排除 skill 注入、路径粘贴（大写开头/超长行）与 /skill: 双计形态 */
export function parseCommandLine(text: string): ParsedCommand | undefined {
  if (text.startsWith('<skill name="') || text.length > COMMAND_LINE_MAX) return undefined;
  const match = COMMAND_RE.exec(text);
  if (!match) return undefined;
  const name = match[1].split("/")[0]!;
  return { name, skill: match[1], args: text.slice(match[0].length).trim() };
}

/** 会话首条非注入用户消息，压成单行截断——自动加载事件的「当日正在办」线索 */
export function firstUserPreview(lines: string[]): string {
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const text = (part as { type?: unknown; text?: unknown })?.text;
      if (typeof text !== "string" || text.startsWith('<skill name="')) continue;
      return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX);
    }
  }
  return "";
}

interface ReplayMeta {
  session: string;
  project: string;
  home: string;
}

/** 单会话重放：纯函数（lines 进、事件出），损坏行跳过 */
export function replaySession(lines: string[], meta: ReplayMeta): SkillUsageEvent[] {
  const events: SkillUsageEvent[] = [];
  const push = (event: Omit<SkillUsageEvent, "sessionPreview">, preview: string): void => {
    events.push({ ...event, sessionPreview: preview });
  };
  const preview = firstUserPreview(lines);
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const ts = parseTimestamp(record.timestamp);
    if (ts === undefined) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    if (message.role === "user") {
      for (const part of content) {
        const text = (part as { type?: unknown; text?: unknown })?.text;
        if (typeof text !== "string") continue;
        if (text.startsWith('<skill name="')) {
          const parsed = parseSkillInjection(text);
          if (parsed) {
            push({
              ts,
              skill: parsed.skill.toLowerCase(),
              source: "explicit",
              args: parsed.args,
              session: meta.session,
              project: meta.project,
              origin: originOf(parsed.location, meta.home),
            }, preview);
          }
          break;
        }
        const command = parseCommandLine(text);
        if (command) {
          push({
            ts,
            skill: command.skill.toLowerCase(),
            source: "command",
            args: command.args,
            session: meta.session,
            project: meta.project,
            origin: "builtin",
          }, preview);
        }
        break;
      }
      continue;
    }

    if (message.role !== "assistant") continue;
    for (const part of content) {
      const call = part as { type?: unknown; name?: unknown; arguments?: unknown };
      if (call?.type !== "toolCall" || call.name !== "read") continue;
      const path = (call.arguments as { path?: unknown } | undefined)?.path;
      if (typeof path !== "string") continue;
      const match = SKILL_READ_RE.exec(path);
      if (!match) continue;
      push({
        ts,
        skill: match[1]!.toLowerCase(),
        source: "model",
        args: "",
        session: meta.session,
        project: meta.project,
        origin: originOf(path, meta.home),
      }, preview);
    }
  }
  return events;
}

export interface LoadUsageOptions {
  homeDir?: string;
  excluded?: ReadonlySet<string>;
}

export interface SkillUsageLoad {
  /** 排除名单外的事件（主统计），按时间升序 */
  events: SkillUsageEvent[];
  /** 排除名单内的事件（自动型 skill，单独出报告） */
  excludedEvents: SkillUsageEvent[];
  /** 会话名 → 首条用户消息线索 */
  sessionPreviews: Record<string, string>;
}

/** 全 home 重放；排除名单分流，skill 命令的原始输入行与注入块去重 */
export function loadSkillUsage(options: LoadUsageOptions = {}): SkillUsageLoad {
  const excluded = options.excluded ?? readExcludedSkills();
  const events: SkillUsageEvent[] = [];
  const excludedEvents: SkillUsageEvent[] = [];
  const commandEvents: SkillUsageEvent[] = [];
  const sessionPreviews: Record<string, string> = {};

  for (const home of hapilonHomes(options.homeDir)) {
    for (const file of listSessionFiles(home)) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const session = basename(file, ".jsonl");
      const lines = raw.split("\n");
      const meta = { session, project: readSessionCwd(raw), home };
      sessionPreviews[session] = firstUserPreview(lines);
      for (const event of replaySession(lines, meta)) {
        if (event.source === "command") {
          commandEvents.push(event);
        } else if (excluded.has(event.skill)) {
          excludedEvents.push(event);
        } else {
          events.push(event);
        }
      }
    }
  }

  // /skill:x 与 /x 的原始输入行与注入块同源：命令名与显式 skill 同名时去重
  const explicitNames = new Set(events.filter(e => e.source === "explicit").map(e => e.skill));
  for (let i = commandEvents.length - 1; i >= 0; i--) {
    const name = commandEvents[i]!.skill.split("/")[0]!;
    if (explicitNames.has(name)) commandEvents.splice(i, 1);
  }

  events.push(...commandEvents);
  const byTs = (a: SkillUsageEvent, b: SkillUsageEvent): number => a.ts - b.ts;
  return {
    events: events.sort(byTs),
    excludedEvents: excludedEvents.sort(byTs),
    sessionPreviews,
  };
}

/** 会话 cwd 只在 session 记录里：扫描时先取一次，供每条事件共享 */
function readSessionCwd(raw: string): string {
  for (const line of raw.split("\n")) {
    if (!line.includes('"type":"session"') && !line.includes('"type": "session"')) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; cwd?: unknown };
      if (record.type === "session" && typeof record.cwd === "string") return record.cwd;
    } catch {
      continue;
    }
  }
  return "";
}
