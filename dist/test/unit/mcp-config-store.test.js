import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpConfigPath, loadMcpServers, addMcpServer, removeMcpServer, McpConfigError, } from "../../mcp/config-store.js";
describe("mcp/config-store", () => {
    let agent;
    before(() => {
        agent = mkdtempSync(join(tmpdir(), "hapilon-mcp-store-"));
    });
    after(() => {
        rmSync(agent, { recursive: true, force: true });
    });
    describe("mcpConfigPath()", () => {
        it("返回 agentDir 下的 mcp.json", () => {
            const p = mcpConfigPath(agent);
            assert.ok(p.endsWith("mcp.json") && p.startsWith(agent), `路径应是 agent 下的 mcp.json: ${p}`);
        });
    });
    describe("loadMcpServers()", () => {
        it("文件不存在时返回空对象（未配置状态）", () => {
            const fresh = join(agent, "absent");
            assert.deepEqual(loadMcpServers(fresh), {});
        });
        it("读取既有 servers", () => {
            const dir = join(agent, "existing");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "npx", args: ["-y", "x"] } } }));
            const servers = loadMcpServers(dir);
            const cmd = servers.fs.command;
            assert.equal(cmd, "npx");
        });
        it("损坏的 JSON 抛 McpConfigError（不静默吞）", () => {
            const dir = join(agent, "broken");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "mcp.json"), "{ nope");
            assert.throws(() => loadMcpServers(dir), McpConfigError);
        });
        it("缺 mcpServers 键时抛 McpConfigError（schema 损坏要爆出来）", () => {
            const dir = join(agent, "noservers");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "mcp.json"), "{}");
            assert.throws(() => loadMcpServers(dir), McpConfigError);
        });
    });
    describe("addMcpServer()", () => {
        it("stdio server：写入完整定义", () => {
            const dir = join(agent, "add-stdio");
            mkdirSync(dir, { recursive: true });
            addMcpServer(dir, {
                name: "zai",
                type: "stdio",
                command: "npx",
                args: ["-y", "@z_ai/mcp-server"],
                env: { Z_AI_API_KEY: "k-123" },
            });
            const cfg = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
            assert.deepEqual(cfg.mcpServers.zai, {
                type: "stdio",
                command: "npx",
                args: ["-y", "@z_ai/mcp-server"],
                env: { Z_AI_API_KEY: "k-123" },
            });
        });
        it("http server：写入 url 与 headers", () => {
            const dir = join(agent, "add-http");
            mkdirSync(dir, { recursive: true });
            addMcpServer(dir, {
                name: "web-reader",
                type: "http",
                url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
                headers: { Authorization: "Bearer tok" },
            });
            const cfg = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
            assert.equal(cfg.mcpServers["web-reader"].type, "http");
            assert.equal(cfg.mcpServers["web-reader"].url, "https://open.bigmodel.cn/api/mcp/web_reader/mcp");
            assert.equal(cfg.mcpServers["web-reader"].headers.Authorization, "Bearer tok");
        });
        it("同名已存在时抛错（fail fast，不静默覆盖）", () => {
            const dir = join(agent, "add-dup");
            mkdirSync(dir, { recursive: true });
            addMcpServer(dir, { name: "a", type: "stdio", command: "x" });
            assert.throws(() => addMcpServer(dir, { name: "a", type: "stdio", command: "y" }), (err) => err.message.includes("a") && err.message.includes("已存在"));
        });
        it("保留既有 server（读-改-写语义）", () => {
            const dir = join(agent, "add-keep");
            mkdirSync(dir, { recursive: true });
            addMcpServer(dir, { name: "first", type: "stdio", command: "x" });
            addMcpServer(dir, { name: "second", type: "stdio", command: "y" });
            const cfg = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
            assert.ok(cfg.mcpServers.first && cfg.mcpServers.second);
        });
        it("stdio 缺 command 抛错（schema 校验前置）", () => {
            const dir = join(agent, "add-nocmd");
            mkdirSync(dir, { recursive: true });
            assert.throws(() => addMcpServer(dir, { name: "bad", type: "stdio" }), McpConfigError);
        });
        it("http 缺 url 抛错", () => {
            const dir = join(agent, "add-nourl");
            mkdirSync(dir, { recursive: true });
            assert.throws(() => addMcpServer(dir, { name: "bad", type: "http" }), McpConfigError);
        });
        it("非法 transport 类型抛错", () => {
            const dir = join(agent, "add-badtype");
            mkdirSync(dir, { recursive: true });
            assert.throws(() => addMcpServer(dir, { name: "bad", type: "carrier-pigeon", command: "x" }), McpConfigError);
        });
    });
    describe("removeMcpServer()", () => {
        it("删除存在的 server，保留其余", () => {
            const dir = join(agent, "rm");
            mkdirSync(dir, { recursive: true });
            addMcpServer(dir, { name: "keep", type: "stdio", command: "x" });
            addMcpServer(dir, { name: "drop", type: "stdio", command: "y" });
            const removed = removeMcpServer(dir, "drop");
            assert.equal(removed, true);
            const cfg = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
            assert.ok(cfg.mcpServers.keep);
            assert.equal(cfg.mcpServers.drop, undefined);
        });
        it("删除不存在的 server 返回 false", () => {
            const dir = join(agent, "rm-miss");
            mkdirSync(dir, { recursive: true });
            assert.equal(removeMcpServer(dir, "ghost"), false);
        });
    });
});
