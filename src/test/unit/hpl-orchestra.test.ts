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
  type SessionManagerIdentity,
  type TeamState,
} from "../../extensions/hpl-orchestra/state.js";
import { fillOrchestratorSection, ORCHESTRATOR_SECTION, REVIEWER_SECTION, WORKER_SECTION } from "../../extensions/hpl-orchestra/roles.js";
import type { SpawnFn } from "../../extensions/hpl-orchestra/herdr.js";
import hplSystemPrompt from "../../extensions/hpl-system-prompt/index.js";

const originalEnv = {
  home: process.env.HAPILON_HOME,
  herdr: process.env.HERDR_ENV,
  pane: process.env.HERDR_PANE_ID,
  role: process.env.HAPI_ORCH_ROLE,
  session: process.env.HAPI_ORCH_SESSION_ROOT_ID,
};

let home: string;

const manager = (id = "root-session"): SessionManagerIdentity => ({
  getHeader: () => ({ id }),
  getSessionId: () => id,
});

const stateFor = (overrides: Partial<TeamState> = {}): TeamState => ({
  enabled: true,
  since: "2026-09-12T10:00:00.000Z",
  owner: { paneId: "w1:p7", sessionRootId: "root-session" },
  roles: {
    worker: { paneId: "w1:p8", model: "anthropic/sonnet" },
    reviewer: { paneId: null, model: null },
  },
  ...overrides,
});

function statePath(): string {
  return resolveSessionStatePath(manager());
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
    sessionManager: manager(),
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

function makeSpawn(options: { paneId?: string; agentStatuses?: string[] } = {}) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const paneId = options.paneId ?? "w1:p8";
  const statuses = [...(options.agentStatuses ?? [])];
  const spawn: SpawnFn = (bin, args) => {
    calls.push({ bin, args });
    if (args[0] === "pane" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: args[2] } } }) };
    }
    if (args[0] === "pane" && args[1] === "split") {
      return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }) };
    }
    if (args[0] === "agent" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent: { status: statuses.shift() ?? "idle" } } }) };
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
  delete process.env.HAPI_ORCH_ROLE;
});

before(() => {
  home = mkdtempSync(join(tmpdir(), "hapilon-orchestra-test-"));
  process.env.HAPILON_HOME = home;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p7";
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
  if (originalEnv.session === undefined) delete process.env.HAPI_ORCH_SESSION_ROOT_ID;
  else process.env.HAPI_ORCH_SESSION_ROOT_ID = originalEnv.session;
  rmSync(home, { recursive: true, force: true });
});

describe("hpl-orchestra state", { concurrency: false }, () => {
  it("状态文件 roundtrip，损坏 JSON 降级为 enabled=false", () => {
    saveState();
    assert.deepEqual(readTeamState(statePath()), stateFor());
    writeFileSync(statePath(), "{broken json", "utf8");
    assert.deepEqual(readTeamState(statePath()), { enabled: false });
  });

  it("owner pane 或 session root 不符时不注入 orchestrator", () => {
    saveState();
    process.env.HERDR_PANE_ID = "w1:other";
    assert.deepEqual(buildTeamSections(manager()), {});
    process.env.HERDR_PANE_ID = "w1:p7";
    assert.equal(isTeamOwner(stateFor(), manager("other-session")), false);
    assert.deepEqual(buildTeamSections(manager("other-session")), {});
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
  it("开始编排 split/run 参数正确，含角色前缀与 resolved sonnet model", async () => {
    delete process.env.HAPI_ORCH_ROLE;
    writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
      sonnet: [{ provider: "anthropic", id: "claude-sonnet" }],
      opus: [],
    }));
    const { spawn, calls } = makeSpawn();
    const ctx = makeContext(["开始编排"]);
    await handleTeamCommand(makePi().pi, "", ctx.ctx, spawn);
    const split = calls.find((call) => call.args[0] === "pane" && call.args[1] === "split");
    const run = calls.find((call) => call.args[0] === "pane" && call.args[1] === "run");
    assert.deepEqual(split?.args, ["pane", "split", "--cwd", "/project", "--no-focus"]);
    assert.ok(run);
    assert.equal(run.args[0], "pane");
    assert.equal(run.args[1], "run");
    assert.equal(run.args[2], "w1:p8");
    assert.match(run.args[3], /^HAPI_ORCH_ROLE=worker HAPILON_HOME=\S+ node \S+ --model anthropic\/claude-sonnet$/);
    const started = readTeamState(statePath());
    assert.equal(started.enabled, true);
    assert.deepEqual(started.roles, {
      worker: { paneId: "w1:p8", model: "anthropic/claude-sonnet" },
      reviewer: { paneId: null, model: null },
    });
    assert.match(started.since, /^2026-/);
  });

  it("resolved model 缺失时省略 --model，暂停后开始复用活面板", async () => {
    rmSync(join(home, "model-tiers-resolved.json"), { force: true });
    const first = makeSpawn();
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

  it("清空面板：working 拒绝，idle 使用逐字符 send-keys 并复查", async () => {
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

  it("暂停保留 roles，结束删除状态文件", async () => {
    saveState();
    const ctx = makeContext();
    await handleTeamCommand(makePi().pi, "暂停编排", ctx.ctx, makeSpawn().spawn);
    const paused = readTeamState(statePath());
    assert.equal(paused.enabled, false);
    assert.deepEqual((paused as TeamState).roles, stateFor().roles);
    saveState();
    await handleTeamCommand(makePi().pi, "结束编排", ctx.ctx, makeSpawn().spawn);
    assert.equal(existsSync(statePath()), false);
  });
});

describe("hpl-orchestra system prompt exclusivity", { concurrency: false }, () => {
  it("worker/reviewer/orchestrator 三种场景每次最多注入一个 team section", async () => {
    const handler = promptHandler();
    const context = { sessionManager: manager() };

    process.env.HAPI_ORCH_ROLE = "worker";
    let result = await handler({ systemPromptOptions: promptOptions() }, context);
    assert.ok(result.systemPrompt.includes(WORKER_SECTION));
    assert.equal((result.systemPrompt.match(/<team mode=/g) ?? []).length, 1);

    process.env.HAPI_ORCH_ROLE = "reviewer";
    result = await handler({ systemPromptOptions: promptOptions() }, context);
    assert.ok(result.systemPrompt.includes(REVIEWER_SECTION));
    assert.equal((result.systemPrompt.match(/<team mode=/g) ?? []).length, 1);

    delete process.env.HAPI_ORCH_ROLE;
    saveState();
    result = await handler({ systemPromptOptions: promptOptions() }, context);
    assert.ok(result.systemPrompt.includes("<team mode=\"orchestrator\">"));
    assert.ok(result.systemPrompt.includes("worker w1:p8"));
    assert.equal((result.systemPrompt.match(/<team mode=/g) ?? []).length, 1);
    assert.equal(ORCHESTRATOR_SECTION.includes("<WORKER_PANE>"), true);
  });
});
