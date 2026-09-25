/**
 * orchestra 接入：新建 Worker pane 走配额/画像选模，复用与重灌保持已存 concrete model，
 * 选择结果与事实上报落盘。
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { handleTeamCommand, resetProbeCache } from "../../extensions/hpl-orchestra/menu.js";
import hplOrchestra from "../../extensions/hpl-orchestra/index.js";
import {
  discardPendingThinkingSwitch,
  recordModelSwitch,
  recordOwnCompletedTasks,
  recordThinkingSwitch,
  writeBackPaneModel,
} from "../../extensions/hpl-orchestra/adaptive-facts.js";
import {
  findRoleEntry,
  readTeamState,
  resolveSessionStatePath,
  teamTasksPathFor,
  writeTeamStateEffect,
  type TeamState,
} from "../../extensions/hpl-orchestra/state.js";
import type { SpawnFn } from "../../extensions/hpl-orchestra/herdr.js";
import { appendAdaptiveEvent, readAdaptiveEvents } from "../../extensions/hpl-model-tiers/adaptive-events.js";
import { writeQuotaSnapshot } from "../../extensions/hpl-quota-usage/cache.js";

const originalEnv = {
  home: process.env.HAPILON_HOME,
  cache: process.env["HAPILON_QUOTA_CACHE"],
  herdr: process.env.HERDR_ENV,
  pane: process.env.HERDR_PANE_ID,
  role: process.env.HAPI_ORCH_ROLE,
  cliPath: process.env.HAPILON_CLI_PATH,
};

let home: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), "hapilon-orchestra-adaptive-"));
  process.env.HAPILON_HOME = home;
  process.env["HAPILON_QUOTA_CACHE"] = join(home, "quota-cache.json");
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p7";
  process.env.HAPILON_CLI_PATH = "/fake/dist/cli.js";
  delete process.env.HAPI_ORCH_ROLE;
});

after(() => {
  for (const [key, value] of Object.entries({
    HAPILON_HOME: originalEnv.home,
    HAPILON_QUOTA_CACHE: originalEnv.cache,
    HERDR_ENV: originalEnv.herdr,
    HERDR_PANE_ID: originalEnv.pane,
    HAPI_ORCH_ROLE: originalEnv.role,
    HAPILON_CLI_PATH: originalEnv.cliPath,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(resolveSessionStatePath(), { force: true });
  rmSync(join(home, "tier-adaptive"), { recursive: true, force: true });
  // agent/settings.json 里的持久开关也是被测状态，逐例清干净免得淌到下一个用例
  rmSync(join(home, "agent"), { recursive: true, force: true });
  rmSync(process.env["HAPILON_QUOTA_CACHE"]!, { force: true });
  rmSync(join(home, "model-tiers-resolved.json"), { force: true });
  delete process.env.HAPI_ORCH_ROLE;
  resetProbeCache();
  discardPendingThinkingSwitch();
});

/** 三个 sonnet 候选：配置顺序 zai > deepseek > openai-codex */
function writeResolvedTiers(): void {
  writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
    opus: [{ provider: "anthropic", id: "claude-opus" }],
    sonnet: [
      { provider: "zai", id: "glm-5.3", thinking: "high", group: 0 },
      { provider: "deepseek", id: "deepseek-flash", group: 1 },
      { provider: "openai-codex", id: "gpt-5", group: 2 },
    ],
    haiku: [],
  }), "utf8");
}

const stateFor = (roles: TeamState["roles"]): TeamState => ({
  enabled: true,
  since: "2026-09-22T10:00:00.000Z",
  owner: { paneId: "w1:p7" },
  roles,
});

function saveState(state: TeamState): void {
  Effect.runSync(writeTeamStateEffect(state, resolveSessionStatePath()));
}

function makeContext() {
  const notices: Array<{ message: string; type?: string }> = [];
  const ctx = {
    cwd: "/project",
    sessionManager: { getSessionFile: () => "/sessions/owner.jsonl" },
    model: { provider: "anthropic", id: "claude-opus" },
    ui: {
      select: async () => undefined,
      notify: (message: string, type?: string) => notices.push({ message, type }),
      setStatus: () => {},
      confirm: async () => true,
    },
  };
  return { ctx: ctx as never, notices };
}

