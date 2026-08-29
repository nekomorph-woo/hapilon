import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExtensionConfigs } from "../../ensure-extension-configs.js";

describe("ensureExtensionConfigs()", () => {
  let agentDir: string;

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
});
