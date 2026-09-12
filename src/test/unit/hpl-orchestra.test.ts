import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import hplOrchestra from "../../extensions/hpl-orchestra/index.js";
import { handleTeamCommand } from "../../extensions/hpl-orchestra/menu.js";
import {
  buildTeamSections,
  currentRole,
  isTeamOwner,
  readTeamState,
  resolveSessionStatePath,
  writeTeamStateEffect,
  type TeamState,
} from "../../extensions/hpl-orchestra/state.js";
import { resetTeamSections, setTeamSections } from "../../extensions/hpl-orchestra/bridge.js";
import { fillOrchestratorSection, ORCHESTRATOR_SECTION, REVIEWER_SECTION, WORKER_SECTION } from "../../extensions/hpl-orchestra/roles.js";
import type { SpawnFn } from "../../extensions/hpl-orchestra/herdr.js";
import hplSystemPrompt from "../../extensions/hpl-system-prompt/index.js";

const originalEnv = {
  home: process.env.HAPILON_HOME,
  herdr: process.env.HERDR_ENV,
  pane: process.env.HERDR_PANE_ID,
  role: process.env.HAPI_ORCH_ROLE,
  cliPath: process.env.HAPILON_CLI_PATH,
};

let home: string;

const stateFor = (overrides: Partial<TeamState> = {}): TeamState => ({
  enabled: true,
  since: "2026-09-12T10:00:00.000Z",
  owner: { paneId: "w1:p7" },
  roles: {
    worker: { paneId: "w1:p8", model: "anthropic/sonnet" },
    reviewer: { paneId: null, model: null },
  },
  ...overrides,
});

function statePath(): string {
  return resolveSessionStatePath();
}

function saveState(state = stateFor()): void {
  Effect.runSync(writeTeamStateEffect(state, statePath()));
}

function makeContext(selections: string[] = []) {
  const selectedTitles: string[] = [];
  const selectedOptions: string[][] = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx = {
    cwd: "/project",
    ui: {
      select: async (title: string, options: string[]) => {
        selectedTitles.push(title);
        selectedOptions.push(options);
        return selections.shift();
      },
      notify: (message: string, type?: string) => notices.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
    },
  };
  return { ctx: ctx as never, selectedTitles, selectedOptions, notices, statuses };
}

function makePi() {
  const commands = new Map<string, { handler: Function }>();
  const events = new Map<string, Function>();
  const sent: string[] = [];
  const pi = {
    registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
    on: (event: string, handler: Function) => events.set(event, handler),
    sendUserMessage: (message: string) => sent.push(message),
  } as never;
  return { pi, commands, events, sent };
}

/**
 * mock herdr 输出。真实响应形状（herdr api schema，勿改字段名）：
 *   pane get  → { result: { pane: { pane_id, ... } } }
 *   agent get → { result: { agent: { agent_status, pane_id, ... } } }  // 字段是 agent_status！
 *   pane split→ { result: { pane: { pane_id } } }
 */
function makeSpawn(options: { paneId?: string; agentStatuses?: string[]; failReady?: boolean } = {}) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const paneId = options.paneId ?? "w1:p8";
  const statuses = [...(options.agentStatuses ?? [])];
  const spawn: SpawnFn = (bin, args) => {
    calls.push({ bin, args });
    if (args[0] === "pane" && args[1] === "get") {
      if (options.failReady) return { status: 1, stderr: "pane gone" };
      return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: args[2] } } }) };
    }
    if (args[0] === "pane" && args[1] === "split") {
      return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }) };
    }
    if (args[0] === "agent" && args[1] === "get") {
      if (options.failReady) return { status: 0, stdout: "{}" };
      return {
        status: 0,
        stdout: JSON.stringify({ result: { agent: { agent_status: statuses.shift() ?? "idle", pane_id: paneId } } }),
      };
    }
    if (args[0] === "pane" && args[1] === "close") {
      return { status: 0, stdout: JSON.stringify({ result: {} }) };
    }
    return { status: 0, stdout: "{}" };
  };
  return { spawn, calls };
}

function promptHandler() {
  const mock = makePi();
  hplSystemPrompt(mock.pi);
  return mock.events.get("before_agent_start")!;
}

function promptOptions() {
  return {
    cwd: "/project",
    toolSnippets: {},
    selectedTools: [],
    contextFiles: [],
    skills: [],
  };
}

beforeEach(() => {
  rmSync(statePath(), { force: true });
  rmSync(join(home, "model-tiers-resolved.json"), { force: true });
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p7";
  process.env.HAPILON_CLI_PATH = "/fake/dist/cli.js";
  delete process.env.HAPI_ORCH_ROLE;
  resetTeamSections();
});