function makePi() {
  const commands = new Map<string, { handler: Function }>();
  const events = new Map<string, Function>();
  const pi = {
    registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
    on: (event: string, handler: Function) => events.set(event, handler),
    registerFlag: () => {},
    getFlag: () => undefined,
  } as never;
  return { pi, commands, events };
}

/** mock herdr：pane get/layout/split/run/rename/close + agent get（字段名与真实响应一致）。 */
function makeSpawn(options: { paneId?: string; corpsePanes?: string[] } = {}) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const paneId = options.paneId ?? "w1:p8";
  const corpse = new Set(options.corpsePanes ?? []);
  const spawn: SpawnFn = (bin, args) => {
    calls.push({ bin, args });
    if (args[0] === "pane" && args[1] === "get") {
      const id = args[2];
      const base = corpse.has(id) ? { pane_id: id } : { pane_id: id, agent: "pi" };
      return { status: 0, stdout: JSON.stringify({ result: { pane: base } }) };
    }
    if (args[0] === "pane" && args[1] === "layout") {
      return { status: 0, stdout: JSON.stringify({ result: { layout: { panes: [{ pane_id: paneId, rect: { width: 100 } }] } } }) };
    }
    if (args[0] === "pane" && args[1] === "split") {
      return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }) };
    }
    if (args[0] === "agent" && args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({ result: { agent: { agent_status: "idle", pane_id: paneId } } }) };
    }
    return { status: 0, stdout: "{}" };
  };
  return { spawn, calls };
}

/** 只统计 pane run 的启动命令 */
function paneRunCommands(calls: Array<{ args: string[] }>): string[] {
  return calls.filter((call) => call.args[0] === "pane" && call.args[1] === "run").map((call) => call.args[3]!);
}

