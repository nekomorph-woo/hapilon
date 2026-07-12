import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExtensions } from "../../extensions.js";

describe("discoverExtensions()", () => {
  let tmpBase: string;

  before(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "hapilon-ext-test-"));
  });

  after(() => {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("目录不存在时返回空数组", () => {
    const result = discoverExtensions(join(tmpBase, "nope"));
    assert.deepStrictEqual(result, []);
  });

  it("空目录返回空数组", () => {
    const dir = join(tmpBase, "empty");
    mkdirSync(dir);
    const result = discoverExtensions(dir);
    assert.deepStrictEqual(result, []);
  });

  it("发现单文件 .js 扩展", () => {
    const dir = join(tmpBase, "single");
    mkdirSync(dir);
    writeFileSync(join(dir, "my-tool.js"), "// extension");

    const result = discoverExtensions(dir);
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].endsWith("my-tool.js"));
  });

  it("发现多文件扩展（目录 + index.js）", () => {
    const dir = join(tmpBase, "multi");
    mkdirSync(dir);
    const extDir = join(dir, "my-hook");
    mkdirSync(extDir);
    writeFileSync(join(extDir, "index.js"), "// extension");
    writeFileSync(join(extDir, "utils.js"), "// helper");

    const result = discoverExtensions(dir);
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].endsWith(join("my-hook", "index.js")));
  });

  it("混合单文件和多文件扩展", () => {
    const dir = join(tmpBase, "mixed");
    mkdirSync(dir);
    writeFileSync(join(dir, "aaa.js"), "");
    const extDir = join(dir, "bbb");
    mkdirSync(extDir);
    writeFileSync(join(extDir, "index.js"), "");

    const result = discoverExtensions(dir);
    assert.strictEqual(result.length, 2);
    // 按字母排序
    assert.ok(result[0].includes("aaa.js"));
    assert.ok(result[1].includes(join("bbb", "index.js")));
  });

  it("忽略隐藏文件和 .gitkeep", () => {
    const dir = join(tmpBase, "hidden");
    mkdirSync(dir);
    writeFileSync(join(dir, ".gitkeep"), "");
    writeFileSync(join(dir, ".DS_Store"), "");

    const result = discoverExtensions(dir);
    assert.deepStrictEqual(result, []);
  });

  it("忽略没有 index.js 的子目录", () => {
    const dir = join(tmpBase, "no-index");
    mkdirSync(dir);
    mkdirSync(join(dir, "broken-ext"));
    writeFileSync(join(dir, "broken-ext", "utils.js"), "");

    const result = discoverExtensions(dir);
    assert.deepStrictEqual(result, []);
  });
});