before(() => {
  home = mkdtempSync(join(tmpdir(), "hapilon-orchestra-test-"));
  process.env.HAPILON_HOME = home;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p7";
  process.env.HAPILON_CLI_PATH = "/fake/dist/cli.js";
  delete process.env.HAPI_ORCH_ROLE;
});

after(() => {
  if (originalEnv.home === undefined) delete process.env.HAPILON_HOME;
  else process.env.HAPILON_HOME = originalEnv.home;
  if (originalEnv.herdr === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalEnv.herdr;
  if (originalEnv.pane === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = originalEnv.pane;
  if (originalEnv.role === undefined) delete process.env.HAPI_ORCH_ROLE;
  else process.env.HAPI_ORCH_ROLE = originalEnv.role;
  if (originalEnv.cliPath === undefined) delete process.env.HAPILON_CLI_PATH;
  else process.env.HAPILON_CLI_PATH = originalEnv.cliPath;
  rmSync(home, { recursive: true, force: true });
});

describe("hpl-orchestra state", { concurrency: false }, () => {
  it("状态文件 roundtrip，损坏 JSON 降级为 enabled=false", () => {
    saveState();
    assert.deepEqual(readTeamState(statePath()), stateFor());
    writeFileSync(statePath(), "{broken json", "utf8");
    assert.deepEqual(readTeamState(statePath()), { enabled: false });
  });

  it("owner pane 不符时不注入 orchestrator", () => {
    saveState();
    process.env.HERDR_PANE_ID = "w1:other";
    assert.deepEqual(buildTeamSections(), {});
    process.env.HERDR_PANE_ID = "w1:p7";
    assert.equal(isTeamOwner(stateFor()), true);
  });

  it("状态文件按 pane id 绑定（冒号转下划线）", () => {
    process.env.HERDR_PANE_ID = "w1:p7";
    assert.ok(statePath().endsWith("w1_p7.json"));
    process.env.HERDR_PANE_ID = "w9:p1";
    assert.ok(statePath().endsWith("w9_p1.json"));
    process.env.HERDR_PANE_ID = "w1:p7";
  });

  it("currentRole 只接受 worker/reviewer，其他值视为无角色", () => {
    delete process.env.HAPI_ORCH_ROLE;
    assert.equal(currentRole(), undefined);
    process.env.HAPI_ORCH_ROLE = "worker";
    assert.equal(currentRole(), "worker");
    process.env.HAPI_ORCH_ROLE = "reviewer";
    assert.equal(currentRole(), "reviewer");
    process.env.HAPI_ORCH_ROLE = "orchestrator";
    assert.equal(currentRole(), undefined);
    delete process.env.HAPI_ORCH_ROLE;
  });
});

describe("hpl-orchestra roles and menus", { concurrency: false }, () => {
  it("fillOrchestratorSection 替换真实 pane id，并保留未打开 reviewer 指引", () => {
    const filled = fillOrchestratorSection("w1:p8", null);
    assert.ok(filled.includes("worker w1:p8"));
    assert.ok(filled.includes("reviewer not open"));
    assert.ok(filled.includes("tell the\n  user to open it via /team menu"));
    assert.ok(!filled.includes("<WORKER_PANE>"));
    assert.ok(!filled.includes("<REVIEWER_PANE>"));
  });

  it("主面板 enabled/disabled 菜单与角色面板菜单形态正确", async () => {
    delete process.env.HAPI_ORCH_ROLE;
    const disabled = makeContext();
    const noSpawn = makeSpawn();
    await handleTeamCommand(makePi().pi, "", disabled.ctx, noSpawn.spawn);
    assert.deepEqual(disabled.selectedOptions[0], ["开始编排", "打开 Review 面板", "查看面板分工"]);

    saveState();
    const enabled = makeContext();
    await handleTeamCommand(makePi().pi, "", enabled.ctx, noSpawn.spawn);
    assert.deepEqual(enabled.selectedOptions[0], [
      "暂停编排", "结束编排", "清空面板上下文", "打开 Review 面板", "派发给 Worker", "查看面板分工",
    ]);

    process.env.HAPI_ORCH_ROLE = "worker";
    const worker = makeContext(["查看面板分工"]);
    await handleTeamCommand(makePi().pi, "", worker.ctx, noSpawn.spawn);
    assert.deepEqual(worker.selectedOptions[0], ["查看面板分工"]);
    process.env.HAPI_ORCH_ROLE = "reviewer";
    const reviewer = makeContext(["查看面板分工"]);
    await handleTeamCommand(makePi().pi, "", reviewer.ctx, noSpawn.spawn);
    assert.deepEqual(reviewer.selectedOptions[0], ["查看面板分工"]);
    delete process.env.HAPI_ORCH_ROLE;
  });

  it("角色面板拒绝写操作", async () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    const ctx = makeContext();
    await handleTeamCommand(makePi().pi, "开始编排", ctx.ctx, makeSpawn().spawn);
    assert.ok(ctx.notices.some(({ message, type }) => type === "error" && message.includes("拒绝写操作")));
    delete process.env.HAPI_ORCH_ROLE;
  });

  it("无 HERDR_ENV 时 /team 报错且不弹菜单", async () => {
    delete process.env.HERDR_ENV;
    const mock = makePi();
    hplOrchestra(mock.pi);
    const ctx = makeContext();
    await mock.commands.get("team")!.handler("", ctx.ctx);
    assert.equal(ctx.selectedOptions.length, 0);
    assert.equal(ctx.notices[0].type, "error");
    process.env.HERDR_ENV = "1";
  });
});

describe("hpl-orchestra pane actions", { concurrency: false }, () => {
  it("开始编排 split/run 参数正确：--current/--env 注入/--model", async () => {
    delete process.env.HAPI_ORCH_ROLE;
    writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
      sonnet: [{ provider: "anthropic", id: "claude-sonnet" }],
      opus: [],
    }));
    const { spawn, calls } = makeSpawn({ agentStatuses: ["idle"] });
    const ctx = makeContext(["开始编排"]);
    await handleTeamCommand(makePi().pi, "", ctx.ctx, spawn);
    const split = calls.find((call) => call.args[0] === "pane" && call.args[1] === "split");
    const run = calls.find((call) => call.args[0] === "pane" && call.args[1] === "run");
    assert.ok(split, "expected a pane split call");
    assert.ok(run, "expected a pane run call");
    assert.ok(split?.args.includes("--current"));
    assert.ok(split.args.includes("--direction"));
    assert.deepEqual(
      split.args.filter((arg, i) => arg === "--env" && split.args[i + 1]?.startsWith("HAPI_ORCH_ROLE=")).length === 1
        && split.args.includes("HAPI_ORCH_ROLE=worker"),
      true,
    );
    assert.equal(run.args[2], "w1:p8");
    assert.match(run.args[3], /cli\.js --model anthropic\/claude-sonnet$/);
    assert.ok(run.args[3].startsWith(process.execPath), "run command must use process.execPath, not bare node");
    const started = readTeamState(statePath());
    assert.equal(started.enabled, true);
    assert.deepEqual(started.roles, {
      worker: { paneId: "w1:p8", model: "anthropic/claude-sonnet" },
      reviewer: { paneId: null, model: null },
    });
    assert.equal(Number.isNaN(Date.parse(started.since)), false);
  });

  it("resolved model 缺失时省略 --model，暂停后开始复用活面板", async () => {
    rmSync(join(home, "model-tiers-resolved.json"), { force: true });
    const first = makeSpawn({ agentStatuses: ["idle"] });
    const ctx = makeContext(["开始编排"]);
    await handleTeamCommand(makePi().pi, "", ctx.ctx, first.spawn);
    const firstRun = first.calls.find((call) => call.args[1] === "run");
    assert.ok(firstRun);
    assert.ok(!firstRun.args[3].includes("--model"));

    await handleTeamCommand(makePi().pi, "暂停编排", ctx.ctx, first.spawn);
    const beforeReuse = first.calls.length;
    const secondCtx = makeContext(["开始编排"]);
    await handleTeamCommand(makePi().pi, "", secondCtx.ctx, first.spawn);
    const reuseCalls = first.calls.slice(beforeReuse);
    assert.equal(reuseCalls.some((call) => call.args[1] === "split"), false);
    assert.equal(reuseCalls.some((call) => call.args[1] === "get" && call.args[0] === "pane"), true);
  });

  it("面板启动后未就绪时回收面板（pane close）", async () => {
    delete process.env.HAPI_ORCH_ROLE;
    const { spawn, calls } = makeSpawn({ failReady: true });
    const ctx = makeContext(["开始编排"]);
    await handleTeamCommand(makePi().pi, "", ctx.ctx, spawn);
    assert.ok(calls.some((call) => call.args[1] === "close"));
    assert.ok(ctx.notices.some(({ message }) => message.includes("未就绪")));
    assert.equal(existsSync(statePath()), false);
  });

  it("清空面板：working 拒绝，idle 使用逐字符 send-keys 并轮询复查", async () => {
    saveState();
    const working = makeSpawn({ agentStatuses: ["working"] });
    const workingCtx = makeContext(["Worker"]);
    await handleTeamCommand(makePi().pi, "清空面板上下文", workingCtx.ctx, working.spawn);
    assert.ok(workingCtx.notices.some(({ message }) => message.includes("Worker 正在工作中，等它完成后重试")));
    assert.equal(working.calls.some((call) => call.args[1] === "send-keys"), false);

    const idle = makeSpawn({ agentStatuses: ["idle", "done"] });
    const idleCtx = makeContext(["Worker"]);
    await handleTeamCommand(makePi().pi, "清空面板上下文", idleCtx.ctx, idle.spawn);
    const clear = idle.calls.find((call) => call.args[1] === "send-keys");
    assert.deepEqual(clear?.args, ["agent", "send-keys", "w1:p8", "/", "n", "e", "w", "enter"]);
  });

  it("reviewer 懒创建使用 opus 档", async () => {
    delete process.env.HAPI_ORCH_ROLE;
    writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
      sonnet: [{ provider: "anthropic", id: "claude-sonnet" }],
      opus: [{ provider: "anthropic", id: "claude-opus" }],
    }));
    saveState();
    const { spawn, calls } = makeSpawn({ paneId: "w1:p9", agentStatuses: ["idle"] });
    const ctx = makeContext(["打开 Review 面板"]);
    await handleTeamCommand(makePi().pi, "", ctx.ctx, spawn);
    const run = calls.find((call) => call.args[0] === "pane" && call.args[1] === "run");
    assert.ok(run);
    assert.ok(run.args[3].includes("--model anthropic/claude-opus"));
    const updated = readTeamState(statePath());
    assert.deepEqual((updated as TeamState).roles.reviewer, { paneId: "w1:p9", model: "anthropic/claude-opus" });
  });

  it("暂停保留 roles，结束时状态文件消失；无文件时结束返回提示", async () => {
    saveState();
    const ctx = makeContext();
    await handleTeamCommand(makePi().pi, "暂停编排", ctx.ctx, makeSpawn().spawn);
    const paused = readTeamState(statePath());
    assert.equal(paused.enabled, false);
    assert.deepEqual((paused as TeamState).roles, stateFor().roles);
    await handleTeamCommand(makePi().pi, "结束编排", ctx.ctx, makeSpawn().spawn);
    assert.equal(existsSync(statePath()), false);
    const ctx2 = makeContext();
    await handleTeamCommand(makePi().pi, "结束编排", ctx2.ctx, makeSpawn().spawn);
    assert.ok(ctx2.notices.some(({ message }) => message.includes("没有可结束") || message.includes("没有进行中")));
  });
});

