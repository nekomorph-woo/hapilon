import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * settings 通道安全门生命周期（#37）：
 * 以 cli.ts 的实际调用序列驱动 dist 产物（ensureSafetyExtensions /
 * removeSafetyExtensions / isSafetyExtensionPath），验证 HAPILON_HOME
 * 隔离下 settings.json 的安全门条目写入 → 移除 → 写回的完整语义。
 * pi 启动本身不在此覆盖（E2E 已人工验证 subagent 拦截）。
 */
describe("settings 通道安全门生命周期（#37）", () => {
    let tmpBase;
    const ORIGINAL_ENV = process.env.HAPILON_HOME;
    let safetySettings;
    before(async () => {
        tmpBase = mkdtempSync(join(tmpdir(), "hapilon-safety-channel-"));
        process.env.HAPILON_HOME = tmpBase;
        safetySettings = await import("../../safety-settings.js");
    });
    after(() => {
        if (ORIGINAL_ENV === undefined) {
            delete process.env.HAPILON_HOME;
        }
        else {
            process.env.HAPILON_HOME = ORIGINAL_ENV;
        }
        rmSync(tmpBase, { recursive: true, force: true });
    });
    function settingsPath() {
        return join(tmpBase, "agent", "settings.json");
    }
    function readSettings() {
        assert.ok(existsSync(settingsPath()), "settings.json 应已生成");
        return JSON.parse(readFileSync(settingsPath(), "utf8"));
    }
    it("正常启动（cli 调用序列）写入安全门条目，锚定当前构建 dist", () => {
        safetySettings.ensureSafetyExtensions(join(tmpBase, "agent"));
        const ext = readSettings().extensions;
        assert.ok(ext.some((e) => e.includes("hpl-safety-gate/index.js")), JSON.stringify(ext));
        assert.ok(ext.some((e) => e.includes("hpl-protected-paths/index.js")), JSON.stringify(ext));
        for (const e of ext) {
            assert.ok(e.startsWith(process.cwd()), `安全门应锚定当前安装: ${e}`);
        }
    });
    it("-e 通道过滤：isSafetyExtensionPath 识别安全门、放行其它扩展", () => {
        const ext = readSettings().extensions;
        for (const e of ext) {
            assert.ok(safetySettings.isSafetyExtensionPath(e), `settings 条目应被识别为安全门: ${e}`);
        }
        assert.ok(safetySettings.isSafetyExtensionPath("/x/dist/extensions/hpl-safety-gate/index.js"));
        assert.ok(!safetySettings.isSafetyExtensionPath("/x/dist/extensions/hpl-add-dir/index.js"));
        assert.ok(!safetySettings.isSafetyExtensionPath("/x/dist/extensions/hpl-system-prompt/index.js"));
    });
    it("--no-safety（cli 调用序列）移除安全门条目，用户自有条目保留", () => {
        const current = readSettings();
        current.extensions = [...current.extensions, "/user/own/ext.js"];
        writeFileSync(settingsPath(), JSON.stringify(current));
        safetySettings.removeSafetyExtensions(join(tmpBase, "agent"));
        const ext = readSettings().extensions;
        assert.deepEqual(ext, ["/user/own/ext.js"]);
    });
    it("再次正常启动写回（无重复，用户条目仍在）", () => {
        safetySettings.ensureSafetyExtensions(join(tmpBase, "agent"));
        const ext = readSettings().extensions;
        const gateCount = ext.filter((e) => e.includes("hpl-")).length;
        assert.equal(gateCount, 2, JSON.stringify(ext));
        assert.ok(ext.includes("/user/own/ext.js"));
    });
});