describe("orchestra 新建 Worker 选模", () => {
  it("配额 hot 的 provider 被顺延，选择写入 instance.model 并记事实", async () => {
    writeResolvedTiers();
    const now = Date.now();
    writeQuotaSnapshot({ provider: "glm", windows: [{ window: "5h", percent: 95, resetAt: now + 3_600_000 }], timestamp: now });
    const { spawn, calls } = makeSpawn();
    const { ctx } = makeContext();

    await handleTeamCommand(makePi().pi, "开始编排", ctx, spawn);

    assert.equal(paneRunCommands(calls).length, 1);
    assert.ok(paneRunCommands(calls)[0]!.includes("--model deepseek/deepseek-flash"));
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "worker")!.instances[0]!.model, "deepseek/deepseek-flash");

    const events = readAdaptiveEvents();
    const assignment = events.find((event) => event.kind === "pane_assignment");
    assert.ok(assignment && assignment.kind === "pane_assignment");
    assert.equal(assignment.source, "auto");
    assert.match(assignment.reason, /配额/);
    // 自动分配不得被记成用户点名（自我强化隔离的第一道闸）
    assert.equal(events.some((event) => event.kind === "explicit_selection"), false);
  });

  it("adaptive 开启时用学习到的 thinking 补齐选定模型（无后缀条目）", async () => {
    writeResolvedTiers();
    const ts = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      appendAdaptiveEvent({
        kind: "thinking_switch", v: 1, ts, paneId: `w1:p${i}`, role: "worker",
        model: "deepseek/deepseek-flash", previousLevel: "low", level: "high",
      });
    }
    const now = Date.now();
    writeQuotaSnapshot({ provider: "glm", windows: [{ window: "5h", percent: 95, resetAt: now + 3_600_000 }], timestamp: now });
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({ tierAdaptive: { enabled: true } }));
    const { spawn, calls } = makeSpawn();

    await handleTeamCommand(makePi().pi, "开始编排", makeContext().ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model deepseek/deepseek-flash:high"));
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "worker")!.instances[0]!.model, "deepseek/deepseek-flash:high");
  });

  it("选模读的是持久开关：settings 开启后画像生效，默认关闭时按配置顺序", async () => {
    writeResolvedTiers();
    const ts = new Date().toISOString();
    for (let i = 0; i < 6; i++) {
      appendAdaptiveEvent({ kind: "explicit_selection", ts, role: "worker", model: "openai-codex/gpt-5", source: "arg" });
    }

    // 默认关闭：证据只展示，仍按配置顺序取首个候选
    const offRun = makeSpawn();
    await handleTeamCommand(makePi().pi, "开始编排", makeContext().ctx, offRun.spawn);
    assert.ok(paneRunCommands(offRun.calls)[0]!.includes("--model zai/glm-5.3:high"));
    rmSync(resolveSessionStatePath(), { force: true });
    resetProbeCache();

    // /tier-adaptive-mode on 写入的持久状态（settings.json）
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({ tierAdaptive: { enabled: true } }));
    const onRun = makeSpawn();
    await handleTeamCommand(makePi().pi, "开始编排", makeContext().ctx, onRun.spawn);
    assert.ok(paneRunCommands(onRun.calls)[0]!.includes("--model openai-codex/gpt-5"));
    const assignment = readAdaptiveEvents().filter((event) => event.kind === "pane_assignment").at(-1);
    assert.match(assignment!.reason, /画像/);
  });

  it("显式点名作为最高优先覆盖，并记点名事实", async () => {
    writeResolvedTiers();
    const { spawn, calls } = makeSpawn();
    const { ctx } = makeContext();

    await handleTeamCommand(makePi().pi, "打开角色 worker anthropic/claude-opus-5:high", ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model anthropic/claude-opus-5:high"));
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "worker")!.instances[0]!.model, "anthropic/claude-opus-5:high");
    const kinds = readAdaptiveEvents().map((event) => event.kind);
    assert.deepEqual(kinds, ["pane_assignment", "explicit_selection"]);
  });

  it("点名带 thinking 的档位指代按档位表解析（thinking 后缀保留）", async () => {
    writeResolvedTiers();
    const { spawn, calls } = makeSpawn();
    await handleTeamCommand(makePi().pi, "打开角色 worker tier:sonnet[0]", makeContext().ctx, spawn);
    assert.ok(paneRunCommands(calls)[0]!.includes("--model zai/glm-5.3:high"));
  });

  it("已有 Worker pane：开始编排复用，不重选也不新开面板", async () => {
    writeResolvedTiers();
    const now = Date.now();
    writeQuotaSnapshot({ provider: "glm", windows: [{ window: "5h", percent: 99, resetAt: now + 3_600_000 }], timestamp: now });
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p8", model: "zai/glm-5.3:high" }] }]));
    const { spawn, calls } = makeSpawn();
    const { ctx, notices } = makeContext();

    await handleTeamCommand(makePi().pi, "开始编排", ctx, spawn);

    assert.equal(paneRunCommands(calls).length, 0, "复用路径不应重灌/重选");
    assert.equal(calls.some((call) => call.args[1] === "split"), false, "不应新建面板");
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "worker")!.instances[0]!.model, "zai/glm-5.3:high");
    assert.ok(notices.some(({ message }) => message.includes("编排已开始，Worker 面板：w1:p8")));
    assert.deepEqual(readAdaptiveEvents(), []);
  });

  it("崩溃重灌沿用已存 model，不经过选择器", async () => {
    writeResolvedTiers();
    const now = Date.now();
    writeQuotaSnapshot({ provider: "glm", windows: [{ window: "5h", percent: 99, resetAt: now + 3_600_000 }], timestamp: now });
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p8", model: "zai/glm-5.3:high" }] }]));
    const { spawn, calls } = makeSpawn({ corpsePanes: ["w1:p8"] });
    const { ctx } = makeContext();

    await handleTeamCommand(makePi().pi, "开始编排", ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model zai/glm-5.3:high"));
    assert.equal(calls.some((call) => call.args[1] === "split"), false);
    assert.deepEqual(readAdaptiveEvents(), [], "重灌不是新分配，不记事实");
  });

  it("崩溃重灌保留已存后缀：与档位条目 thinking 不同也不被重解析覆盖", async () => {
    writeResolvedTiers();
    // 档位条目是 zai/glm-5.3:high，面板当时跑的是 :low（学习/显式结果先于条目配置变更）
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p8", model: "zai/glm-5.3:low" }] }]));
    const { spawn, calls } = makeSpawn({ corpsePanes: ["w1:p8"] });

    await handleTeamCommand(makePi().pi, "开始编排", makeContext().ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model zai/glm-5.3:low"));
    assert.equal(paneRunCommands(calls)[0]!.includes(":high"), false);
  });

  it("崩溃重灌保留 learned 后缀：档位条目无后缀也不丢", async () => {
    writeResolvedTiers();
    // deepseek/deepseek-flash 条目没有 thinking，后缀来自 adaptive 补齐
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p8", model: "deepseek/deepseek-flash:high" }] }]));
    const { spawn, calls } = makeSpawn({ corpsePanes: ["w1:p8"] });

    await handleTeamCommand(makePi().pi, "开始编排", makeContext().ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model deepseek/deepseek-flash:high"));
  });

  it("复用中的单例角色：点名被忽略并明确提示", async () => {
    writeResolvedTiers();
    saveState(stateFor([{ key: "reviewer", instances: [{ paneId: "w1:p8", model: "anthropic/claude-opus" }] }]));
    const { spawn, calls } = makeSpawn();
    const { ctx, notices } = makeContext();

    await handleTeamCommand(makePi().pi, "打开角色 reviewer anthropic/claude-opus-5", ctx, spawn);

    assert.equal(paneRunCommands(calls).length, 0);
    assert.ok(notices.some(({ message }) => message.includes("点名的 anthropic/claude-opus-5 未应用")));
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "reviewer")!.instances[0]!.model, "anthropic/claude-opus");
  });

  it("reviewer 仍走原档位解析，不受 Worker 选模影响", async () => {
    writeResolvedTiers();
    const now = Date.now();
    writeQuotaSnapshot({ provider: "anthropic", windows: [{ window: "5h", percent: 99, resetAt: now + 3_600_000 }], timestamp: now });
    const { spawn, calls } = makeSpawn();
    await handleTeamCommand(makePi().pi, "打开角色 reviewer", makeContext().ctx, spawn);
    assert.ok(paneRunCommands(calls)[0]!.includes("--model anthropic/claude-opus"));
  });
});

