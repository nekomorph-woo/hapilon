/**
 * derive-allow 单元测试 — 命令 → 保守通配建议（纯函数）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveAllowPattern } from "../../extensions/hpl-safety-gate/derive-allow.js";
describe("deriveAllowPattern()", () => {
    it("简单命令 → 前两个 token + *", () => {
        assert.strictEqual(deriveAllowPattern("git push origin main"), "git push*");
    });
    it("单 token 命令 → 该 token + *", () => {
        assert.strictEqual(deriveAllowPattern("ls"), "ls*");
    });
    it("带参数的单 token 命令 → 前两个 token + *", () => {
        assert.strictEqual(deriveAllowPattern("ls -la /tmp"), "ls -la*");
    });
    it("cd X && Y → 取 Y 的前两个 token", () => {
        assert.strictEqual(deriveAllowPattern("cd /proj && npm install foo"), "npm install*");
    });
    it("cd 链 → 取最后一段", () => {
        assert.strictEqual(deriveAllowPattern("cd a && cd b && git commit -m 'x'"), "git commit*");
    });
    it("分号复合命令 → 取最后一段", () => {
        assert.strictEqual(deriveAllowPattern("ls -la; rm -rf ./x"), "rm -rf*");
    });
    it("换行复合命令 → 取最后一段", () => {
        assert.strictEqual(deriveAllowPattern("cd /x\ngit push origin"), "git push*");
    });
    it("前导/尾随空白被忽略", () => {
        assert.strictEqual(deriveAllowPattern("  git   push   origin  "), "git push*");
    });
    it("空命令 → 空建议", () => {
        assert.strictEqual(deriveAllowPattern(""), "");
        assert.strictEqual(deriveAllowPattern("   "), "");
        assert.strictEqual(deriveAllowPattern("&&"), "");
    });
});
