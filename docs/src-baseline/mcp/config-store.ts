import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * mcp.json 配置存取（#50 通道 B 的存储层）。
 *
 * pi-mcp-adapter 从 agentDir/mcp.json 读 server 声明（transport 有
 * stdio / http 两类）。此模块做 schema 校验 + 读-改-写，供
 * `hapi mcp add/list/remove` 子命令使用；校验失败一律抛
 * McpConfigError（Fail Fast——写坏配置文件比拒绝写入更糟）。
 */

export class McpConfigError extends Error {}

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

export function loadMcpServers(agentDir: string): Record<string, ServerEntry> {
  const path = mcpConfigPath(agentDir);
  if (!existsSync(path)) return {};
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new McpConfigError(
      `mcp.json 解析失败（${path}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const servers = (cfg as { mcpServers?: unknown })?.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new McpConfigError(
      `mcp.json 缺少 mcpServers 对象（${path}）。期望 {"mcpServers": {...}}。`,
    );
  }
  return servers as Record<string, ServerEntry>;
}

function validate(def: UnvalidatedServerDef): ServerDef {
  if (typeof def.name !== "string" || !def.name || /[\s/\\]/.test(def.name)) {
    throw new McpConfigError(`非法 server 名："${String(def.name)}"（不能为空，不能含空白或路径分隔符）`);
  }
  if (def.type !== "stdio" && def.type !== "http") {
    throw new McpConfigError(`非法 transport 类型："${String(def.type)}"（支持 stdio / http）`);
  }
  if (def.type === "stdio" && (!def.command || typeof def.command !== "string")) {
    throw new McpConfigError(`stdio server "${def.name}" 缺 command`);
  }
  if (def.type === "http" && (!def.url || typeof def.url !== "string")) {
    throw new McpConfigError(`http server "${def.name}" 缺 url`);
  }
  return def as unknown as ServerDef;
}

/**
 * 添加 server（读-改-写保留既有配置）。同名存在时抛错——
 * 覆盖用户手写的 server 定义是破坏性动作，应显式 remove 后再加。
 */
export function addMcpServer(agentDir: string, def: UnvalidatedServerDef): void {
  const v = validate(def);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  }
  const servers = loadMcpServers(agentDir);
  if (v.name in servers) {
    throw new McpConfigError(
      `server "${v.name}" 已存在于 ${mcpConfigPath(agentDir)}。先 hapi mcp remove ${v.name} 再添加。`,
    );
  }
  const { name, ...entry } = v;
  servers[name] = entry;
  writeFileSync(
    mcpConfigPath(agentDir),
    JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
    "utf8",
  );
}

/** 删除 server；不存在返回 false（调用方决定如何呈现） */
export function removeMcpServer(agentDir: string, name: string): boolean {
  const servers = loadMcpServers(agentDir);
  if (!(name in servers)) return false;
  delete servers[name];
  writeFileSync(
    mcpConfigPath(agentDir),
    JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
    "utf8",
  );
  return true;
}
