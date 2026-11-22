import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { DEFAULT_STALE_THRESHOLD_MS } from "../../extensions/hpl-orchestra/agent-state.js";
import {
  SEND_MAIL_EXIT,
  TEAM_STATUS_EXIT,
  WAKE_OWNER_EXIT,
  resolveMailboxKey,
  runSendMailCommand,
  runTeamStatusCommand,
  runWakeOwnerCommand,
} from "../../extensions/hpl-orchestra/team-cli.js";
import { WAIT_EXIT, type WaitDeps } from "../../extensions/hpl-orchestra/wait-pane.js";
import {
  resolveSessionStatePath,
  teamTasksPathFor,
  teamsDir,
  writeTeamStateEffect,
  type TeamState,
} from "../../extensions/hpl-orchestra/state.js";
import type { SpawnFn } from "../../extensions/hpl-orchestra/herdr.js";
import { mailPath, type MailMessage } from "../../extensions/hpl-orchestra/mail.js";

const ownerPane = "w1:p7";
const workerPane = "w1:p8";
const reviewerPane = "w1:p9";

let home: string;
const originalEnv = {
  home: process.env.HAPILON_HOME,
  pane: process.env.HERDR_PANE_ID,
  role: process.env.HAPI_ORCH_ROLE,
  herdr: process.env.HERDR_ENV,
};

before(() => {
  for (const k of ["HC_TERMINAL_ID","HC_TERMINAL_SOCKET"] as const) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "hapilon-team-cli-test-"));
  process.env.HAPILON_HOME = home;
  process.env.HERDR_PANE_ID = ownerPane;
  process.env.HERDR_ENV = "1";  // team 传输按宿主分流：本文件模拟 herdr 面板宿主
  delete process.env.HAPI_ORCH_ROLE;
});