describe("orchestra 任务完成事实上报", () => {
  it("角色 pane 自查已完成任务写事实，同一 (pane, task) 只记一次", () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    const previousPane = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "w1:p8";
    try {
      const tasksPath = teamTasksPathFor("w1:p8");
      mkdirSync(join(home, "teams"), { recursive: true });
      writeFileSync(tasksPath, JSON.stringify({
        nextId: 3,
        tasks: [
          { id: "1", subject: "done one", status: "completed" },
          { id: "2", subject: "still pending", status: "pending" },
        ],
      }), "utf8");

      recordOwnCompletedTasks({ model: { provider: "zai", id: "glm-5.3" } });
      recordOwnCompletedTasks({ model: { provider: "zai", id: "glm-5.3" } });

      const completed = readAdaptiveEvents().filter((event) => event.kind === "task_completed");
      assert.equal(completed.length, 1);
      assert.deepEqual(completed[0], {
        kind: "task_completed",
        ts: completed[0]!.ts,
        key: "task:w1:p8:1",
        role: "worker",
        paneId: "w1:p8",
        taskId: "1",
        model: "zai/glm-5.3",
      });
    } finally {
      process.env.HERDR_PANE_ID = previousPane;
    }
  });

  it("无角色身份的 pane 不上报（owner 不代角色记账）", () => {
    recordOwnCompletedTasks({ model: { provider: "zai", id: "glm-5.3" } });
    assert.deepEqual(readAdaptiveEvents(), []);
  });
});

