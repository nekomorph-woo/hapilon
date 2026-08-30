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
export class McpConfigError extends Error {
}
export function mcpConfigPath(agentDir) {
    return join(agentDir, "mcp.json");
}
export function loadMcpServers(agentDir) {
    const path = mcpConfigPath(agentDir);
    if (!existsSync(path))
        return {};
    let cfg;
    try {
        cfg = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (err) {
        throw new McpConfigError(`mcp.json 解析失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
    }
    const servers = cfg?.mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
        throw new McpConfigError(`mcp.json 缺少 mcpServers 对象（${path}）。期望 {"mcpServers": {...}}。`);
    }
    return servers;
}
function validate(def) {
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
    return def;
}
/**
 * 添加 server（读-改-写保留既有配置）。同名存在时抛错——
 * 覆盖用户手写的 server 定义是破坏性动作，应显式 remove 后再加。
 */
export function addMcpServer(agentDir, def) {
    const v = validate(def);
    if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    }
    const servers = loadMcpServers(agentDir);
    if (v.name in servers) {
        throw new McpConfigError(`server "${v.name}" 已存在于 ${mcpConfigPath(agentDir)}。先 hapi mcp remove ${v.name} 再添加。`);
    }
    const { name, ...entry } = v;
    servers[name] = entry;
    writeFileSync(mcpConfigPath(agentDir), JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8");
}
/** 删除 server；不存在返回 false（调用方决定如何呈现） */
export function removeMcpServer(agentDir, name) {
    const servers = loadMcpServers(agentDir);
    if (!(name in servers))
        return false;
    delete servers[name];
    writeFileSync(mcpConfigPath(agentDir), JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8");
    return true;
}
