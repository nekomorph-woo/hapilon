import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";

export type HerdrPane = {
  paneId: string;
  status?: string;
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

export type SpawnFn = (file: string, args: string[], options: { encoding: "utf8" }) => SpawnResult;

const defaultSpawn: SpawnFn = spawnSync as unknown as SpawnFn;

export function herdrEnvAvailable(): boolean {
  return typeof process.env.HERDR_ENV === "string" && process.env.HERDR_ENV.length > 0;
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
      const result = spawn(bin, args, { encoding: "utf8" });
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

function runCommandEffect(
  args: string[],
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<boolean, never> {
  return Effect.try({
    try: () => {
      const bin = process.env.HERDR_BIN_PATH ?? "herdr";
      const result = spawn(bin, args, { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new HerdrError({ message: outputText(result.stderr) || `herdr exited with status ${result.status}` });
      }
      return true;
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) => Effect.sync(() => {
      console.warn(`[hpl-orchestra] herdr ${args.join(" ")} 失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    })),
  );
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
    return { paneId: id, status };
  });
}

export function agentGet(paneId: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<AgentStatus, never> {
  return Effect.map(runJsonEffect(["agent", "get", paneId], spawn), (raw) => {
    const agent = findRecord(raw, (record) =>
      typeof record.status === "string" || typeof record.state === "string");
    const rawStatus = agent?.status ?? agent?.state;
    if (typeof rawStatus !== "string") return "unknown";
    const normalized = rawStatus.toLowerCase();
    if (normalized === "idle") return "idle";
    if (normalized === "working" || normalized === "running") return "working";
    if (normalized === "blocked") return "blocked";
    if (normalized === "done" || normalized === "completed" || normalized === "complete") return "done";
    return "unknown";
  });
}

export function paneSplit(cwd: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<string | undefined, never> {
  return Effect.map(runJsonEffect(["pane", "split", "--cwd", cwd, "--no-focus"], spawn), (raw) => {
    const pane = findRecord(raw, (record) => typeof record.pane_id === "string");
    return typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
  });
}

export function paneRun(paneId: string, command: string, spawn: SpawnFn = defaultSpawn): Effect.Effect<boolean, never> {
  return runCommandEffect(["pane", "run", paneId, command], spawn);
}

export function agentSendKeys(
  paneId: string,
  keys: readonly string[],
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<boolean, never> {
  return runCommandEffect(["agent", "send-keys", paneId, ...keys], spawn);
}

export function agentWait(
  paneId: string,
  timeout = 600_000,
  spawn: SpawnFn = defaultSpawn,
): Effect.Effect<boolean, never> {
  return runCommandEffect(["agent", "wait", paneId, "--timeout", String(timeout)], spawn);
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildPaneRunCommand(role: "worker" | "reviewer", model?: string): string {
  const envPrefix = [`HAPI_ORCH_ROLE=${role}`];
  const configuredHome = process.env.HAPILON_HOME;
  if (configuredHome) envPrefix.push(`HAPILON_HOME=${shellArg(configuredHome)}`);
  const script = process.argv[1] && isAbsolute(process.argv[1])
    ? process.argv[1]
    : resolve(process.cwd(), process.argv[1] ?? "");
  const command = [...envPrefix, "node", shellArg(script)];
  if (model) command.push("--model", shellArg(model));
  return command.join(" ");
}

export function resolveTierModel(tier: "sonnet" | "opus"): string | undefined {
  const result = Effect.runSync(Effect.try({
    try: () => {
      const path = join(hapilonHome(), "model-tiers-resolved.json");
      if (!existsSync(path)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object") return undefined;
      const models = (parsed as Record<string, unknown>)[tier];
      if (!Array.isArray(models) || models.length === 0) return undefined;
      const first = models[0];
      if (!first || typeof first !== "object") return undefined;
      const provider = (first as Record<string, unknown>).provider;
      const id = (first as Record<string, unknown>).id;
      return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : undefined;
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) => Effect.sync(() => {
      console.warn(`[hpl-orchestra] 读取 resolved model 失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    })),
  ));
  return result;
}
