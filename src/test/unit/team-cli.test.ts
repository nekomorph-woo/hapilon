import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { DEFAULT_STALE_THRESHOLD_MS } from "../../extensions/hpl-orchestra/agent-state.js";
import {
  TEAM_STATUS_EXIT,
  WAKE_OWNER_EXIT,
  runTeamStatusCommand,
  runWakeOwnerCommand,
} from "../../extensions/hpl-orchestra/team-cli.js";
import {
  resolveSessionStatePath,
  teamTasksPathFor,
  teamsDir,
  writeTeamStateEffect,
  type TeamState,
} from "../../extensions/hpl-orchestra/state.js";
import type { SpawnFn } from "../../extensions/hpl-orchestra/herdr.js";

const ownerPane = "w1:p7";
const workerPane = "w1:p8";
const reviewerPane = "w1:p9";

let home: string;
const originalEnv = {
  home: process.env.HAPILON_HOME,
  pane: process.env.HERDR_PANE_ID,
  role: process.env.HAPI_ORCH_ROLE,
};

before(() => {
  home = mkdtempSync(join(tmpdir(), "hapilon-team-cli-test-"));
  process.env.HAPILON_HOME = home;
  process.env.HERDR_PANE_ID = ownerPane;
  delete process.env.HAPI_ORCH_ROLE;
});

after(() => {
  if (originalEnv.home === undefined) delete process.env.HAPILON_HOME;
  else process.env.HAPILON_HOME = originalEnv.home;
  if (originalEnv.pane === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = originalEnv.pane;
  if (originalEnv.role === undefined) delete process.env.HAPI_ORCH_ROLE;
  else process.env.HAPI_ORCH_ROLE = originalEnv.role;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(teamsDir(), { recursive: true, force: true });
  process.env.HERDR_PANE_ID = ownerPane;
  delete process.env.HAPI_ORCH_ROLE;
});

const stateFor = (): TeamState => ({
  enabled: true,
  since: "2026-09-19T10:00:00.000Z",
  owner: { paneId: ownerPane, nickname: "阿岚" },
  name: "摸鱼突击队",
  roles: [
    { key: "worker", instances: [{ paneId: workerPane, model: null, nickname: "阿澈" }] },
    { key: "reviewer", instances: [{ paneId: reviewerPane, model: null }] },
  ],
});

function saveState(state: TeamState = stateFor()): void {
  assert.equal(Effect.runSync(writeTeamStateEffect(state, resolveSessionStatePath())), true);
}

/** 假 herdr：只回答 pane 探活 / agent 状态 / 屏文本，够 team-status 与 wake-owner 跑完。 */
function makeSpawn(options: {
  alivePanes?: string[];
  agentStatuses?: Record<string, string>;
} = {}): { spawn: SpawnFn; calls: Array<{ args: string[] }> } {
  const calls: Array<{ args: string[] }> = [];
  const alive = new Set(options.alivePanes ?? [ownerPane, workerPane, reviewerPane]);
  const spawn: SpawnFn = (_bin, args) => {
    calls.push({ args });
    if (args[0] === "pane" && args[1] === "get") {
      const id = args[2];
      return alive.has(id)
        ? { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: id, agent: "pi" } } }) }
        : { status: 1, stderr: JSON.stringify({ error: { code: "pane_not_found" } }) };
    }
    if (args[0] === "pane" && args[1] === "read") return { status: 0, stdout: "idle prompt, no dialogs" };
    if (args[0] === "pane" && args[1] === "process-info") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { process_info: { shell_pid: 100, foreground_processes: [{ argv0: "pi", pid: 200 }] } },
        }),
      };
    }
    if (args[0] === "agent" && args[1] === "get") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { agent: { agent_status: options.agentStatuses?.[args[2]] ?? "idle", pane_id: args[2] } },
        }),
      };
    }
    return { status: 0, stdout: JSON.stringify({ result: {} }) };
  };
  return { spawn, calls };
}