describe("orchestra 非 Worker 角色显式点名", () => {
  function enableAdaptive(): void {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({ tierAdaptive: { enabled: true } }));
  }

  function addThinkingSamples(role: string, model: string, level: string): void {
    const ts = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      appendAdaptiveEvent({
        kind: "thinking_switch", v: 1, ts, paneId: `w1:p${i}`, role,
        model, previousLevel: "low", level,
      });
    }
  }

  it("点名无 thinking 后缀时，adaptive 开启用该角色画像补齐", async () => {
    writeResolvedTiers();
    addThinkingSamples("reviewer", "anthropic/claude-opus-5", "xhigh");
    enableAdaptive();
    const { spawn, calls } = makeSpawn();
    await handleTeamCommand(makePi().pi, "打开角色 reviewer anthropic/claude-opus-5", makeContext().ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model anthropic/claude-opus-5:xhigh"));
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "reviewer")!.instances[0]!.model, "anthropic/claude-opus-5:xhigh");
  });

  it("点名自带 thinking 后缀时永不被学习值覆盖", async () => {
    writeResolvedTiers();
    addThinkingSamples("reviewer", "anthropic/claude-opus-5", "xhigh");
    enableAdaptive();
    const { spawn, calls } = makeSpawn();
    await handleTeamCommand(makePi().pi, "打开角色 reviewer anthropic/claude-opus-5:low", makeContext().ctx, spawn);
    assert.ok(paneRunCommands(calls)[0]!.includes("--model anthropic/claude-opus-5:low"));
  });

  it("adaptive 关闭时学习值只展示，不进入启动命令", async () => {
    writeResolvedTiers();
    addThinkingSamples("reviewer", "anthropic/claude-opus-5", "xhigh");
    const { spawn, calls } = makeSpawn();
    await handleTeamCommand(makePi().pi, "打开角色 reviewer anthropic/claude-opus-5", makeContext().ctx, spawn);
    assert.ok(paneRunCommands(calls)[0]!.includes("--model anthropic/claude-opus-5"));
    assert.equal(paneRunCommands(calls)[0]!.includes(":xhigh"), false);
  });

  it("具体 id 原样采信，写 instance.model 并记该角色的显式选择事实", async () => {
    writeResolvedTiers();
    const { spawn, calls } = makeSpawn();
    await handleTeamCommand(makePi().pi, "打开角色 reviewer anthropic/claude-opus-5:high", makeContext().ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model anthropic/claude-opus-5:high"));
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "reviewer")!.instances[0]!.model, "anthropic/claude-opus-5:high");
    const events = readAdaptiveEvents();
    // 非 Worker 不走选择器：没有 pane_assignment，只有点名这一条可信事实
    assert.deepEqual(events.map((event) => event.kind), ["explicit_selection"]);
    const named = events[0]!;
    assert.equal(named.kind === "explicit_selection" && named.role, "reviewer");
  });

  it("tier 指代按当前 resolved 档位解析，thinking 用条目配置", async () => {
    writeResolvedTiers();
    const { spawn, calls } = makeSpawn();
    await handleTeamCommand(makePi().pi, "打开角色 ux-tester tier:sonnet[2]", makeContext().ctx, spawn);
    assert.ok(paneRunCommands(calls)[0]!.includes("--model openai-codex/gpt-5"));
  });

  it("越界指代明确告警并回落该角色默认档位，不记点名事实", async () => {
    writeResolvedTiers();
    const { spawn, calls } = makeSpawn();
    const { ctx, notices } = makeContext();
    await handleTeamCommand(makePi().pi, "打开角色 reviewer tier:opus[9]", ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model anthropic/claude-opus"));
    assert.ok(notices.some(({ message }) => message.includes("点名 tier:opus[9]") && message.includes("回退自动选择")));
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "reviewer")!.instances[0]!.model, "anthropic/claude-opus");
    assert.deepEqual(readAdaptiveEvents(), []);
  });

  it("非法格式同样告警并回落默认档位", async () => {
    writeResolvedTiers();
    const { spawn, calls } = makeSpawn();
    const { ctx, notices } = makeContext();
    await handleTeamCommand(makePi().pi, "打开角色 reviewer nonsense", ctx, spawn);
    assert.ok(paneRunCommands(calls)[0]!.includes("--model anthropic/claude-opus"));
    assert.ok(notices.some(({ message }) => message.includes("不是合法模型")));
  });

  it("崩溃重灌沿用已存 concrete model，不重选", async () => {
    writeResolvedTiers();
    saveState(stateFor([{ key: "reviewer", instances: [{ paneId: "w1:p8", model: "openai-codex/gpt-5" }] }]));
    const { spawn, calls } = makeSpawn({ corpsePanes: ["w1:p8"] });
    await handleTeamCommand(makePi().pi, "打开角色 reviewer", makeContext().ctx, spawn);

    assert.ok(paneRunCommands(calls)[0]!.includes("--model openai-codex/gpt-5"));
    assert.equal(calls.some((call) => call.args[1] === "split"), false);
    assert.deepEqual(readAdaptiveEvents(), []);
  });
});

