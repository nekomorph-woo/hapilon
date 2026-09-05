/**
 * trust-store 单元测试 — 命令+路径双维度信任存储
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isTrusted,
  isSessionTrusted,
  addTrust,
  clearSessionTrust,
  listSessionTrust,
  initProjectTrust,
} from "../../trust-store.js";

describe("trust-store", () => {
  let tmpBase: string;
  const ORIGINAL_ENV = process.env.HAPILON_HOME;

  before(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "hapilon-trust-"));
    process.env.HAPILON_HOME = join(tmpBase, "user-home");
    // 清除 session 级 trust
    clearSessionTrust();
  });

  after(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.HAPILON_HOME = ORIGINAL_ENV;
    } else {
      delete process.env.HAPILON_HOME;
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe("isTrusted() — session 级", () => {
    it("未添加 → false", () => {
      assert.strictEqual(isTrusted("write", ".env", "/tmp/proj"), false);
    });

    it("addTrust session → isTrusted → true", () => {
      addTrust("write", ".env", "session", "/tmp/proj");
      assert.strictEqual(isTrusted("write", ".env", "/tmp/proj"), true);
    });

    it("不同工具名 → false（命令维度独立）", () => {
      addTrust("write", ".env", "session", "/tmp/proj");
      assert.strictEqual(isTrusted("read", ".env", "/tmp/proj"), false);
    });

    it("不同路径 → false", () => {
      addTrust("write", ".env", "session", "/tmp/proj");
      assert.strictEqual(isTrusted("write", ".gitmodules", "/tmp/proj"), false);
    });

    it("clearSessionTrust → false", () => {
      addTrust("write", ".env", "session", "/tmp/proj");
      clearSessionTrust();
      assert.strictEqual(isTrusted("write", ".env", "/tmp/proj"), false);
    });
  });

  describe("block 路径信任", () => {
    it("block 路径 project 级 trust 不生效（isTrusted 会命中 project）", () => {
      const proj = join(tmpBase, "proj");
      const projHap = join(proj, ".hapilon");
      mkdirSync(projHap, { recursive: true });
      writeFileSync(join(projHap, "config.local.json"), JSON.stringify({
        allow: { write: ["id_rsa"] },
      }));

      // isTrusted 会同时查 session + project，所以 project trust 会生效
      // 调用方（hpl-protected-paths）对 block 路径应使用 isSessionTrusted
      assert.strictEqual(isTrusted("write", "id_rsa", proj), true, "isTrusted 查 project");

      // block 路径应用 isSessionTrusted — project 不生效
      assert.strictEqual(isSessionTrusted("write", "id_rsa"), false, "isSessionTrusted 不查 project");
    });

    it("block 路径 session 级 trust 生效", () => {
      addTrust("write", "id_rsa", "session", "/tmp/proj");
      assert.strictEqual(isSessionTrusted("write", "id_rsa"), true);
    });
  });

  describe("listSessionTrust()", () => {
    it("空列表", () => {
      clearSessionTrust();
      assert.deepStrictEqual(listSessionTrust(), []);
    });

    it("有信任项时列出", () => {
      addTrust("write", ".env", "session", "/tmp/proj");
      const list = listSessionTrust();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].toolName, "write");
      assert.strictEqual(list[0].targets[0], ".env");
    });
  });

  describe("initProjectTrust() 缓存（issue #15）", () => {
    it("init 后走缓存快照：外部改盘不反映", () => {
      const proj = join(tmpBase, "cache-proj");
      const projHap = join(proj, ".hapilon");
      mkdirSync(projHap, { recursive: true });
      writeFileSync(join(projHap, "config.local.json"), JSON.stringify({
        allow: { write: ["a"] },
      }));

      initProjectTrust(proj);
      // 外部直接改盘（不经 addProjectTrust）
      writeFileSync(join(projHap, "config.local.json"), JSON.stringify({
        allow: { write: ["a", "b"] },
      }));

      assert.strictEqual(isTrusted("write", "b", proj), false, "缓存快照不应看到外部新增 b");
      assert.strictEqual(isTrusted("write", "a", proj), true, "缓存快照保留初始项 a");
    });

    it("未 init 的 cwd 仍实时读盘", () => {
      const proj = join(tmpBase, "no-cache-proj");
      const projHap = join(proj, ".hapilon");
      mkdirSync(projHap, { recursive: true });
      writeFileSync(join(projHap, "config.local.json"), JSON.stringify({
        allow: { write: ["live"] },
      }));

      assert.strictEqual(isTrusted("write", "live", proj), true, "未 init 应实时读盘命中");
    });

    it("addProjectTrust 更新缓存，新增项立即可见", () => {
      const proj = join(tmpBase, "cache-proj2");
      const projHap = join(proj, ".hapilon");
      mkdirSync(projHap, { recursive: true });
      writeFileSync(join(projHap, "config.local.json"), JSON.stringify({
        allow: { write: ["a"] },
      }));

      initProjectTrust(proj);
      addTrust("write", "c", "project", proj);

      assert.strictEqual(isTrusted("write", "c", proj), true, "addTrust 后缓存应更新");
    });
  });
});
