// startup header 纯函数测试：路径缩短 + 解析 + 布局构建
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shortenWorkspacePath, parseExtensionsEnv, hapilonLogo, currentLayoutIndex, } from "../../extensions/hpl-startup-header/content.js";
describe("shortenWorkspacePath", () => {
    it("home 直接返回 ~", () => {
        assert.equal(shortenWorkspacePath("/Users/alice", "/Users/alice"), "~");
    });
    it("home 下短路径保留完整", () => {
        assert.equal(shortenWorkspacePath("/Users/alice/proj", "/Users/alice"), "~/proj");
    });
    it("home 下长路径压缩首末段", () => {
        assert.equal(shortenWorkspacePath("/Users/alice/a/b/c/d/e", "/Users/alice"), "~/a/…/d/e");
    });
    it("非 home 绝对路径保留前两段与末段", () => {
        assert.equal(shortenWorkspacePath("/Volumes/M2/a/b/c/hapilon", "/Users/alice"), "/Volumes/M2/…/hapilon");
    });
});
describe("parseExtensionsEnv", () => {
    it("JSON 数组解析为 string[]", () => {
        assert.deepEqual(parseExtensionsEnv('["a","b"]'), ["a", "b"]);
    });
    it("undefined / 非 JSON / 非数组返回 undefined", () => {
        assert.equal(parseExtensionsEnv(undefined), undefined);
        assert.equal(parseExtensionsEnv("not json"), undefined);
        assert.equal(parseExtensionsEnv('{"a":1}'), undefined);
    });
});
describe("logo 与布局随机", () => {
    it("logo 返回 10 行非空字符串", () => {
        const logo = hapilonLogo();
        assert.equal(logo.length, 10);
        assert.ok(logo.every((l) => typeof l === "string"));
    });
    it("布局索引为 0 或 1（A/B）", () => {
        const idx = currentLayoutIndex();
        assert.ok(idx === 0 || idx === 1, `layout index: ${idx}`);
    });
});
