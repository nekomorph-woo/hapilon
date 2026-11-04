import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureQuietStartup, maskKey, semverGte, parseSemver, } from "../../providers/providers.js";
describe("providers", () => {
    let tmpDir;
    before(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "hapilon-providers-test-"));
    });
    after(() => {
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        }
        catch { /* ignore cleanup errors */ }
    });
    describe("semverGte()", () => {
        it("v1 > v2 返回 true", () => {
            assert.strictEqual(semverGte("v22.19.0", "v22.18.0"), true);
            assert.strictEqual(semverGte("v23.0.0", "v22.19.0"), true);
        });
        it("v1 = v2 返回 true", () => {
            assert.strictEqual(semverGte("v22.19.0", "v22.19.0"), true);
        });
        it("v1 < v2 返回 false", () => {
            assert.strictEqual(semverGte("v22.18.0", "v22.19.0"), false);
            assert.strictEqual(semverGte("v21.0.0", "v22.0.0"), false);
        });
        it("不带 v 前缀也能比较", () => {
            assert.strictEqual(semverGte("22.19.0", "22.18.0"), true);
            assert.strictEqual(semverGte("22.19.0", "22.19.0"), true);
        });
        it("处理不同长度的版本号", () => {
            assert.strictEqual(semverGte("v22.19", "v22.19.0"), true);
            assert.strictEqual(semverGte("v22.19.0", "v22.19"), true);
        });
    });
    describe("parseSemver()", () => {
        it("标准三段式", () => {
            assert.deepStrictEqual(parseSemver("1.2.3"), [1, 2, 3]);
        });
        it("带 v 前缀", () => {
            assert.deepStrictEqual(parseSemver("v0.80.10"), [0, 80, 10]);
        });
        it("两段式补零", () => {
            assert.deepStrictEqual(parseSemver("1.0"), [1, 0, 0]);
        });
        it("单段式补零", () => {
            assert.deepStrictEqual(parseSemver("1"), [1, 0, 0]);
        });
        it("非数字降级为 0", () => {
            assert.deepStrictEqual(parseSemver("abc"), [0, 0, 0]);
        });
        it("空字符串降级为 0", () => {
            assert.deepStrictEqual(parseSemver(""), [0, 0, 0]);
        });
    });
    describe("maskKey()", () => {
        it("正常长 key 脱敏", () => {
            const masked = maskKey("sk-a1b2c3d4e5f6g7h8i9j0");
            assert.ok(masked.startsWith("sk-a"), "应以 sk-a 开头");
            assert.ok(masked.endsWith("j0"), "应以 j0 结尾");
            assert.ok(masked.includes("…"), "应包含省略号");
        });
        it("短 key (≤4) 显示 ****", () => {
            assert.strictEqual(maskKey("abc"), "****");
            assert.strictEqual(maskKey("abcd"), "****");
        });
        it("中等长度 key (5-8) 首尾 2 字符", () => {
            const masked = maskKey("abcdefgh");
            assert.strictEqual(masked, "ab…gh");
        });
        it("空字符串显示 ****", () => {
            assert.strictEqual(maskKey(""), "****");
        });
    });
    describe("ensureQuietStartup()", () => {
        it("settings.json 不存在 → 创建并写入 { quietStartup: true }", () => {
            const dir = mkdtempSync(join(tmpdir(), "hapilon-qs-test-"));
            try {
                ensureQuietStartup(dir);
                const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
                assert.strictEqual(parsed.quietStartup, true);
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it("已存在其他键 → 合并写回，原有键保留", () => {
            const dir = mkdtempSync(join(tmpdir(), "hapilon-qs-test-"));
            try {
                writeFileSync(join(dir, "settings.json"), '{"theme":"dark"}\n', "utf8");
                ensureQuietStartup(dir);
                const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
                assert.strictEqual(parsed.quietStartup, true);
                assert.strictEqual(parsed.theme, "dark");
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it("已为 true → 不写文件（幂等）", () => {
            const dir = mkdtempSync(join(tmpdir(), "hapilon-qs-test-"));
            try {
                const original = '{"quietStartup":true,"theme":"dark"}\n';
                writeFileSync(join(dir, "settings.json"), original, "utf8");
                ensureQuietStartup(dir);
                const content = readFileSync(join(dir, "settings.json"), "utf8");
                assert.strictEqual(content, original, "已为 true 时不应重写文件");
                const parsed = JSON.parse(content);
                assert.strictEqual(parsed.theme, "dark", "原有键应保留");
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it("settings.json 内容为 JSON null → warn + 不动原文件", () => {
            const dir = mkdtempSync(join(tmpdir(), "hapilon-qs-test-"));
            try {
                writeFileSync(join(dir, "settings.json"), "null\n", "utf8");
                const warnings = [];
                const orig = console.warn;
                console.warn = (...args) => warnings.push(args.map(String).join(" "));
                try {
                    ensureQuietStartup(dir);
                    assert.ok(warnings.length > 0, "应打印警告");
                    assert.ok(warnings.some((w) => w.includes("not a JSON object")), "应提示非对象");
                    assert.strictEqual(readFileSync(join(dir, "settings.json"), "utf8"), "null\n", "原文件不应变更");
                }
                finally {
                    console.warn = orig;
                }
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it("settings.json 内容为 JSON string → warn + 不动原文件", () => {
            const dir = mkdtempSync(join(tmpdir(), "hapilon-qs-test-"));
            try {
                writeFileSync(join(dir, "settings.json"), '"just a string"\n', "utf8");
                const warnings = [];
                const orig = console.warn;
                console.warn = (...args) => warnings.push(args.map(String).join(" "));
                try {
                    ensureQuietStartup(dir);
                    assert.ok(warnings.length > 0, "应打印警告");
                    assert.ok(warnings.some((w) => w.includes("not a JSON object")), "应提示非对象");
                    assert.strictEqual(readFileSync(join(dir, "settings.json"), "utf8"), '"just a string"\n', "原文件不应变更");
                }
                finally {
                    console.warn = orig;
                }
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it("settings.json 内容为 JSON array → warn + 不动原文件", () => {
            const dir = mkdtempSync(join(tmpdir(), "hapilon-qs-test-"));
            try {
                writeFileSync(join(dir, "settings.json"), "[1,2,3]\n", "utf8");
                const warnings = [];
                const orig = console.warn;
                console.warn = (...args) => warnings.push(args.map(String).join(" "));
                try {
                    ensureQuietStartup(dir);
                    assert.ok(warnings.length > 0, "应打印警告");
                    assert.strictEqual(readFileSync(join(dir, "settings.json"), "utf8"), "[1,2,3]\n", "原文件不应变更");
                }
                finally {
                    console.warn = orig;
                }
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it("JSON 解析失败 → warn 且不覆盖原文件", () => {
            const dir = mkdtempSync(join(tmpdir(), "hapilon-qs-test-"));
            try {
                const badJson = "bad json!\n";
                writeFileSync(join(dir, "settings.json"), badJson, "utf8");
                const warnings = [];
                const originalWarn = console.warn;
                console.warn = (...args) => {
                    warnings.push(args.map(String).join(" "));
                };
                try {
                    ensureQuietStartup(dir);
                    assert.ok(warnings.length > 0, "应打印警告");
                    const content = readFileSync(join(dir, "settings.json"), "utf8");
                    assert.strictEqual(content, badJson, "原文件内容不应变更");
                }
                finally {
                    console.warn = originalWarn;
                }
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it("agentDir 不存在 → 创建目录并写入", () => {
            const dir = mkdtempSync(join(tmpdir(), "hapilon-qs-test-"));
            const subDir = join(dir, "nonexistent");
            try {
                ensureQuietStartup(subDir);
                const parsed = JSON.parse(readFileSync(join(subDir, "settings.json"), "utf8"));
                assert.strictEqual(parsed.quietStartup, true);
                const stat = statSync(subDir);
                assert.strictEqual(stat.mode & 0o777, 0o700, "目录权限应为 0700");
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
