/**
 * project-config 单元测试 — 项目级 .hapilon/ 配置 I/O
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectHapilonDir,
  readProjectConfig,
  writeProjectLocalConfig,
} from "../../project-config.js";

describe("project-config", () => {
  let tmpBase: string;
  const ORIGINAL_ENV = process.env.HAPILON_HOME;

  before(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "hapilon-pcfg-"));
    process.env.HAPILON_HOME = join(tmpBase, "user-home");
  });

  after(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.HAPILON_HOME = ORIGINAL_ENV;
    } else {
      delete process.env.HAPILON_HOME;
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe("projectHapilonDir()", () => {
    it("返回项目 .hapilon/ 路径", () => {
      assert.ok(projectHapilonDir("/tmp/proj").endsWith("/.hapilon"));
    });
  });

  describe("readProjectConfig()", () => {
    it("项目无 .hapilon/ 时返回用户级配置", () => {
      // 写入用户级配置
      const userHome = join(tmpBase, "user-home");
      mkdirSync(userHome, { recursive: true });
      writeFileSync(join(userHome, "config.json"), JSON.stringify({ defaultProvider: "deepseek" }));

      const proj = join(tmpBase, "noproj");
      const config = readProjectConfig(proj);
      assert.strictEqual(config.defaultProvider, "deepseek");
    });

    it("项目 config.json 覆盖用户级同名配置", () => {
      const userHome = join(tmpBase, "user-home");
      writeFileSync(join(userHome, "config.json"), JSON.stringify({ defaultProvider: "deepseek", defaultModel: "base" }));

      const proj = join(tmpBase, "proj1");
      const projHap = join(proj, ".hapilon");
      mkdirSync(projHap, { recursive: true });
      writeFileSync(join(projHap, "config.json"), JSON.stringify({ defaultProvider: "openai" }));

      const config = readProjectConfig(proj);
      assert.strictEqual(config.defaultProvider, "openai", "项目级覆盖用户级");
      assert.strictEqual(config.defaultModel, "base", "用户级未覆盖的保留");
    });

    it("config.local.json 覆盖 config.json", () => {
      const proj = join(tmpBase, "proj2");
      const projHap = join(proj, ".hapilon");
      mkdirSync(projHap, { recursive: true });
      writeFileSync(join(projHap, "config.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt4" }));
      writeFileSync(join(projHap, "config.local.json"), JSON.stringify({ defaultModel: "local-model" }));

      const config = readProjectConfig(proj);
      assert.strictEqual(config.defaultProvider, "openai", "config.json 的值保留");
      assert.strictEqual(config.defaultModel, "local-model", "config.local.json 覆盖");
    });

    it("config.local.json 中的 allow 字段可读取", () => {
      const proj = join(tmpBase, "proj3");
      const projHap = join(proj, ".hapilon");
      mkdirSync(projHap, { recursive: true });
      writeFileSync(join(projHap, "config.local.json"), JSON.stringify({
        allow: { write: [".env"], bash: ["rm -rf node_modules"] },
      }));

      const config = readProjectConfig(proj);
      assert.ok(config.allow, "allow 字段应存在");
      assert.deepStrictEqual(config.allow?.write, [".env"]);
      assert.deepStrictEqual(config.allow?.bash, ["rm -rf node_modules"]);
    });

    it("config.local.json 不存在时 allow 为 undefined", () => {
      const proj = join(tmpBase, "proj4");
      const config = readProjectConfig(proj);
      assert.strictEqual(config.allow, undefined);
    });
  });

  describe("writeProjectLocalConfig()", () => {
    it("写入 config.local.json 并读回", () => {
      const proj = join(tmpBase, "proj5");
      writeProjectLocalConfig({ allow: { write: [".env"] } }, proj);

      const config = readProjectConfig(proj);
      assert.ok(config.allow);
      assert.deepStrictEqual(config.allow?.write, [".env"]);
    });

    it("覆盖已有 config.local.json 的 allow 字段", () => {
      const proj = join(tmpBase, "proj6");
      writeProjectLocalConfig({ allow: { write: [".env"] } }, proj);
      writeProjectLocalConfig({ allow: { write: [".env", ".gitmodules"] } }, proj);

      const config = readProjectConfig(proj);
      assert.deepStrictEqual(config.allow?.write, [".env", ".gitmodules"]);
    });

    it("保留其他本地配置字段", () => {
      const proj = join(tmpBase, "proj7");
      const projHap = join(proj, ".hapilon");
      mkdirSync(projHap, { recursive: true });
      // 手动写入含非 allow 字段的 local config
      writeFileSync(join(projHap, "config.local.json"), JSON.stringify({ defaultModel: "local", allow: { write: [".env"] } }));

      // 仅更新 allow
      writeProjectLocalConfig({ allow: { write: [".env", ".github"] } }, proj);

      const config = readProjectConfig(proj);
      assert.strictEqual(config.defaultModel, "local", "非 allow 字段应保留");
      assert.deepStrictEqual(config.allow?.write, [".env", ".github"], "allow 字段被覆盖");
    });
  });
});
