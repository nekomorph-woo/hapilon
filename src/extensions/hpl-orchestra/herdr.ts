import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { Data, Effect } from "effect";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";

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

function isHerdrNotFound(error: unknown): boolean {
  // herdr CLI 对不存在的 pane/agent 报 exit 1，stderr 是 {"error":{"code":"pane_not_found"}} 形 JSON
  const parsed = parseJson(error instanceof Error ? error.message : String(error));
  const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
  return code === "pane_not_found" || code === "agent_not_found";
}

function warnHerdrFailure(args: string[], error: unknown): void {
  console.warn(`[hpl-orchestra] herdr ${args.join(" ")} 失败：${error instanceof Error ? error.message : String(error)}`);
}

function runJsonRaw(args: string[], spawn: SpawnFn): Effect.Effect<unknown, unknown> {
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
  });
}

function runTextRaw(args: string[], spawn: SpawnFn, timeoutMs?: number): Effect.Effect<string, unknown> {
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
  });
}

function runJsonEffect(
  args: string[],
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<unknown | undefined, never> {
  return Effect.catchAll(runJsonRaw(args, spawn), (error) => Effect.sync(() => {
    // pane/agent 消失是常态（orchestrator 直接 pane close / 用户动手），不是故障，不刷屏
    if (!isHerdrNotFound(error)) warnHerdrFailure(args, error);
    return undefined;
  }));
}

function runTextEffect(
  args: string[],
  spawn: SpawnFn = defaultSpawn,
  timeoutMs?: number,
): Effect.Effect<string | undefined, never> {
  return Effect.catchAll(runTextRaw(args, spawn, timeoutMs), (error) => Effect.sync(() => {
    if (!isHerdrNotFound(error)) warnHerdrFailure(args, error);
    return undefined;
  }));
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

function parsePaneRecord(raw: unknown): HerdrPane | undefined {
  const pane = findRecord(raw, (record) => typeof record.pane_id === "string")
    ?? findRecord(raw, (record) => typeof record.id === "string" && ("status" in record || "state" in record));
  if (!pane) return undefined;
  const id = typeof pane.pane_id === "string" ? pane.pane_id : String(pane.id);
  const status = typeof pane.status === "string" ? pane.status : undefined;
  const agent = typeof pane.agent === "string" ? pane.agent : undefined;
  const label = typeof pane.label === "string" && pane.label.length > 0 ? pane.label : undefined;
  return { paneId: id, status, ...(agent ? { agent } : {}), ...(label ? { label } : {}) };
}

/**
 * pane 查询三态：HerdrPane = 查到；"missing" = herdr 明确报 pane 不存在（pane 已关，
 * 可放心剪枝）；undefined = 其它失败（herdr 不可用/超时/坏输出，瞬时性质，保守处理）。
 */
type PaneLookup = HerdrPane | "missing" | undefined;

function paneLookup(paneId: string, spawn: SpawnFn): Effect.Effect<PaneLookup, never> {
  return Effect.matchEffect(runJsonRaw(["pane", "get", paneId], spawn), {
    onSuccess: (raw) => Effect.succeed(parsePaneRecord(raw)),
    onFailure: (error) =>
      isHerdrNotFound(error)
        ? Effect.succeed<PaneLookup>("missing")
        : Effect.sync<PaneLookup>(() => {
            warnHerdrFailure(["pane", "get", paneId], error);
            return undefined;
          }),
  });
}

export function paneGet(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<HerdrPane | undefined, never> {
  return Effect.map(paneLookup(paneId, spawn), (lookup) => (lookup === "missing" ? undefined : lookup));
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
 * pane 探活三态，供「过滤 crew」与「剪枝花名册」区分处理：
 * alive = pane 在且里面有 agent（或前台进程忙）；missing = herdr 明确报 pane 已关；
 * unknown = pane 在但没 agent（pi 崩了剩 shell）或 herdr 瞬时失败——保守视为未知。
 */
export type PanePresence =
  | { readonly status: "alive"; readonly pane: HerdrPane }
  | { readonly status: "missing" }
  | { readonly status: "unknown" };

export function panePresence(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<PanePresence, never> {
  return Effect.gen(function* () {
    const lookup = yield* paneLookup(paneId, spawn);
    if (lookup === "missing") return { status: "missing" };
    if (!lookup) return { status: "unknown" };
    if (lookup.agent !== undefined) return { status: "alive", pane: lookup };
    return (yield* paneForegroundBusy(paneId, spawn))
      ? { status: "alive", pane: lookup }
      : { status: "unknown" };
  });
}

/**
 * 角色 pane 的存活判定：pane 在，且里面还有 agent。
 * 只看 pane 存不存在会把「pi 崩了、只剩 shell」误判为健康——主 agent 会照旧往空 shell 派发。
 */
export function paneAgentAlive(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<boolean, never> {
  return Effect.map(panePresence(paneId, spawn), (presence) => presence.status === "alive");
}

export interface AgentSnapshot {
  status: AgentStatus;
  /** herdr 的状态变更序号：只在状态真的变化时前进，用于表达「等状态变过」 */
  seq: number | undefined;
}

/** herdr api schema 的 AgentInfo 字段是 agent_status（无 status/state）；
 *  同时按 pane_id 匹配，防止 findRecord 命中嵌套的其它记录。 */
function agentRecord(raw: unknown, paneId: string): Record<string, unknown> | undefined {
  return findRecord(raw, (record) =>
    typeof record.agent_status === "string" && record.pane_id === paneId);
}

function normalizeAgentStatus(rawStatus: unknown): AgentStatus {
  if (typeof rawStatus !== "string") return "unknown";
  const normalized = rawStatus.toLowerCase();
  if (normalized === "idle") return "idle";
  if (normalized === "working" || normalized === "running") return "working";
  if (normalized === "blocked") return "blocked";
  if (normalized === "done" || normalized === "completed" || normalized === "complete") return "done";
  return "unknown";
}

export function agentStateWithSeq(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<AgentSnapshot, never> {
  return Effect.map(runJsonEffect(["agent", "get", paneId], spawn), (raw) => {
    const agent = agentRecord(raw, paneId);
    return {
      status: normalizeAgentStatus(agent?.agent_status),
      seq: typeof agent?.state_change_seq === "number" ? agent.state_change_seq : undefined,
    };
  });
}

export function agentGet(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<AgentStatus, never> {
  return Effect.map(agentStateWithSeq(paneId, spawn), (snapshot) => snapshot.status);
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

/**
 * 向 pane 注入按键。走 pane 级 CLI：自定义 agent 类型（如 hapi）下
 * `herdr agent send-keys` 会以 agent_not_ready 拒绝，pane 级始终可用。
 */
export function agentSendKeys(
  paneId: string,
  keys: readonly string[],
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<boolean, never> {
  return runCommandEffect(["pane", "send-keys", paneId, ...keys], spawn);
}

/** 向 pane 注入文本（不提交）；派发时配合 agentSendKeys(["enter"]) 完成 */
export function paneSendText(
  paneId: string,
  text: string,
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<boolean, never> {
  return runCommandEffect(["pane", "send-text", paneId, text], spawn);
}

export function agentPrompt(
  paneId: string,
  text: string,
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<boolean, never> {
  // 派发 = 输入文本 + 回车提交；hapi 是自定义 agent 类型，herdr agent prompt 不认。
  // 文本不落地时（管道/转义问题）不提交，避免把半句话发给模型。
  return Effect.flatMap(paneSendText(paneId, text, spawn), (sent) =>
    sent ? agentSendKeys(paneId, ["enter"], spawn) : Effect.succeed(false));
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * hapilon 自身入口的绝对路径。扩展跑在 pi 子进程里，process.argv[1] 是
 * pi 的 cli.js 而非 hapilon 入口，因此入口路径由 startup.ts
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

function readResolvedTierModelsSafely(): Record<ModelTier, ResolvedModel[]> {
  return Effect.runSync(readResolvedTiersEffect);
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