describe("hpl-orchestra system prompt exclusivity", { concurrency: false }, () => {
  it("worker/reviewer/orchestrator 三种场景每次最多注入一个 team section", async () => {
    const handler = promptHandler();

    process.env.HAPI_ORCH_ROLE = "worker";
    setTeamSections({ role: "worker" });
    let result = await handler({ systemPromptOptions: promptOptions() }, {});
    assert.ok(result.systemPrompt.includes(WORKER_SECTION));
    assert.equal((result.systemPrompt.match(/<team mode=/g) ?? []).length, 1);

    process.env.HAPI_ORCH_ROLE = "reviewer";
    setTeamSections({ role: "reviewer" });
    result = await handler({ systemPromptOptions: promptOptions() }, {});
    assert.ok(result.systemPrompt.includes(REVIEWER_SECTION));
    assert.equal((result.systemPrompt.match(/<team mode=/g) ?? []).length, 1);

    delete process.env.HAPI_ORCH_ROLE;
    saveState();
    setTeamSections({
      orchestrator: fillOrchestratorSection("w1:p8", stateFor().roles.reviewer.paneId),
    });
    result = await handler({ systemPromptOptions: promptOptions() }, {});
    assert.ok(result.systemPrompt.includes("<team mode=\"orchestrator\">"));
    assert.ok(result.systemPrompt.includes("worker w1:p8"));
    assert.equal((result.systemPrompt.match(/<team mode=/g) ?? []).length, 1);
    assert.equal(ORCHESTRATOR_SECTION.includes("<WORKER_PANE>"), true);
  });

  it("hpl-orchestra 的 before_agent_start 每轮现读状态写入 bridge", async () => {
    const mock = makePi();
    hplOrchestra(mock.pi);
    const handler = mock.events.get("before_agent_start")!;
    saveState();
    await handler({}, makeContext().ctx);
    const sections = (await import("../../extensions/hpl-orchestra/bridge.js")).getTeamSections();
    assert.ok(sections.orchestrator?.includes("worker w1:p8"));

    resetTeamSections();
    process.env.HERDR_PANE_ID = "w1:other";
    await handler({}, makeContext().ctx);
    const empty = (await import("../../extensions/hpl-orchestra/bridge.js")).getTeamSections();
    assert.deepEqual(empty, {});
    process.env.HERDR_PANE_ID = "w1:p7";
  });
});
