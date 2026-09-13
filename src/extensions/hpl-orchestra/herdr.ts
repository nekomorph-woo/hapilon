import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";

export type HerdrPane = {
  paneId: string;
  status?: string;
  /** herdr 识别到的 agent 名（"pi"/"claude"/...）；缺席 = 该 pane 当前没有 agent */
  agent?: string;
  /** herdr pane 标签（`herdr pane rename` 设置的那个，显示在 pane 边上） */
  label?: string;
};

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  message: string;
}> {}

type SpawnResult = {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

type SpawnOptions = { encoding: "utf8"; timeout?: number; killSignal?: NodeJS.Signals };

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => SpawnResult;

export const defaultSpawn: SpawnFn = spawnSync as unknown as SpawnFn;

/** 同步 herdr 调用的兜底超时：server 卡住时不无限阻塞 pi 事件循环 */
const SPAWN_TIMEOUT_MS = 10_000;

export function herdrEnvAvailable(): boolean {
  return process.env.HERDR_ENV === "1";
}

function outputText(value: string | Buffer | undefined): string {
  return value === undefined ? "" : value.toString();
}

function parseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function runJsonEffect(
  args: string[],
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<unknown | undefined, never> {
  return Effect.try({
    try: () => {
      const bin = process.env.HERDR_BIN_PATH ?? "herdr";
      const result = spawn(bin, args, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new HerdrError({ message: outputText(result.stderr) || `herdr exited with status ${result.status}` });
      }
      const parsed = parseJson(outputText(result.stdout));
      if (parsed === undefined) throw new HerdrError({ message: "herdr returned invalid JSON" });
      return parsed;
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) => Effect.sync(() => {
      console.warn(`[hpl-orchestra] herdr ${args.join(" ")} 失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    })),
  );
}

function runTextEffect(
  args: string[],
  spawn: SpawnFn = defaultSpawn,
  timeoutMs?: number,
): Effect.Effect<string | undefined, never> {
  return Effect.try({
    try: () => {
      const bin = process.env.HERDR_BIN_PATH ?? "herdr";
      const result = spawn(bin, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new HerdrError({ message: outputText(result.stderr) || `herdr exited with status ${result.status}` });
      }
      return outputText(result.stdout);
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) => Effect.sync(() => {
      console.warn(`[hpl-orchestra] herdr ${args.join(" ")} 失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    })),
  );
}

function runCommandEffect(
  args: string[],
  spawn: SpawnFn = defaultSpawn,
  timeoutMs?: number,
): Effect.Effect<boolean, never> {
  return Effect.map(runTextEffect(args, spawn, timeoutMs), (text) => text !== undefined);
}

function findRecord(value: unknown, predicate: (record: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecord(item, predicate);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (predicate(record)) return record;
  for (const child of Object.values(record)) {
    const found = findRecord(child, predicate);
    if (found) return found;
  }
  return undefined;
}

export function paneGet(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<HerdrPane | undefined, never> {
  return Effect.map(runJsonEffect(["pane", "get", paneId], spawn), (raw) => {
    const pane = findRecord(raw, (record) => typeof record.pane_id === "string")
      ?? findRecord(raw, (record) => typeof record.id === "string" && ("status" in record || "state" in record));
    if (!pane) return undefined;
    const id = typeof pane.pane_id === "string" ? pane.pane_id : String(pane.id);
    const status = typeof pane.status === "string" ? pane.status : undefined;
    const agent = typeof pane.agent === "string" ? pane.agent : undefined;
    const label = typeof pane.label === "string" && pane.label.length > 0 ? pane.label : undefined;
    return { paneId: id, status, ...(agent ? { agent } : {}), ...(label ? { label } : {}) };
  });
}

/** 给 pane 打/换 herdr 标签（显示在 pane 边框上，用于分辨角色） */
export function paneRename(
  paneId: string,
  label: string,
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<boolean, never> {
  return runCommandEffect(["pane", "rename", paneId, label], spawn);
}

/**
 * pane 里是否还有前台进程（跑在 shell 之上的 agent）。agent 字段尚未上报的启动窗口
 * 只能靠这个信号：
 * pi 已经在跑 → 前台进程不是 shell → true；pi 已崩、只剩 shell 提示符 → false。
 */
export function paneForegroundBusy(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<boolean, never> {
  return Effect.map(runJsonEffect(["pane", "process-info", "--pane", paneId], spawn), (raw) => {
    const info = findRecord(raw, (record) => "shell_pid" in record || "foreground_processes" in record);
    if (!info) return false;
    const shellPid = typeof info.shell_pid === "number" ? info.shell_pid : undefined;
    const foreground = info.foreground_processes;
    if (Array.isArray(foreground) && foreground.length > 0) {
      return foreground.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const pid = (entry as Record<string, unknown>).pid;
        return shellPid === undefined || (typeof pid === "number" && pid !== shellPid);
      });
    }
    const pgid = typeof info.foreground_process_group_id === "number" ? info.foreground_process_group_id : undefined;
    return pgid !== undefined && shellPid !== undefined && pgid !== shellPid;
  });
}

/**
 * 角色 pane 的存活判定：pane 在，且里面还有 agent。
 * 只看 pane 存不存在会把「pi 崩了、只剩 shell」误判为健康——主 agent 会照旧往空 shell 派发。
 */
export function paneAgentAlive(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const pane = yield* paneGet(paneId, spawn);
    if (!pane) return false;
    if (pane.agent !== undefined) return true;
    return yield* paneForegroundBusy(paneId, spawn);
  });
}

export function agentGet(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<AgentStatus, never> {
  // herdr api schema 的 AgentInfo 字段是 agent_status（无 status/state）；
  // 同时按 pane_id 匹配，防止 findRecord 命中嵌套的其它记录。
  return Effect.map(runJsonEffect(["agent", "get", paneId], spawn), (raw) => {
    const agent = findRecord(raw, (record) =>
      typeof record.agent_status === "string" && record.pane_id === paneId);
    const rawStatus = agent?.agent_status;
    if (typeof rawStatus !== "string") return "unknown";
    const normalized = rawStatus.toLowerCase();
    if (normalized === "idle") return "idle";
    if (normalized === "working" || normalized === "running") return "working";
    if (normalized === "blocked") return "blocked";
    if (normalized === "done" || normalized === "completed" || normalized === "complete") return "done";
    return "unknown";
  });
}

export function paneSplit(
  cwd: string,
  spawn: SpawnFn = defaultSpawn,
  envArgs: string[] = [],
  options: { target?: string; direction?: "right" | "down" } = {},
): Effect.Effect<string | undefined, never> {
  // 默认 --current 固定到调用面板（herdr skill 要求，不依赖对端聚焦面板）；
  // 指定 target 时改为在目标 pane 上切（布局决定了角色 pane 要叠在右列）
  const anchor = options.target ? ["--pane", options.target] : ["--current"];
  return Effect.map(
    runJsonEffect(
      ["pane", "split", ...anchor, "--direction", options.direction ?? "right", ...envArgs, "--cwd", cwd, "--no-focus"],
      spawn,
    ),
    (raw) => {
      const pane = findRecord(raw, (record) => typeof record.pane_id === "string");
      return typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
    },
  );
}

/** 同 tab 各 pane 的显示宽度（`herdr pane layout`）；用于判断右列还能不能塞下新面板 */
export function paneWidths(spawn: SpawnFn = defaultSpawn): Effect.Effect<Map<string, number>, never> {
  return Effect.map(runJsonEffect(["pane", "layout"], spawn), (raw) => {
    const widths = new Map<string, number>();
    const layout = findRecord(raw, (record) => Array.isArray(record.panes));
    const panes = layout?.panes;
    if (!Array.isArray(panes)) return widths;
    for (const pane of panes) {
      if (!pane || typeof pane !== "object") continue;
      const record = pane as Record<string, unknown>;
      const rect = record.rect as Record<string, unknown> | undefined;
      if (typeof record.pane_id === "string" && rect && typeof rect.width === "number") {
        widths.set(record.pane_id, rect.width);
      }
    }
    return widths;
  });
}

export function paneRun(paneId: string, command: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<boolean, never> {
  return runCommandEffect(["pane", "run", paneId, command], spawn, SPAWN_TIMEOUT_MS);
}

/**
 * pane 当前屏文本（agent 状态判定用）。herdr pane read 只输出纯文本，无 JSON 外壳；
 * 读取失败返回 undefined（调用方按「采样失败」保守处理）。
 */
export function paneRead(
  paneId: string,
  spawn: SpawnFn = defaultSpawn,
  options: { source?: "visible" | "recent" | "recent-unwrapped" | "detection"; lines?: number } = {},
): Effect.Effect<string | undefined, never> {
  const args = ["pane", "read", paneId, "--source", options.source ?? "visible", "--lines", String(options.lines ?? 40)];
  return runTextEffect(args, spawn, SPAWN_TIMEOUT_MS);
}

export function agentSendKeys(
  paneId: string,
  keys: readonly string[],
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<boolean, never> {
  return runCommandEffect(["agent", "send-keys", paneId, ...keys], spawn);
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * hapilon 自身入口的绝对路径。扩展跑在 pi 子进程里，process.argv[1] 是
 * pi 的 cli.js 而非 hapilon 入口（review P0 #1），因此入口路径由 startup.ts
 * 经 HAPILON_CLI_PATH 注入；无值时降级 argv[1] 并告警。
 */
export function hapilonCliPath(): string | undefined {
  const injected = process.env.HAPILON_CLI_PATH;
  if (injected && isAbsolute(injected)) return injected;
  const script = process.argv[1] && isAbsolute(process.argv[1])
    ? process.argv[1]
    : resolve(process.cwd(), process.argv[1] ?? "");
  if (injected) return resolve(process.cwd(), injected);
  console.warn("[hpl-orchestra] HAPILON_CLI_PATH 未注入，降级用 argv[1]（可能不是 hapilon 入口）");
  return script;
}

export function buildPaneRunCommand(role: string, model?: string, promptFile?: string): string {
  const command = [process.execPath, shellArg(hapilonCliPath() ?? "UNKNOWN_HAPILON_CLI")];
  // role 随命令行走（hapilon 入口把 --team-role 转成 pi 子进程自身 env），
  // 不用 pane split --env：那会把 role 永久留进 pane shell，人工在该
  // shell 重启会被静默变回角色面板。
  if (role) command.push("--team-role", shellArg(role));
  if (promptFile) command.push("--team-role-prompt-file", shellArg(promptFile));
  if (model) command.push("--model", shellArg(model));
  return command.join(" ");
}

/** pane split 仅注入配置（HAPILON_HOME）；身份类变量一律走 paneRun 命令行。 */
export function paneSplitEnvArgs(): string[] {
  const home = process.env.HAPILON_HOME;
  return home ? ["--env", `HAPILON_HOME=${home}`] : [];
}

export type ModelTier = "opus" | "sonnet" | "haiku";

const TIER_ORDER: readonly ModelTier[] = ["opus", "sonnet", "haiku"];

export type ResolvedModel = { provider: string; id: string };

function readResolvedTierModels(): Record<ModelTier, ResolvedModel[]> {
  const path = join(hapilonHome(), "model-tiers-resolved.json");
  if (!existsSync(path)) return { opus: [], sonnet: [], haiku: [] };
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { opus: [], sonnet: [], haiku: [] };
  }
  const record = parsed as Record<string, unknown>;
  const result = { opus: [], sonnet: [], haiku: [] } as Record<ModelTier, ResolvedModel[]>;
  for (const tier of TIER_ORDER) {
    const models = record[tier];
    if (!Array.isArray(models)) continue;
    result[tier] = models.flatMap((model) => {
      if (!model || typeof model !== "object") return [];
      const candidate = model as Record<string, unknown>;
      return typeof candidate.provider === "string" && typeof candidate.id === "string"
        ? [{ provider: candidate.provider, id: candidate.id }]
        : [];
    });
  }
  return result;
}

function readResolvedTierModelsSafely(): Record<ModelTier, ResolvedModel[]> {
  return Effect.runSync(Effect.try({
    try: readResolvedTierModels,
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) => Effect.sync(() => {
      console.warn(`[hpl-orchestra] 读取 resolved model 失败：${error instanceof Error ? error.message : String(error)}`);
      return { opus: [], sonnet: [], haiku: [] } as Record<ModelTier, ResolvedModel[]>;
    })),
  ));
}

export function resolveTierModelByTier(tier: ModelTier): string | undefined {
  const first = readResolvedTierModelsSafely()[tier][0];
  return first ? modelKey(first) : undefined;
}

function modelKey(model: ResolvedModel): string {
  return `${model.provider}/${model.id}`;
}

/** 首个非空档位的首选模型（opus → sonnet → haiku），全空时 undefined。 */
function fallbackModel(tiers: Record<ModelTier, ResolvedModel[]>): string | undefined {
  for (const tier of TIER_ORDER) {
    const first = tiers[tier][0];
    if (first) return modelKey(first);
  }
  return undefined;
}

function warnAndFallback(tiers: Record<ModelTier, ResolvedModel[]>, reason: string): string | undefined {
  const fallback = fallbackModel(tiers);
  console.warn(`[hpl-orchestra] ${reason}，回落 ${fallback ?? "pi 默认模型"}`);
  return fallback;
}

const TIER_REFERENCE = /^tier:(opus|sonnet|haiku)(?:\[(\d+)\])?$/;

/**
 * roles.<role>.model 在 spawn 时现解析：tier:<name>[<index>] 查当前档位表；
 * 具体 provider/id 命中任一档位即原样使用；过期 id、拼写错误、非法/越界指代
 * 回落到首个非空档位的首选。使创建时写死的模型名自动跟上档位配置变更。
 */
export function resolveRoleModel(
  spec: string | null | undefined,
  tiers: Record<ModelTier, ResolvedModel[]> = readResolvedTierModelsSafely(),
): string | undefined {
  const wanted = spec?.trim();
  if (!wanted) return undefined;

  const reference = TIER_REFERENCE.exec(wanted);
  if (reference) {
    const tier = reference[1] as ModelTier;
    const index = reference[2] === undefined ? 0 : Number(reference[2]);
    const model = tiers[tier][index];
    if (model) return modelKey(model);
    return warnAndFallback(tiers, `模型指代 ${wanted} 解析失败（${tier} 档共 ${tiers[tier].length} 个模型）`);
  }

  if (wanted.startsWith("tier:")) {
    return warnAndFallback(tiers, `模型指代 ${wanted} 格式非法（应为 tier:<opus|sonnet|haiku>[<index>]）`);
  }

  if (TIER_ORDER.some((tier) => tiers[tier].some((model) => modelKey(model) === wanted))) return wanted;

  return warnAndFallback(tiers, `模型 ${wanted} 不在任何档位（可能已过期或拼写错误）`);
}

/** 为讨论成员优先挑选与主面板不同 provider 的 opus 模型。 */
export function resolveDiscussantModel(ownerProvider: string | undefined): string | undefined {
  const models = readResolvedTierModelsSafely().opus;
  if (models.length === 0) return undefined;
  const heterogeneous = models.filter((model) => model.provider !== ownerProvider);
  const selected = heterogeneous[0] ?? models[1] ?? models[0];
  return `${selected.provider}/${selected.id}`;
}