describe("角色 pane 主动切模事实上报", () => {
  const switchEvent = (overrides: Partial<Parameters<typeof recordModelSwitch>[0]> = {}) => ({
    source: "set",
    model: { provider: "zai", id: "glm-5.3" },
    previousModel: { provider: "anthropic", id: "claude-opus" },
    ...overrides,
  });

  it("set/cycle 记录目标模型与 thinking；restore、同模型、owner 一律忽略", () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    const previousPane = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "w1:p8";
    try {
      assert.equal(recordModelSwitch(switchEvent({ source: "set" }), { thinking: "high" }), true);
      assert.equal(recordModelSwitch(switchEvent({ source: "cycle" }), {}), true);
      assert.equal(recordModelSwitch(switchEvent({ source: "restore" }), {}), false);
      assert.equal(recordModelSwitch(switchEvent({
        model: { provider: "anthropic", id: "claude-opus" },
        previousModel: { provider: "anthropic", id: "claude-opus" },
      }), {}), false);
      delete process.env.HAPI_ORCH_ROLE;
      assert.equal(recordModelSwitch(switchEvent({}), {}), false);

      const events = readAdaptiveEvents();
      assert.equal(events.length, 2);
      assert.deepEqual(events[0], {
        kind: "model_switch",
        v: 1,
        ts: events[0]!.ts,
        paneId: "w1:p8",
        role: "worker",
        previousModel: "anthropic/claude-opus",
        model: "zai/glm-5.3",
        source: "set",
        thinking: "high",
      });
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
      process.env.HERDR_PANE_ID = previousPane;
    }
  });

  it("无前值时 previousModel 记空串，字段仍在", () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    try {
      recordModelSwitch(switchEvent({ previousModel: undefined }), {});
      const [recorded] = readAdaptiveEvents();
      assert.equal(recorded!.kind === "model_switch" && recorded!.previousModel, "");
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
    }
  });

  it("扩展注册 model_select 监听并走同一条上报路径", () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    try {
      const { pi, events } = makePi();
      hplOrchestra(pi);
      const handler = events.get("model_select");
      assert.ok(handler, "hpl-orchestra 必须监听 model_select");
      handler!(
        { type: "model_select", source: "set", model: { provider: "zai", id: "glm-5.3" }, previousModel: { provider: "anthropic", id: "claude-opus" } },
        { thinkingLevel: "high" },
      );
      const [recorded] = readAdaptiveEvents();
      assert.equal(recorded!.kind, "model_switch");
      assert.equal(recorded!.kind === "model_switch" && recorded!.thinking, "high");
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
    }
  });
});