function capture(fn: () => number): { code: number; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    return { code: fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** 直写 pi-tasks 形状的任务文件造数（外部追加入口已删，pane 侧写入归 pi-tasks）。 */
function seedTasks(paneId: string, tasks: Array<Record<string, unknown>>): void {
  const path = teamTasksPathFor(paneId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ nextId: tasks.length + 1, tasks }, null, 2)}\n`);
}

describe("hapi team-status", { concurrency: false }, () => {
  it("列出各 pane 的状态、任务摘要与回执有无（只读）", () => {
    saveState();
    const dossier = join(home, "plan-task", "2026-09-19-demo");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(join(dossier, "worker-report.md"), "done\n");
    seedTasks(workerPane, [{
      id: "1",
      subject: "[阿澈] 修 X",
      status: "pending",
      metadata: { pane: workerPane, brief: dossier },
      createdAt: 1000,
      updatedAt: 1000,
    }]);

    const { code, logs } = capture(() => runTeamStatusCommand([], makeSpawn().spawn));
    assert.equal(code, TEAM_STATUS_EXIT.ok);
    const text = logs.join("\n");
    assert.match(text, /团队 摸鱼突击队 — owner w1:p7 阿岚/);
    assert.match(text, /- worker w1:p8 阿澈 · done · report exists \(.*worker-report\.md\)/);
    assert.match(text, /tasks: 1 pending \[#1 \[阿澈\] 修 X\], 0 in_progress, 0 completed/);
    assert.match(text, /- reviewer w1:p9 · idle · report n\/a/);
    assert.match(text, /tasks: 空/);
  });

  it("herdr idle + 只有 pending 任务 → idle，任务摘要照旧显示 pending", () => {
    saveState();
    const dossier = join(home, "plan-task", "2026-09-19-idle");
    mkdirSync(dossier, { recursive: true });
    seedTasks(workerPane, [{
      id: "1",
      subject: "[阿澈] 排队中",
      status: "pending",
      metadata: { brief: dossier },
      createdAt: 1000,
      updatedAt: 1000,
    }]);

    const { code, logs } = capture(() => runTeamStatusCommand([], makeSpawn().spawn));
    assert.equal(code, TEAM_STATUS_EXIT.ok);
    const text = logs.join("\n");
    assert.match(text, /- worker w1:p8 阿澈 · idle · report missing/);
    assert.match(text, /tasks: 1 pending \[#1 \[阿澈\] 排队中\]/);
  });

  it("in_progress 超阈且缺回执 → stale", () => {
    saveState();
    const dossier = join(home, "plan-task", "2026-09-19-stale");
    mkdirSync(dossier, { recursive: true });
    const staleAt = Date.now() - DEFAULT_STALE_THRESHOLD_MS - 60_000;
    seedTasks(workerPane, [{
      id: "1",
      subject: "[阿澈] 卡住了",
      status: "in_progress",
      metadata: { brief: dossier },
      createdAt: staleAt,
      updatedAt: staleAt,
    }]);

    const { logs } = capture(() => runTeamStatusCommand([], makeSpawn().spawn));
    const text = logs.join("\n");
    assert.match(text, /- worker w1:p8 阿澈 · stale · report missing/);
    assert.match(text, /tasks: 0 pending, 1 in_progress/);
  });

  it("herdr working + in_progress 超阈 → working，记账年龄不打断在跑的 pane", () => {
    saveState();
    const dossier = join(home, "plan-task", "2026-09-19-working-long");
    mkdirSync(dossier, { recursive: true });
    const longAgo = Date.now() - DEFAULT_STALE_THRESHOLD_MS * 10;
    seedTasks(workerPane, [{
      id: "1",
      subject: "[阿澈] 长任务",
      status: "in_progress",
      metadata: { brief: dossier },
      createdAt: longAgo,
      updatedAt: longAgo,
    }]);

    const { logs } = capture(() => runTeamStatusCommand([], makeSpawn({
      agentStatuses: { [workerPane]: "working" },
    }).spawn));
    const text = logs.join("\n");
    assert.match(text, /- worker w1:p8 阿澈 · working · report missing/);
    assert.match(text, /tasks: 0 pending, 1 in_progress/);
    assert.doesNotMatch(text, /- worker w1:p8 阿澈 · stale/);
  });

  it("非 owner 面板退出 2", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { code, logs } = capture(() => runTeamStatusCommand([], makeSpawn().spawn));
    assert.equal(code, TEAM_STATUS_EXIT.noTeam);
    assert.match(logs.join("\n"), /不是 Team 主面板/);
  });
});

describe("hapi wake-owner", { concurrency: false }, () => {
  it("带上自己的昵称与 pane id 投给 owner pane", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { spawn, calls } = makeSpawn();
    const { code, logs } = capture(() => runWakeOwnerCommand(["--message", "done: 修好了 -> /tmp/r.md"], spawn));
    assert.equal(code, WAKE_OWNER_EXIT.sent);
    assert.match(logs.join("\n"), /已通知 w1:p7/);
    const text = calls.find((call) => call.args[1] === "run");
    assert.deepEqual(text?.args, ["pane", "run", ownerPane, "[阿澈 w1:p8] done: 修好了 -> /tmp/r.md"]);
    // 回归：两段式 send-text + send-keys 的 enter 会被 bracketed-paste 吞掉，投递必须走 pane run 原子提交
    assert.equal(calls.find((call) => call.args[1] === "send-text" || call.args[1] === "send-keys"), undefined);
  });

  it("没有 HERDR_PANE_ID / 不属于任何团队 → 退出 2", () => {
    saveState();
    delete process.env.HERDR_PANE_ID;
    assert.equal(capture(() => runWakeOwnerCommand([], makeSpawn().spawn)).code, WAKE_OWNER_EXIT.noTeam);
    process.env.HERDR_PANE_ID = "w1:pBogus";
    const { code, errors } = capture(() => runWakeOwnerCommand([], makeSpawn().spawn));
    assert.equal(code, WAKE_OWNER_EXIT.noTeam);
    assert.match(errors.join("\n"), /不属于任何团队/);
    process.env.HERDR_PANE_ID = workerPane;
  });

  it("owner pane 已不可用 → 退出 3", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { spawn } = makeSpawn({ alivePanes: [workerPane] });
    const { code, errors } = capture(() => runWakeOwnerCommand([], spawn));
    assert.equal(code, WAKE_OWNER_EXIT.herdr);
    assert.match(errors.join("\n"), /owner 面板 w1:p7 不可用/);
  });
});
