/**
 * sessions.ts — 只读扫描各 hapilon home 的 agent/sessions，产出「会话级样本」
 *
 * 全部指标都取自会话 JSONL 自身，不额外落盘、不改动会话文件：
 *   - usage：每条 assistant 消息都带 output/input 与 cost（含金额）
 *   - 载体形状：toolCall.arguments（edit 的 edits[].newText、write 的 content）
 *   - ponytail 档位：session 内的 ponytail-mode 记录（只有用户切过档才有）
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionSample {
  /** 会话文件绝对路径 */
  file: string;
  /** 来自哪个 hapilon home（多 home 隔离时用来看数据来源） */
  home: string;
  /** 会话工作目录 */
  project: string;
  startedAt: string;
  /** ponytail 档位：session 内记录优先，缺失则按默认推测 */
  ponytail: string;
  ponytailSource: "session" | "assumed";
  models: string[];
  assistantMessages: number;
  outputTokens: number;
  inputTokens: number;
  costUsd: number;
  /** assistant 的可见正文（不含 thinking）字符数 */
  proseChars: number;
  /** edit/write 的写入载荷字符数（edits[].newText + content） */
  codeChars: number;
  editCalls: number;
  writeCalls: number;
  /** 被 edit/write 触及的不同文件数 */
  filesTouched: number;
  bashCalls: number;
  subagentCalls: number;
  backgroundCalls: number;
}

/** 需要统计的工具名 → 归类 */
const SUBAGENT_TOOLS = new Set(["Agent", "TaskExecute", "SubagentWorkflow"]);
const BACKGROUND_TOOLS = new Set(["background", "monitor"]);

/** 扫描范围：~ 下所有 .hapilon* home（dev/prod 都收） */
export function hapilonHomes(homeDir: string = homedir()): string[] {
  try {
    return readdirSync(homeDir)
      .filter((name) => name.startsWith(".hapilon"))
      .map((name) => join(homeDir, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory() && existsSync(join(path, "agent", "sessions"));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** 枚举某 home 下的会话文件 */
export function listSessionFiles(home: string): string[] {
  const root = join(home, "agent", "sessions");
  const files: string[] = [];
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of readdirSync(dirPath)) {
      if (name.endsWith(".jsonl")) files.push(join(dirPath, name));
    }
  }
  return files;
}

interface PonytailInfo {
  mode: string;
  source: "session" | "assumed";
}

/** 会话内的 ponytail-mode 记录：一条档位；多条不同档位 = 中途切过，标 mixed */
function ponytailFromEntries(entries: string[]): PonytailInfo | undefined {
  const modes = new Set<string>();
  for (const line of entries) {
    if (!line.includes("ponytail-mode")) continue;
    try {
      const record = JSON.parse(line) as { type?: string; customType?: string; data?: { mode?: unknown } };
      if (record.type !== "custom" || record.customType !== "ponytail-mode") continue;
      const mode = record.data?.mode;
      if (typeof mode === "string" && mode.length > 0) modes.add(mode.toLowerCase());
    } catch {
      // 半截行/损坏行跳过：统计工具不该因为一行损坏而整体失败
    }
  }
  if (modes.size === 0) return undefined;
  return { mode: modes.size === 1 ? [...modes][0]! : "mixed", source: "session" };
}

/**
 * ponytail 默认档位（会话内没有切换记录时用于标注）。
 * 与 ponytail 自身的解析顺序一致：env → 全局 config.json → full。
 * 注意：全局配置的**历史变更**不可见，所以这部分只能标 "assumed"。
 */
export function resolvePonytailDefault(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
  platform: string = process.platform,
): { mode: string; source: "assumed" } {
  const fromEnv = env.PONYTAIL_DEFAULT_MODE?.toLowerCase();
  if (fromEnv === "off" || fromEnv === "lite" || fromEnv === "full" || fromEnv === "ultra") {
    return { mode: fromEnv, source: "assumed" };
  }
  const configDir = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "ponytail")
    : platform === "win32"
      ? join(env.APPDATA ?? join(homeDir, "AppData", "Roaming"), "ponytail")
      : join(homeDir, ".config", "ponytail");
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8").replace(/^\uFEFF/, "")) as {
      defaultMode?: unknown;
    };
    const mode = typeof parsed.defaultMode === "string" ? parsed.defaultMode.toLowerCase() : undefined;
    if (mode === "off" || mode === "lite" || mode === "full" || mode === "ultra") return { mode, source: "assumed" };
  } catch {
    // 配置文件不存在或损坏 → 落到内置默认
  }
  return { mode: "full", source: "assumed" };
}

function textChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    const item = part as { type?: string; text?: unknown };
    if (item?.type === "text" && typeof item.text === "string") total += item.text.length;
  }
  return total;
}

function editPayloadChars(args: unknown): number {
  const edits = (args as { edits?: unknown })?.edits;
  if (!Array.isArray(edits)) return 0;
  let total = 0;
  for (const edit of edits) {
    const newText = (edit as { newText?: unknown })?.newText;
    if (typeof newText === "string") total += newText.length;
  }
  return total;
}

/** 解析单个会话文件；内容不可读或没有 session 记录时返回 undefined */
export function parseSession(file: string, home: string, fallbackPonytail: PonytailInfo): SessionSample | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  const sample: SessionSample = {
    file,
    home,
    project: "",
    startedAt: "",
    ponytail: fallbackPonytail.mode,
    ponytailSource: fallbackPonytail.source,
    models: [],
    assistantMessages: 0,
    outputTokens: 0,
    inputTokens: 0,
    costUsd: 0,
    proseChars: 0,
    codeChars: 0,
    editCalls: 0,
    writeCalls: 0,
    filesTouched: 0,
    bashCalls: 0,
    subagentCalls: 0,
    backgroundCalls: 0,
  };
  const models = new Set<string>();
  const files = new Set<string>();
  let resolvedPonytail: PonytailInfo | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === "session") {
      if (typeof record.cwd === "string") sample.project = record.cwd;
      if (typeof record.timestamp === "string") sample.startedAt = record.timestamp;
      continue;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") continue;

    sample.assistantMessages++;
    sample.proseChars += textChars(message.content);
    if (typeof message.model === "string") models.add(message.model);
    const usage = message.usage as
      | { output?: unknown; input?: unknown; cost?: { total?: unknown } }
      | undefined;
    if (typeof usage?.output === "number") sample.outputTokens += usage.output;
    if (typeof usage?.input === "number") sample.inputTokens += usage.input;
    if (typeof usage?.cost?.total === "number") sample.costUsd += usage.cost.total;

    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const call = part as { type?: string; name?: string; arguments?: unknown };
      if (call?.type !== "toolCall" || typeof call.name !== "string") continue;
      const args = call.arguments ?? {};
      switch (call.name) {
        case "edit":
          sample.editCalls++;
          sample.codeChars += editPayloadChars(args);
          break;
        case "write":
          sample.writeCalls++;
          if (typeof (args as { content?: unknown }).content === "string") {
            sample.codeChars += (args as { content: string }).content.length;
          }
          break;
        case "bash":
          sample.bashCalls++;
          break;
        default:
          if (SUBAGENT_TOOLS.has(call.name)) sample.subagentCalls++;
          else if (BACKGROUND_TOOLS.has(call.name)) sample.backgroundCalls++;
      }
      const path = (args as { path?: unknown }).path;
      if ((call.name === "edit" || call.name === "write") && typeof path === "string") files.add(path);
    }
    if (!resolvedPonytail) {
      const info = ponytailFromEntries(lines);
      if (info) {
        resolvedPonytail = info;
        sample.ponytail = info.mode;
        sample.ponytailSource = info.source;
      }
    }
  }

  if (sample.assistantMessages === 0 && sample.startedAt === "") return undefined;
  sample.models = [...models];
  sample.filesTouched = files.size;
  return sample;
}

export interface LoadOptions {
  /** 只统计该时刻之后开始的会话 */
  sinceMs?: number;
  /** cwd 子串过滤 */
  project?: string;
  homeDir?: string;
  /** 测试注入：会话内没有切换记录时的默认档位 */
  ponytailDefault?: PonytailInfo;
}

/** 读全部 home，产出过滤后的样本 */
export function loadSamples(options: LoadOptions = {}): SessionSample[] {
  const fallbackPonytail = options.ponytailDefault ?? resolvePonytailDefault();
  const samples: SessionSample[] = [];
  for (const home of hapilonHomes(options.homeDir)) {
    for (const file of listSessionFiles(home)) {
      const sample = parseSession(file, home, fallbackPonytail);
      if (!sample) continue;
      if (options.sinceMs !== undefined) {
        const started = Date.parse(sample.startedAt);
        if (!Number.isFinite(started) || started < options.sinceMs) continue;
      }
      if (options.project && !sample.project.includes(options.project)) continue;
      samples.push(sample);
    }
  }
  return samples;
}
