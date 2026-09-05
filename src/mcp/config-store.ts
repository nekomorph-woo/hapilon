import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";

/**
 * mcp.json 配置存取（#50 通道 B 的存储层）。
 *
 * pi-mcp-adapter 从 agentDir/mcp.json 读 server 声明（transport 有
 * stdio / http 两类）。此模块做 schema 校验 + 读-改-写，供
 * `hapi mcp add/list/remove` 子命令使用；校验失败一律抛
 * McpConfigError（Fail Fast——写坏配置文件比拒绝写入更糟）。
 */

export class McpConfigError extends Data.TaggedError("McpConfigError")<{
  message: string;
}> {}

/** stdio transport：本地子进程 server（command + args + env） */
export interface StdioServerDef {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** http transport：远程 server（url + headers） */
export interface HttpServerDef {
  name: string;
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type ServerDef = StdioServerDef | HttpServerDef;

/** 写入 mcp.json 的 def（剥掉 name，name 是键不是字段） */
type ServerEntry = Omit<ServerDef, "name">;

/** CLI 边界进来的未校验定义——字段齐全性由 validate() 运行时把关 */
export type UnvalidatedServerDef = { name: string; type: string } & Record<string, unknown>;

export function mcpConfigPath(agentDir: string): string {
  return join(agentDir, "mcp.json");
}

export const loadMcpServersEffect = (agentDir: string): Effect.Effect<Record<string, ServerEntry>, McpConfigError> => Effect.gen(function* () {
  const path = mcpConfigPath(agentDir);
  if (!existsSync(path)) return {};
  const cfg = yield* Effect.try({
    try: () => JSON.parse(readFileSync(path, "utf8")),
    catch: (err) => new McpConfigError({
      message: `mcp.json 解析失败（${path}）：${err instanceof Error ? err.message : String(err)}`,
    }),
  });
  const servers = (cfg as { mcpServers?: unknown })?.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return yield* Effect.fail(new McpConfigError({
      message: `mcp.json 缺少 mcpServers 对象（${path}）。期望 {"mcpServers": {...}}。`,
    }));
  }
  return servers as Record<string, ServerEntry>;
});

export function loadMcpServers(agentDir: string): Record<string, ServerEntry> {
  const result = Effect.runSync(Effect.either(loadMcpServersEffect(agentDir)));
  if (result._tag === "Left") throw result.left;
  return result.right;
}

const validateEffect = (def: UnvalidatedServerDef): Effect.Effect<ServerDef, McpConfigError> => Effect.gen(function* () {
  if (typeof def.name !== "string" || !def.name || /[\s/\\]/.test(def.name)) {
    return yield* Effect.fail(new McpConfigError({ message: `非法 server 名："${String(def.name)}"（不能为空，不能含空白或路径分隔符）` }));
  }
  if (def.type !== "stdio" && def.type !== "http") {
    return yield* Effect.fail(new McpConfigError({ message: `非法 transport 类型："${String(def.type)}"（支持 stdio / http）` }));
  }
  if (def.type === "stdio" && (!def.command || typeof def.command !== "string")) {
    return yield* Effect.fail(new McpConfigError({ message: `stdio server "${def.name}" 缺 command` }));
  }
  if (def.type === "http" && (!def.url || typeof def.url !== "string")) {
    return yield* Effect.fail(new McpConfigError({ message: `http server "${def.name}" 缺 url` }));
  }
  return def as unknown as ServerDef;
});

/**
 * 添加 server（读-改-写保留既有配置）。同名存在时抛错——
 * 覆盖用户手写的 server 定义是破坏性动作，应显式 remove 后再加。
 */
export const addMcpServerEffect = (agentDir: string, def: UnvalidatedServerDef): Effect.Effect<void, McpConfigError> => Effect.gen(function* () {
  const v = yield* validateEffect(def);
  if (!existsSync(agentDir)) {
    yield* Effect.try({
      try: () => mkdirSync(agentDir, { recursive: true, mode: 0o700 }),
      catch: (err) => new McpConfigError({ message: err instanceof Error ? err.message : String(err) }),
    });
  }
  const servers = yield* loadMcpServersEffect(agentDir);
  if (v.name in servers) {
    return yield* Effect.fail(new McpConfigError({
      message: `server "${v.name}" 已存在于 ${mcpConfigPath(agentDir)}。先 hapi mcp remove ${v.name} 再添加。`,
    }));
  }
  const { name, ...entry } = v;
  servers[name] = entry;
  yield* Effect.try({
    try: () => writeFileSync(mcpConfigPath(agentDir), JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8"),
    catch: (err) => new McpConfigError({ message: err instanceof Error ? err.message : String(err) }),
  });
});

export function addMcpServer(agentDir: string, def: UnvalidatedServerDef): void {
  const result = Effect.runSync(Effect.either(addMcpServerEffect(agentDir, def)));
  if (result._tag === "Left") throw result.left;
}

/** 删除 server；不存在返回 false（调用方决定如何呈现） */
export const removeMcpServerEffect = (agentDir: string, name: string): Effect.Effect<boolean, McpConfigError> => Effect.gen(function* () {
  const servers = yield* loadMcpServersEffect(agentDir);
  if (!(name in servers)) return false;
  delete servers[name];
  yield* Effect.try({
    try: () => writeFileSync(mcpConfigPath(agentDir), JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8"),
    catch: (err) => new McpConfigError({ message: err instanceof Error ? err.message : String(err) }),
  });
  return true;
});

export function removeMcpServer(agentDir: string, name: string): boolean {
  const result = Effect.runSync(Effect.either(removeMcpServerEffect(agentDir, name)));
  if (result._tag === "Left") throw result.left;
  return result.right;
}
