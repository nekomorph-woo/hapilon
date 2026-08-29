import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSafetyExtensions,
  removeSafetyExtensions,
  partitionSafetyEntries,
  safetyExtensionPaths,
} from "../../safety-settings.js";

function readExtensions(agentDir: string): unknown {
  const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  return raw.extensions;
}

describe("safetyExtensionPaths()", () => {
  it("指向存在的 dist 产物", () => {
    for (const p of safetyExtensionPaths()) {
      assert.ok(existsSync(p), `安全门产物应存在（需先 npm run build）: ${p}`);
    }
  });
});

describe("partitionSafetyEntries()", () => {
  it("按路径后缀分离安全门与其它条目", () => {
    const { safety, others } = partitionSafetyEntries([
      "/anywhere/dist/extensions/hpl-safety-gate/index.js",
      "/user/own/ext.js",
      "/anywhere/dist/extensions/hpl-protected-paths/index.js",
    ]);
    assert.equal(safety.length, 2);
    assert.deepEqual(others, ["/user/own/ext.js"]);
  });

  it("非数组与非字符串条目不抛错", () => {
    const { safety, others } = partitionSafetyEntries(["/x.js", 42, null, ["nested"]]);
    assert.equal(safety.length, 0);
    assert.deepEqual(others, ["/x.js"]);
  });
});

describe("ensureSafetyExtensions() / removeSafetyExtensions()", () => {
  let agentDir: string;

  before(() => {
    agentDir = mkdtempSync(join(tmpdir(), "hapilon-safety-test-"));
  });

  after(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("agentDir 不存在时创建目录并写入", () => {
    const fresh = join(agentDir, "not-yet");
    ensureSafetyExtensions(fresh);
    const ext = readExtensions(fresh) as string[];
    assert.equal(ext.length, 2);
    assert.ok(ext[0].endsWith("hpl-safety-gate/index.js"));
  });

  it("幂等：重复调用不产生重复条目", () => {
    ensureSafetyExtensions(agentDir);
    ensureSafetyExtensions(agentDir);
    const ext = readExtensions(agentDir) as string[];
    assert.equal(ext.length, 2);
  });

  it("保留 settings 中已有的其它键与 extensions 条目", () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ quietStartup: true, theme: "dark", extensions: ["/user/own/ext.js"] }),
    );
    ensureSafetyExtensions(agentDir);
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(raw.quietStartup, true);
    assert.equal(raw.theme, "dark");
    assert.equal((raw.extensions as string[]).length, 3);
  });

  it("stale 条目（旧安装位置）被替换为当前路径", () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        extensions: ["/old/install/dist/extensions/hpl-safety-gate/index.js", "/user/own/ext.js"],
      }),
    );
    ensureSafetyExtensions(agentDir);
    const ext = readExtensions(agentDir) as string[];
    assert.ok(!ext.some((e) => e.startsWith("/old/install")));
    assert.equal(ext.filter((e) => e.includes("hpl-")).length, 2);
  });

  it("removeSafetyExtensions 只移除安全门条目", () => {
    ensureSafetyExtensions(agentDir);
    removeSafetyExtensions(agentDir);
    const ext = readExtensions(agentDir) as string[];
    assert.deepEqual(ext, ["/user/own/ext.js"]);
  });

  it("损坏的 settings.json：warn 且不动原文件", () => {
    const settingsPath = join(agentDir, "settings.json");
    const broken = "{ not valid json";
    writeFileSync(settingsPath, broken);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      ensureSafetyExtensions(agentDir);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(readFileSync(settingsPath, "utf8"), broken);
    assert.ok(warnings.some((w) => w.includes("解析失败")));
  });

  it("非 object 的 settings.json（数组）：warn 且不动原文件", () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, "[1,2,3]");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      ensureSafetyExtensions(agentDir);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(readFileSync(settingsPath, "utf8"), "[1,2,3]");
    assert.ok(warnings.some((w) => w.includes("不是 JSON object")));
  });
});
