import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExtensionConfigs } from "../../extensions/ensure-configs.js";

describe("ensureExtensionConfigs()", () => {
  let agentDir: string;

  before(() => {
    agentDir = mkdtempSync(join(tmpdir(), "hapilon-ext-config-"));
  });

  after(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("首次调用写入 tasks-config.json（autoCascade: true，taskScope: session-global）", () => {
    ensureExtensionConfigs(agentDir);
    const path = join(agentDir, "tasks-config.json");
    assert.ok(existsSync(path));
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(cfg.autoCascade, true);
    assert.equal(cfg.taskScope, "session-global", "任务文件落 agentDir，不进用户仓库");
  });

  it("存量安装：已有 tasks-config.json 缺失的默认键被补齐，且重复调用不重写", () => {
    const fresh = join(agentDir, "tasks-backfill");
    mkdirSync(fresh, { recursive: true });
    const path = join(fresh, "tasks-config.json");
    writeFileSync(path, JSON.stringify({ autoCascade: true }, null, 2));
    ensureExtensionConfigs(fresh);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(cfg.taskScope, "session-global", "新增默认键落到存量文件");
    assert.equal(cfg.autoCascade, true);
    const afterFirst = readFileSync(path, "utf8");
    ensureExtensionConfigs(fresh);
    assert.equal(readFileSync(path, "utf8"), afterFirst, "键齐了就不再写");
  });

  it("补齐缺失键时不覆盖用户已设置的键", () => {
    const fresh = join(agentDir, "tasks-backfill-keep");
    mkdirSync(fresh, { recursive: true });
    const path = join(fresh, "tasks-config.json");
    writeFileSync(path, JSON.stringify({ taskScope: "project", autoCascade: false, maxVisible: 7 }, null, 2));
    ensureExtensionConfigs(fresh);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(cfg.taskScope, "project", "用户显式选的 scope 不被默认值顶掉");
    assert.equal(cfg.autoCascade, false);
    assert.equal(cfg.maxVisible, 7);
  });

  it("首次调用写入 web-search.json（workflow: none：不弹 curator 浏览器）", () => {
    ensureExtensionConfigs(agentDir);
    const path = join(agentDir, "web-search.json");
    assert.ok(existsSync(path));
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(cfg.workflow, "none");
  });

  it("首次调用写入 mcp.json 骨架并预置 web-access MCP 条目", () => {
    ensureExtensionConfigs(agentDir);
    const path = join(agentDir, "mcp.json");
    assert.ok(existsSync(path));
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(cfg.mcpServers["web-access"], "web-access 开箱预置");
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

  it("主题清理：hapilon 主题残留被剔除，回落 pi 内置主题", () => {
    const fresh = join(agentDir, "themes-cleanup");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(
      join(fresh, "settings.json"),
      JSON.stringify({ theme: "hapilon-light/hapilon-dark", themes: ["/old/checkout/resources/themes", "/tmp/my-themes"] }, null, 2),
    );
    ensureExtensionConfigs(fresh);
    const settings = JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8"));
    assert.equal(settings.theme, undefined, "hapilon-* 主题选择被清除");
    assert.deepEqual(settings.themes, ["/tmp/my-themes"], "仅保留用户自装主题");
  });

  it("主题清理幂等：无残留且已种 defaultTools 时 settings.json 不被重写", () => {
    const fresh = join(agentDir, "themes-clean-idem");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(
      join(fresh, "settings.json"),
      JSON.stringify({ theme: "dark", defaultTools: ["+codemode"], tuiMode: "regular" }, null, 2),
    );
    const before = readFileSync(join(fresh, "settings.json"), "utf8");
    ensureExtensionConfigs(fresh);
    assert.equal(readFileSync(join(fresh, "settings.json"), "utf8"), before);
  });

  it("defaultTools/tuiMode 未设置时种子（tool_search + codemode + regular）", () => {
    const fresh = join(agentDir, "settings-seed");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
    ensureExtensionConfigs(fresh);
    const settings = JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8"));
    assert.deepEqual(settings.defaultTools, ["+tool_search", "+codemode"]);
    assert.equal(settings.tuiMode, "regular");
    // 二次调用幂等，且用户显式配置不被覆盖
    writeFileSync(join(fresh, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }, null, 2));
    ensureExtensionConfigs(fresh);
    assert.equal(JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8")).tuiMode, "fullscreen");
  });

  it("存量 defaultTools 数组追加 +codemode，用户条目保留；-codemode 显式关闭不补", () => {
    const fresh = join(agentDir, "settings-append");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "settings.json"), JSON.stringify({ defaultTools: ["+tool_search"] }, null, 2));
    ensureExtensionConfigs(fresh);
    assert.deepEqual(
      JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8")).defaultTools,
      ["+tool_search", "+codemode"],
      "缺则追加，已有条目不动",
    );
    writeFileSync(join(fresh, "settings.json"), JSON.stringify({ defaultTools: ["-codemode", "+tool_search"] }, null, 2));
    ensureExtensionConfigs(fresh);
    assert.deepEqual(
      JSON.parse(readFileSync(join(fresh, "settings.json"), "utf8")).defaultTools,
      ["-codemode", "+tool_search"],
      "-codemode 是显式关闭，不再补回",
    );
  });

  it("web-access MCP 预置：首次种子 stdio 条目（node + mcp-cli 绝对路径 + env 钉配置目录）", () => {
    const fresh = join(agentDir, "webaccess-seed");
    ensureExtensionConfigs(fresh);
    const cfg = JSON.parse(readFileSync(join(fresh, "mcp.json"), "utf8"));
    const entry = cfg.mcpServers["web-access"];
    assert.ok(entry, "web-access 条目被种入");
    assert.equal(entry.type, "stdio");
    assert.equal(entry.command, process.execPath, "command 是当前 node 可执行，跨平台不依赖 PATH");
    assert.ok(entry.args[0].includes(join("pi-web-access", "dist", "mcp-cli.js")), `args[0] 指向 mcp-cli: ${entry.args[0]}`);
    assert.ok(existsSync(entry.args[0]), "mcp-cli.js 真实存在");
    assert.equal(entry.env.PI_CODING_AGENT_DIR, fresh, "env 钉住配置目录，与主会话同源 web-search.json");
  });

  it("web-access MCP 预置：用户已有同名条目或其他 server 时保留，不覆盖", () => {
    const fresh = join(agentDir, "webaccess-keep");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(
      join(fresh, "mcp.json"),
      JSON.stringify({ mcpServers: { "web-access": { type: "stdio", command: "my-own" }, other: { type: "http", url: "https://x" } } }, null, 2),
    );
    ensureExtensionConfigs(fresh);
    const cfg = JSON.parse(readFileSync(join(fresh, "mcp.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers["web-access"], { type: "stdio", command: "my-own" }, "用户自定义 web-access 不被顶掉");
    assert.deepEqual(cfg.mcpServers.other, { type: "http", url: "https://x" }, "相邻 server 保留");
  });

  it("web-access MCP 预置：损坏 mcp.json 不碰，二次调用幂等不重写", () => {
    const fresh = join(agentDir, "webaccess-corrupt");
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, "mcp.json"), "{ broken");
    ensureExtensionConfigs(fresh);
    assert.equal(readFileSync(join(fresh, "mcp.json"), "utf8"), "{ broken", "损坏文件原样保留");

    const seeded = join(agentDir, "webaccess-idem");
    ensureExtensionConfigs(seeded);
    const afterFirst = readFileSync(join(seeded, "mcp.json"), "utf8");
    ensureExtensionConfigs(seeded);
    assert.equal(readFileSync(join(seeded, "mcp.json"), "utf8"), afterFirst, "条目在就不再写");
  });

  it("pi-goal-x 预置：种子 maxAutonomousRuns=25，用户已设的键不碰", () => {
    const fresh = join(agentDir, "goalx-seed");
    ensureExtensionConfigs(fresh);
    const cfg = JSON.parse(readFileSync(join(fresh, "pi-goal-x-settings.json"), "utf8"));
    assert.equal(cfg.maxAutonomousRuns, 25);

    const keep = join(agentDir, "goalx-keep");
    ensureExtensionConfigs(keep);
    writeFileSync(join(keep, "pi-goal-x-settings.json"), JSON.stringify({ maxAutonomousRuns: 5 }));
    ensureExtensionConfigs(keep);
    assert.equal(JSON.parse(readFileSync(join(keep, "pi-goal-x-settings.json"), "utf8")).maxAutonomousRuns, 5, "用户已设值保留");
  });
});
