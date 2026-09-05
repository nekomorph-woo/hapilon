import { createInterface } from "node:readline/promises";
import { agentDir } from "../hapilon-home.js";
import {
  addMcpServer,
  loadMcpServers,
  mcpConfigPath,
  removeMcpServer,
  McpConfigError,
  type UnvalidatedServerDef,
} from "./config-store.js";

/**
 * `hapi mcp` 子命令（#50 通道 B）：人不手写 mcp.json。
 *
 *   hapi mcp add <name> <type> -- <command> [args...] [--env K=V]...
 *   hapi mcp add <name> http <url> [--header K=V]...
 *   hapi mcp list
 *   hapi mcp remove <name> [-y]
 *
 * 写入走 config-store 的 schema 校验与读-改-写；修改需重启会话生效
 * （adapter 在会话启动时读 mcp.json，lazy lifecycle 首次调用才 spawn）。
 */

function usage(): never {
  console.log(`用法:
  hapi mcp add <name> stdio -- <command> [args...] [--env K=V]...   添加本地子进程 server
  hapi mcp add <name> http <url> [--header "K: V"]...               添加远程 server
  hapi mcp list                                                     列出已配置 server
  hapi mcp remove <name> [-y]                                       删除 server（-y 跳过确认）

配置文件: mcp.json（由 pi-mcp-adapter 读取；修改后重启会话生效）`);
  process.exit(1);
}

/** 从 args 中摘走 --env K=V / --header "K: V" 形式的键值对 */
function extractKv(args: string[], flag: string): { kv: Record<string, string>; rest: string[] } {
  const kv: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      const pair = args[++i];
      const eq = pair.indexOf("=");
      const colon = pair.indexOf(": ");
      const idx = eq >= 0 ? eq : colon;
      if (idx <= 0) {
        console.error(`✗ ${flag} 参数格式应为 K=V: ${pair}`);
        process.exit(1);
      }
      kv[pair.slice(0, idx).trim()] = pair.slice(idx + (eq >= 0 ? 1 : 1)).trim();
    } else {
      rest.push(args[i]);
    }
  }
  return { kv, rest };
}

async function cmdAdd(args: string[]): Promise<void> {
  const [name, type, ...tail] = args;
  if (!name || !type) usage();

  let def: UnvalidatedServerDef;
  if (type === "stdio") {
    const { kv, rest } = extractKv(tail, "--env");
    const sep = rest.indexOf("--");
    if (sep < 0 || sep + 1 >= rest.length) {
      console.error('✗ stdio 格式: hapi mcp add <name> stdio -- <command> [args...] [--env K=V]...');
      process.exit(1);
    }
    def = {
      name,
      type,
      command: rest[sep + 1],
      ...(sep + 2 < rest.length ? { args: rest.slice(sep + 2) } : {}),
      ...(Object.keys(kv).length ? { env: kv } : {}),
    };
  } else if (type === "http") {
    const { kv, rest } = extractKv(tail, "--header");
    if (!rest[0]) {
      console.error("✗ http 格式: hapi mcp add <name> http <url> [--header \"K: V\"]...");
      process.exit(1);
    }
    def = {
      name,
      type,
      url: rest[0],
      ...(Object.keys(kv).length ? { headers: kv } : {}),
    };
  } else {
    console.error(`✗ 未知 transport 类型 "${type}"（支持 stdio / http）`);
    process.exit(1);
  }

  try {
    addMcpServer(agentDir(), def);
  } catch (err) {
    if (err instanceof McpConfigError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`✓ 已添加 server "${name}" → ${mcpConfigPath(agentDir())}`);
  console.log("  重启 hapilon 会话后生效（mcp.json 在会话启动时加载）。");
}

function cmdList(): void {
  const servers = loadMcpServers(agentDir());
  const names = Object.keys(servers);
  if (!names.length) {
    console.log("（无 MCP server。用 hapi mcp add 添加，或在会话里让 agent 添加。）");
    return;
  }
  for (const name of names) {
    const s = servers[name] as Record<string, unknown>;
    const summary =
      s.type === "http"
        ? `${s.url}`
        : `${s.command}${Array.isArray(s.args) && s.args.length ? " " + (s.args as string[]).join(" ") : ""}`;
    console.log(`${name}  [${s.type}]  ${summary}`);
  }
}

async function cmdRemove(name: string | undefined, skipConfirm: boolean): Promise<void> {
  if (!name) usage();
  if (!skipConfirm) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`删除 server "${name}"? (y/N) `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("已取消。");
      return;
    }
  }
  try {
    const removed = removeMcpServer(agentDir(), name);
    console.log(removed ? `✓ 已删除 "${name}"。重启会话生效。` : `✗ "${name}" 不存在于 ${mcpConfigPath(agentDir())}`);
    if (!removed) process.exit(1);
  } catch (err) {
    if (err instanceof McpConfigError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export async function handleMcp(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      return cmdAdd(rest);
    case "list":
      return cmdList();
    case "remove":
      return cmdRemove(rest[0], rest.includes("-y") || rest.includes("--yes"));
    default:
      usage();
  }
}