after(() => {
  if (originalEnv.home === undefined) delete process.env.HAPILON_HOME;
  else process.env.HAPILON_HOME = originalEnv.home;
  if (originalEnv.pane === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = originalEnv.pane;
  if (originalEnv.role === undefined) delete process.env.HAPI_ORCH_ROLE;
  else process.env.HAPI_ORCH_ROLE = originalEnv.role;
  if (originalEnv.herdr === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalEnv.herdr;
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

describe("hapi send-mail", { concurrency: false }, () => {
  it("投递进目标 role 的信箱即返回，信为 dispatch kind", () => {
    saveState();
    process.env.HERDR_PANE_ID = ownerPane;
    const { code, logs } = capture(() => runSendMailCommand([workerPane, "--text", "修 /tmp/a.ts 的超时，报告写 /tmp/r.md"]));
    assert.equal(code, SEND_MAIL_EXIT.sent);
    assert.match(logs.join("\n"), /已入队/);
    const storeKey = resolveMailboxKey(workerPane)!;
    const lines = readFileSync(mailPath(storeKey, workerPane), "utf8").trim().split("\n");
    const mail = JSON.parse(lines[lines.length - 1]!) as MailMessage;
    assert.equal(mail.kind, "dispatch");
    assert.equal(mail.from, ownerPane);
    assert.equal(mail.to, workerPane);
    assert.equal(mail.text, "修 /tmp/a.ts 的超时，报告写 /tmp/r.md");
  });

  it("目标不属于任何团队 → exit 2", () => {
    saveState();
    process.env.HERDR_PANE_ID = ownerPane;
    const { code, errors } = capture(() => runSendMailCommand(["x:nope", "--text", "hi"]));
    assert.equal(code, SEND_MAIL_EXIT.noTeam);
    assert.match(errors.join("\n"), /不属于任何团队/);
  });

  it("缺 --text → exit 4", () => {
    const { code } = capture(() => runSendMailCommand([workerPane]));
    assert.equal(code, SEND_MAIL_EXIT.usage);
  });

  it("--wait 等状态变过且落到 idle 才返回", () => {
    saveState();
    process.env.HERDR_PANE_ID = ownerPane;
    let polls = 0;
    let clock = 0;
    const deps: WaitDeps = {
      snapshot: () => (polls++ === 0 ? { status: "working", seq: 1 } : { status: "idle", seq: 2 }),
      sleepMs: () => {},
      now: () => (clock += 1000),
    };
    const { code } = capture(() => runSendMailCommand([workerPane, "--text", "hi", "--wait"], deps));
    assert.equal(code, WAIT_EXIT.settled);
  });

  it("core 宿主 --wait 走 hc wait：ended:true 且非 working → settled", () => {
    saveState();
    delete process.env.HERDR_ENV;
    process.env.HC_TERMINAL_ID = ownerPane;
    try {
      const coreSpawn: SpawnFn = () => ({
        status: 0,
        stdout: JSON.stringify({ ended: true, reason: "status", status: "idle", terminal: workerPane, turn: 1 }),
        stderr: "",
      });
      const deps: WaitDeps = {
        snapshot: () => {
          throw new Error("core 分支不该轮询 herdr 状态");
        },
        sleepMs: () => {},
        now: () => 0,
        coreSpawn,
      };
      const { code, logs } = capture(() => runSendMailCommand([workerPane, "--text", "hi", "--wait"], deps));
      assert.equal(code, WAIT_EXIT.settled);
      assert.match(logs.join("\n"), /settled/);
    } finally {
      process.env.HERDR_ENV = "1";
      delete process.env.HC_TERMINAL_ID;
    }
  });

  it("core 宿主 --wait 未收敛 → timeout 退出 3", () => {
    saveState();
    delete process.env.HERDR_ENV;
    process.env.HC_TERMINAL_ID = ownerPane;
    try {
      const coreSpawn: SpawnFn = () => ({
        status: 1,
        stdout: JSON.stringify({ ended: false, status: "working", terminal: workerPane }),
        stderr: "",
      });
      const deps: WaitDeps = {
        snapshot: () => {
          throw new Error("core 分支不该轮询 herdr 状态");
        },
        sleepMs: () => {},
        now: () => 0,
        coreSpawn,
      };
      const { code } = capture(() => runSendMailCommand([workerPane, "--text", "hi", "--wait"], deps));
      assert.equal(code, WAIT_EXIT.timeout);
    } finally {
      process.env.HERDR_ENV = "1";
      delete process.env.HC_TERMINAL_ID;
    }
  });
});

describe("hapi wake-owner", { concurrency: false }, () => {
  it("owner 忙时消息入队不拒绝：写 owner 信箱即返回，投递不经输入框", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { spawn, calls } = makeSpawn({ agentStatuses: { [ownerPane]: "working" } });
    const { code, logs } = capture(() => runWakeOwnerCommand(["--message", "报告写好了"], spawn));
    assert.equal(code, WAKE_OWNER_EXIT.sent);
    assert.match(logs.join("\n"), /已入队 w1:p7/);
    const lines = readFileSync(mailPath(ownerPane, ownerPane), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const mail = JSON.parse(lines[0]!) as MailMessage;
    assert.equal(mail.from, workerPane);
    assert.equal(mail.to, ownerPane);
    assert.equal(mail.kind, "done");
    assert.equal(mail.text, "报告写好了");
    assert.equal(mail.reportPath, undefined);
    // 投递不再经 herdr 输入框：无 pane run / send-text / send-keys 调用（owner 探活的 pane get 保留）
    assert.equal(calls.find((call) => ["run", "send-text", "send-keys"].includes(call.args[1] ?? "")), undefined);
  });

  it("--report 指向已存在的报告：信封带 reportPath，文本只留人读结果", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const report = join(home, "worker-report.md");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, "# 报告\n");
    const { code } = capture(
      () => runWakeOwnerCommand(["--message", "实现完成", "--report", report], makeSpawn().spawn),
    );
    assert.equal(code, WAKE_OWNER_EXIT.sent);
    const mail = JSON.parse(readFileSync(mailPath(ownerPane, ownerPane), "utf8").trim()) as MailMessage;
    assert.equal(mail.text, "实现完成");
    assert.equal(mail.reportPath, report);
  });

  it("位置参数被拒绝：退出 1 且不投递", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { code, errors } = capture(
      () => runWakeOwnerCommand(["done: 修好了 -> /tmp/r.md"], makeSpawn().spawn),
    );
    assert.equal(code, WAKE_OWNER_EXIT.usage);
    assert.match(errors.join("\n"), /不接受的参数/);
    assert.match(errors.join("\n"), /用法/);
    assert.equal(existsSync(mailPath(ownerPane, ownerPane)), false);
  });

  it("缺 --message：退出 1 且不投递", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { code, errors } = capture(() => runWakeOwnerCommand([], makeSpawn().spawn));
    assert.equal(code, WAKE_OWNER_EXIT.usage);
    assert.match(errors.join("\n"), /缺少 --message/);
    assert.equal(existsSync(mailPath(ownerPane, ownerPane)), false);
  });

  it("--report 指向目录：退出 1 且不投递", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const dir = join(home, "reports");
    mkdirSync(dir, { recursive: true });
    const { code, errors } = capture(
      () => runWakeOwnerCommand(["--message", "实现完成", "--report", dir], makeSpawn().spawn),
    );
    assert.equal(code, WAKE_OWNER_EXIT.usage);
    assert.match(errors.join("\n"), /不是文件/);
    assert.equal(existsSync(mailPath(ownerPane, ownerPane)), false);
  });

  it("--report= 空取值：退出 1 且不投递", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { code, errors } = capture(
      () => runWakeOwnerCommand(["--message", "实现完成", "--report="], makeSpawn().spawn),
    );
    assert.equal(code, WAKE_OWNER_EXIT.usage);
    assert.match(errors.join("\n"), /参数 --report 缺少取值/);
    assert.equal(existsSync(mailPath(ownerPane, ownerPane)), false);
  });

  it("--report 指向不存在的文件：退出 1 且不投递", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { code, errors } = capture(
      () => runWakeOwnerCommand(["--message", "实现完成", "--report", join(home, "nope.md")], makeSpawn().spawn),
    );
    assert.equal(code, WAKE_OWNER_EXIT.usage);
    assert.match(errors.join("\n"), /不存在/);
    assert.equal(existsSync(mailPath(ownerPane, ownerPane)), false);
  });

  it("没有宿主地址 / 不属于任何团队 → 退出 2", () => {
    delete process.env.HERDR_ENV;
    saveState();
    delete process.env.HERDR_PANE_ID;
    assert.equal(capture(() => runWakeOwnerCommand(["--message", "x"], makeSpawn().spawn)).code, WAKE_OWNER_EXIT.noTeam);
    process.env.HERDR_ENV = "1";  // 上一段删了宿主环境；这里要测的是「面板不属于任何团队」
    process.env.HERDR_PANE_ID = "w1:pBogus";
    const { code, errors } = capture(() => runWakeOwnerCommand(["--message", "x"], makeSpawn().spawn));
    assert.equal(code, WAKE_OWNER_EXIT.noTeam);
    assert.match(errors.join("\n"), /不属于任何团队/);
    process.env.HERDR_PANE_ID = workerPane;
    process.env.HERDR_ENV = "1";  // 上一段删了宿主环境，恢复给后续用例
  });

  it("owner pane 已不可用 → 退出 3", () => {
    saveState();
    process.env.HERDR_PANE_ID = workerPane;
    const { spawn } = makeSpawn({ alivePanes: [workerPane] });
    const { code, errors } = capture(() => runWakeOwnerCommand(["--message", "x"], spawn));
    assert.equal(code, WAKE_OWNER_EXIT.herdr);
    assert.match(errors.join("\n"), /owner w1:p7 不可用/);
  });
});