describe("角色 pane 主动切 thinking level 上报", () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

  it("直接切 thinking：缓冲一拍后落盘到当前模型", async () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    try {
      assert.equal(
        recordThinkingSwitch({ level: "high", previousLevel: "medium" }, { model: { provider: "zai", id: "glm-5.3" } }),
        true,
      );
      assert.deepEqual(readAdaptiveEvents(), [], "缓冲期间不落盘（等 model_select 同轮关联）");
      await flush();
      const [recorded] = readAdaptiveEvents();
      assert.equal(recorded!.kind, "thinking_switch");
      assert.deepEqual(recorded, {
        kind: "thinking_switch",
        v: 1,
        ts: recorded!.ts,
        paneId: "w1:p7",
        role: "worker",
        model: "zai/glm-5.3",
        previousLevel: "medium",
        level: "high",
      });
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
    }
  });

  it("模型切换同轮：缓冲的 thinking 事件被丢弃", async () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    try {
      recordThinkingSwitch({ level: "low", previousLevel: "high" }, { model: { provider: "zai", id: "glm-5.3" } });
      discardPendingThinkingSwitch();
      await flush();
      assert.deepEqual(readAdaptiveEvents(), [], "模型切换引起的 thinking 变化不是用户偏好");
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
    }
  });

  it("同一拍内两条切换都保留，模型切换只丢末位", async () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    try {
      const ctx = { model: { provider: "zai", id: "glm-5.3" } };
      recordThinkingSwitch({ level: "high", previousLevel: "medium" }, ctx);
      recordThinkingSwitch({ level: "low", previousLevel: "high" }, ctx);
      // 模拟同拍紧随的模型切换：只丢掉末位（切换附带的那条）
      discardPendingThinkingSwitch();
      await flush();
      const levels = readAdaptiveEvents().map((recorded) => recorded.kind === "thinking_switch" ? recorded.level : recorded.kind);
      assert.deepEqual(levels, ["high"]);
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
    }
  });

  it("owner/缺当前模型/同 level 一律不记", () => {
    const ctx = { model: { provider: "zai", id: "glm-5.3" } };
    assert.equal(recordThinkingSwitch({ level: "high", previousLevel: "medium" }, ctx), false, "无角色身份（owner）");
    process.env.HAPI_ORCH_ROLE = "worker";
    try {
      assert.equal(recordThinkingSwitch({ level: "high", previousLevel: "medium" }, {}), false, "缺当前模型");
      assert.equal(
        recordThinkingSwitch({ level: "high", previousLevel: "high" }, ctx),
        false,
        "同 level pi 本就不发事件，写侧兼底",
      );
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
    }
  });

  it("扩展接线：thinking_level_select 经缓冲落盘，同轮 model_select 丢弃附带变化", async () => {
    process.env.HAPI_ORCH_ROLE = "worker";
    try {
      const { pi, events } = makePi();
      hplOrchestra(pi);
      const thinking = events.get("thinking_level_select");
      const model = events.get("model_select");
      assert.ok(thinking, "hpl-orchestra 必须监听 thinking_level_select");
      assert.ok(model);

      thinking!(
        { type: "thinking_level_select", level: "high", previousLevel: "medium" },
        { model: { provider: "zai", id: "glm-5.3" } },
      );
      await flush();
      assert.deepEqual(readAdaptiveEvents().map((event) => event.kind), ["thinking_switch"]);

      // 模型切换先 setThinkingLevel 再发 model_select：同一轮里附带变化应被丢弃
      thinking!(
        { type: "thinking_level_select", level: "low", previousLevel: "high" },
        { model: { provider: "zai", id: "glm-5.3" } },
      );
      model!(
        { type: "model_select", source: "cycle", model: { provider: "deepseek", id: "deepseek-flash" }, previousModel: { provider: "zai", id: "glm-5.3" } },
        { thinkingLevel: "low" },
      );
      await flush();
      assert.deepEqual(
        readAdaptiveEvents().map((event) => event.kind),
        ["thinking_switch", "model_switch"],
        "只有用户切的 thinking 与本轮切模落盘",
      );
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
    }
  });
});

