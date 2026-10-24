import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExtensionConfigs } from "../../extensions/ensure-configs.js";
describe("ensureExtensionConfigs()", () => {
    let agentDir;
    before(() => {
        agentDir = mkdtempSync(join(tmpdir(), "hapilon-ext-config-"));
    });
    after(() => {
        rmSync(agentDir, { recursive: true, force: true });
    });
    it("首次调用写入 tasks-config.json（autoCascade: true，taskScope: session-global）", () => {
        ensureExtensionConfigs(agentDir);
        const path = join(agentDir, "tasks-config.json");
        assert.ok(existsSync(path));
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(cfg.autoCascade, true);
        assert.equal(cfg.taskScope, "session-global", "任务文件落 agentDir，不进用户仓库");
    });
    it("存量安装：已有 tasks-config.json 缺失的默认键被补齐，且重复调用不重写", () => {
        const fresh = join(agentDir, "tasks-backfill");
        mkdirSync(fresh, { recursive: true });
        const path = join(fresh, "tasks-config.json");
        writeFileSync(path, JSON.stringify({ autoCascade: true }, null, 2));
        ensureExtensionConfigs(fresh);
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(cfg.taskScope, "session-global", "新增默认键落到存量文件");
        assert.equal(cfg.autoCascade, true);
        const afterFirst = readFileSync(path, "utf8");
        ensureExtensionConfigs(fresh);
        assert.equal(readFileSync(path, "utf8"), afterFirst, "键齐了就不再写");
    });
    it("补齐缺失键时不覆盖用户已设置的键", () => {
        const fresh = join(agentDir, "tasks-backfill-keep");
        mkdirSync(fresh, { recursive: true });
        const path = join(fresh, "tasks-config.json");
        writeFileSync(path, JSON.stringify({ taskScope: "project", autoCascade: false, maxVisible: 7 }, null, 2));
        ensureExtensionConfigs(fresh);
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(cfg.taskScope, "project", "用户显式选的 scope 不被默认值顶掉");
        assert.equal(cfg.autoCascade, false);
        assert.equal(cfg.maxVisible, 7);
    });
    it("首次调用写入 web-search.json（workflow: none：不弹 curator 浏览器）", () => {
        ensureExtensionConfigs(agentDir);
        const path = join(agentDir, "web-search.json");
        assert.ok(existsSync(path));
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(cfg.workflow, "none");
    });
    it("首次调用写入 mcp.json 空骨架（pi-mcp-adapter 配置）", () => {
        ensureExtensionConfigs(agentDir);
        const path = join(agentDir, "mcp.json");
        assert.ok(existsSync(path));
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.deepEqual(cfg, { mcpServers: {} });
    });
    it("mcp.json 用户已配置时不覆盖", () => {
        const fresh = join(agentDir, "user-mcp");
        mkdirSync(fresh, { recursive: true });
        const path = join(fresh, "mcp.json");
        writeFileSync(path, JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "npx" } } }));
        ensureExtensionConfigs(fresh);
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.ok(cfg.mcpServers.fs, "用户已配置的 server 不被清掉");
    });
    it("web-search.json 用户已配置时不覆盖", () => {
        const fresh = join(agentDir, "user-wa");
        mkdirSync(fresh, { recursive: true });
        const path = join(fresh, "web-search.json");
        writeFileSync(path, JSON.stringify({ workflow: "summary-review", provider: "exa" }));
        ensureExtensionConfigs(fresh);
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(cfg.workflow, "summary-review", "用户显式开启 curator 不被覆盖");
        assert.equal(cfg.provider, "exa");
    });
    it("不写 subagents.json（无预置值，保持上游 missing-file-silent）", () => {
        ensureExtensionConfigs(agentDir);
        assert.ok(!existsSync(join(agentDir, "subagents.json")));
    });
    it("幂等：已存在的文件不被覆盖（含用户自定义值）", () => {
        const path = join(agentDir, "tasks-config.json");
        writeFileSync(path, JSON.stringify({ autoCascade: false, maxVisible: 20 }));
        ensureExtensionConfigs(agentDir);
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(cfg.autoCascade, false, "用户显式关闭不被覆盖");
        assert.equal(cfg.maxVisible, 20);
    });
    it("损坏的已有文件不碰（不覆盖用户数据）", () => {
        const path = join(agentDir, "tasks-config.json");
        writeFileSync(path, "{ broken");
        ensureExtensionConfigs(agentDir);
        assert.equal(readFileSync(path, "utf8"), "{ broken");
    });
    it("agentDir 不存在时创建目录", () => {
        const fresh = join(agentDir, "nested", "new");
        ensureExtensionConfigs(fresh);
        assert.ok(existsSync(join(fresh, "tasks-config.json")));
    });
    it("主题清理：hapilon 主题残留被剔除，回落 pi 内置主题", () => {
        const fresh = join(agentDir, "themes-cleanup");
        mkdirSync(fresh, { recursive: true });
        writeFileSync(join(fresh, "settings.json"), JSON.stringify({ theme: "hapilon-light/hapilon-dark", themes: ["/old/checkout/resources/themes", "/tmp/my-themes"] }, null, 2));
        ensureExtensionConfigs(fresh);
        const settings = JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8"));
        assert.equal(settings.theme, undefined, "hapilon-* 主题选择被清除");
        assert.deepEqual(settings.themes, ["/tmp/my-themes"], "仅保留用户自装主题");
    });
    it("主题清理幂等：无残留且已种 defaultTools 时 settings.json 不被重写", () => {
        const fresh = join(agentDir, "themes-clean-idem");
        mkdirSync(fresh, { recursive: true });
        writeFileSync(join(fresh, "settings.json"), JSON.stringify({ theme: "dark", defaultTools: ["+codemode"], tuiMode: "regular" }, null, 2));
        const before = readFileSync(join(fresh, "settings.json"), "utf8");
        ensureExtensionConfigs(fresh);
        assert.equal(readFileSync(join(fresh, "settings.json"), "utf8"), before);
    });
    it("defaultTools/tuiMode 未设置时种子（tool_search + regular）", () => {
        const fresh = join(agentDir, "settings-seed");
        mkdirSync(fresh, { recursive: true });
        writeFileSync(join(fresh, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
        ensureExtensionConfigs(fresh);
        const settings = JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8"));
        assert.deepEqual(settings.defaultTools, ["+tool_search"]);
        assert.equal(settings.tuiMode, "regular");
        // 二次调用幂等，且用户显式配置不被覆盖
        writeFileSync(join(fresh, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }, null, 2));
        ensureExtensionConfigs(fresh);
        assert.equal(JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8")).tuiMode, "fullscreen");
    });
});
