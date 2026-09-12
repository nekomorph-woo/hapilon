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
    it("首次调用写入 tasks-config.json（autoCascade: true）", () => {
        ensureExtensionConfigs(agentDir);
        const path = join(agentDir, "tasks-config.json");
        assert.ok(existsSync(path));
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(cfg.autoCascade, true);
    });
    it("首次调用写入 web-search.json（workflow: none，#42 决策：不弹 curator 浏览器）", () => {
        ensureExtensionConfigs(agentDir);
        const path = join(agentDir, "web-search.json");
        assert.ok(existsSync(path));
        const cfg = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(cfg.workflow, "none");
    });
    it("首次调用写入 mcp.json 空骨架（#49：pi-mcp-adapter 配置）", () => {
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
    it("把仓库主题目录挂进 settings.themes，并默认选中跟随终端明暗的配对主题", () => {
        const fresh = join(agentDir, "themes-seed");
        mkdirSync(fresh, { recursive: true });
        writeFileSync(join(fresh, "settings.json"), "{}\n");
        ensureExtensionConfigs(fresh);
        const settings = JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8"));
        assert.equal(settings.theme, "hapilon-light/hapilon-dark");
        const themeDir = settings.themes.at(-1);
        assert.ok(themeDir.endsWith("/resources/themes"), `themes 末项是主题目录：${themeDir}`);
        for (const name of ["hapilon-dark.json", "hapilon-light.json"]) {
            const theme = JSON.parse(readFileSync(join(themeDir, name), "utf8"));
            assert.equal(theme.name, name.replace(".json", ""));
            assert.equal(typeof theme.colors.mdCodeBlockBg, "string");
        }
    });
    it("重复调用幂等：theme/themes 不被重写", () => {
        const fresh = join(agentDir, "themes-idem");
        mkdirSync(fresh, { recursive: true });
        writeFileSync(join(fresh, "settings.json"), "{}\n");
        ensureExtensionConfigs(fresh);
        const first = readFileSync(join(fresh, "settings.json"), "utf8");
        ensureExtensionConfigs(fresh);
        assert.equal(readFileSync(join(fresh, "settings.json"), "utf8"), first);
    });
    it("用户已选定主题、且自己填了 themes 条目时均保留", () => {
        const fresh = join(agentDir, "themes-user-pick");
        mkdirSync(fresh, { recursive: true });
        writeFileSync(join(fresh, "settings.json"), JSON.stringify({ theme: "light/dark", themes: ["/tmp/my-themes"] }, null, 2));
        ensureExtensionConfigs(fresh);
        const settings = JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8"));
        assert.equal(settings.theme, "light/dark", "用户的 light/dark 自动配对不被配对默认值顶掉");
        assert.deepEqual(settings.themes.slice(0, 1), ["/tmp/my-themes"]);
        assert.ok(settings.themes.at(-1).endsWith("/resources/themes"));
    });
    it("仓库换了路径：旧的 hapilon 主题条目被剔除，不积累", () => {
        const fresh = join(agentDir, "themes-moved");
        mkdirSync(fresh, { recursive: true });
        writeFileSync(join(fresh, "settings.json"), JSON.stringify({ themes: ["/old/checkout/resources/themes", "/tmp/my-themes"] }, null, 2));
        ensureExtensionConfigs(fresh);
        const settings = JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8"));
        assert.ok(!settings.themes.includes("/old/checkout/resources/themes"));
        assert.deepEqual(settings.themes, ["/tmp/my-themes", settings.themes.at(-1)]);
    });
});