describe("角色 pane 切模写回 instance.model（/new 不刷掉用户选择）", () => {
  const setEvent = (provider: string, id: string, previousProvider = "anthropic", previousId = "claude-opus") => ({
    source: "set",
    model: { provider, id },
    previousModel: { provider: previousProvider, id: previousId },
  });

  it("状态文件存在 → 写回完整 spec（reasoning 带档位后缀）", () => {
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p7", model: "anthropic/claude-opus" }] }]));
    assert.equal(
      writeBackPaneModel(setEvent("deepseek", "deepseek-flash"), { paneId: "w1:p7", thinking: "high", reasoning: true }),
      true,
    );
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "worker")!.instances[0]!.model, "deepseek/deepseek-flash:high");
  });

  it("非 reasoning 模型 → 裸 provider/id（不带 :level）", () => {
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p7", model: "anthropic/claude-opus" }] }]));
    writeBackPaneModel(setEvent("deepseek", "deepseek-flash"), { paneId: "w1:p7", thinking: "high", reasoning: false });
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "worker")!.instances[0]!.model, "deepseek/deepseek-flash");
  });

  it("pane 不在任何团队 → 不炸、不落盘（只记事件由 recordModelSwitch 负责）", () => {
    assert.equal(
      writeBackPaneModel(setEvent("deepseek", "deepseek-flash"), { paneId: "nobody:p1", reasoning: true, thinking: "high" }),
      true,
    );
    assert.equal(existsSync(resolveSessionStatePath()), false);
  });

  it("restore 源不写回（恢复不是用户选择）", () => {
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p7", model: "anthropic/claude-opus" }] }]));
    assert.equal(writeBackPaneModel({ ...setEvent("deepseek", "deepseek-flash"), source: "restore" }, { paneId: "w1:p7" }), false);
    const state = readTeamState(resolveSessionStatePath()) as TeamState;
    assert.equal(findRoleEntry(state, "worker")!.instances[0]!.model, "anthropic/claude-opus");
  });

  it("写回裸 provider/id → revive 按档位解析（不带 :level；带后缀格式由写回用例与 tier-model 用例覆盖）", async () => {
    writeResolvedTiers();
    // 裸 provider/id：无 thinking 覆盖，按档位条目解析
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p8", model: "deepseek/deepseek-flash" }] }]));
    const bare = makeSpawn({ corpsePanes: ["w1:p8"] });
    await handleTeamCommand(makePi().pi, "开始编排", makeContext().ctx, bare.spawn);
    assert.ok(paneRunCommands(bare.calls)[0]!.includes("--model deepseek/deepseek-flash"));
    assert.equal(paneRunCommands(bare.calls)[0]!.includes(":high"), false);
  });

  it("/new：before_switch 保存 → session_start 恢复模型与 thinking；程序化恢复不入偏好事件", async () => {
    writeResolvedTiers();
    saveState(stateFor([{ key: "worker", instances: [{ paneId: "w1:p7", model: "anthropic/claude-opus" }] }]));
    process.env.HAPI_ORCH_ROLE = "worker";
    try {
      const calls: string[] = [];
      const events = new Map<string, Function>();
      const pi = {
        registerCommand: () => {},
        on: (event: string, handler: Function) => events.set(event, handler),
        registerFlag: () => {},
        getFlag: () => undefined,
        getThinkingLevel: () => "medium",
        setModel: async (model: { provider: string; id: string }) => {
          calls.push(`setModel:${model.provider}/${model.id}`);
          // 真实 pi 行为：setModel 无论 persist 都会发 model_select（agent-session.js）
          events.get("model_select")!(
            { type: "model_select", source: "set", model, previousModel: { provider: "anthropic", id: "claude-opus" } },
            { thinkingLevel: "medium", model: { ...model, reasoning: true } },
          );
          return true;
        },
        setThinkingLevel: (level: string) => {
          calls.push(`setThinking:${level}`);
          events.get("thinking_level_select")!(
            { type: "thinking_level_select", level, previousLevel: "medium" },
            { model: { provider: "deepseek", id: "deepseek-flash" } },
          );
        },
      } as never;
      hplOrchestra(pi);

      // 用户切模：写回 owner 状态
      events.get("model_select")!(
        { type: "model_select", source: "set", model: { provider: "deepseek", id: "deepseek-flash" }, previousModel: { provider: "anthropic", id: "claude-opus" } },
        { thinkingLevel: "high", model: { provider: "deepseek", id: "deepseek-flash", reasoning: true } },
      );
      const state = readTeamState(resolveSessionStatePath()) as TeamState;
      assert.equal(findRoleEntry(state, "worker")!.instances[0]!.model, "deepseek/deepseek-flash:high");

      // owner /team:clear → 角色 pane 收到 /new
      events.get("session_before_switch")!(
        { type: "session_before_switch", reason: "new" },
        { model: { provider: "deepseek", id: "deepseek-flash" }, thinkingLevel: "high" },
      );
      await events.get("session_start")!(
        { type: "session_start", reason: "new" },
        {
          modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
          model: { provider: "anthropic", id: "claude-opus" },
        },
      );

      assert.deepEqual(calls, ["setModel:deepseek/deepseek-flash", "setThinking:high"]);
      assert.deepEqual(
        readAdaptiveEvents().map((event) => event.kind),
        ["model_switch"],
        "程序化恢复发的事件不得进 tier-adaptive 事实日志",
      );
    } finally {
      delete process.env.HAPI_ORCH_ROLE;
    }
  });
});
