import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_AGENT,
  HERDR_SOURCE,
  blockMessage,
  createHerdrReporter,
  releaseAgentArgs,
  reportAgentArgs,
  reporterEnabled,
} from "../../extensions/hpl-herdr/report.js";

/** 记录 spawn 调用的假 SpawnFn */
function makeSpawn(result: { error?: Error } = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  return {
    calls,
    spawn: (file: string, args: string[]) => {
      calls.push({ file, args });
      return { status: result.error ? 1 : 0, error: result.error };
    },
  };
}

const ENV = { herdrEnv: "1", binPath: "/opt/herdr/bin/herdr", paneId: "w1:p7" };

describe("reporterEnabled()", () => {
  it("herdr pane 内且信息齐全才启用", () => {
    assert.equal(reporterEnabled(ENV), true);
  });
  it("缺任一条件即 no-op", () => {
    assert.equal(reporterEnabled({ ...ENV, herdrEnv: undefined }), false);
    assert.equal(reporterEnabled({ ...ENV, herdrEnv: "0" }), false);
    assert.equal(reporterEnabled({ ...ENV, binPath: undefined }), false);
    assert.equal(reporterEnabled({ ...ENV, paneId: undefined }), false);
  });
});

describe("reportAgentArgs()", () => {
  it("基本参数：source/agent/state/seq 齐全", () => {
    assert.deepEqual(reportAgentArgs("w1:p7", "working", 3), [
      "pane", "report-agent", "w1:p7",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--state", "working",
      "--seq", "3",
    ]);
  });
  it("message 与 session 路径附加", () => {
    assert.deepEqual(reportAgentArgs("w1:p7", "blocked", 4, { message: "select: 选哪个", sessionPath: "/x/s.jsonl" }), [
      "pane", "report-agent", "w1:p7",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--state", "blocked",
      "--seq", "4",
      "--message", "select: 选哪个",
      "--agent-session-path", "/x/s.jsonl",
    ]);
  });
  it("release 不带 seq（官方协议无该参数）", () => {
    assert.deepEqual(releaseAgentArgs("w1:p7"), [
      "pane", "release-agent", "w1:p7", "--source", HERDR_SOURCE, "--agent", HERDR_AGENT,
    ]);
  });
});

describe("blockMessage()", () => {
  it("标题优先，否则用 prompt 类型", () => {
    assert.equal(blockMessage({ kind: "confirm", title: "允许写入?" }), "confirm: 允许写入?");
    assert.equal(blockMessage({ kind: "select" }), "select");
    assert.equal(blockMessage({}), "prompt");
  });
});

describe("createHerdrReporter()", () => {
  it("非 herdr 环境严格 no-op（不 spawn）", () => {
    const { spawn, calls } = makeSpawn();
    const reporter = createHerdrReporter({ spawn, env: { ...ENV, herdrEnv: undefined } });
    assert.equal(reporter.enabled, false);
    reporter.report("working");
    reporter.release();
    assert.equal(calls.length, 0);
  });

  it("报告走 HERDR_BIN_PATH，seq 严格递增，release 收尾", () => {
    const { spawn, calls } = makeSpawn();
    const reporter = createHerdrReporter({ spawn, env: ENV });
    reporter.report("idle", { sessionPath: "/s.jsonl" });
    reporter.report("working");
    reporter.report("blocked", { message: "confirm" });
    reporter.report("idle");
    reporter.release();

    assert.equal(calls.length, 5);
    assert.ok(calls.every((c) => c.file === ENV.binPath));
    const seqs = calls.slice(0, 4).map((c) => Number(c.args[c.args.indexOf("--seq") + 1]));
    assert.deepEqual(seqs, [1, 2, 3, 4], "seq 必须严格递增");
    assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--state") + 1], "idle");
    assert.equal(calls[3]!.args[calls[3]!.args.indexOf("--state") + 1], "idle");
    assert.ok(calls[0]!.args.includes("--agent-session-path"));
    assert.equal(calls[4]!.args[1], "release-agent");
  });

  it("上报失败告警一次而非静默吞掉", () => {
    const { spawn } = makeSpawn({ error: new Error("herdr 不在 PATH") });
    const errors: string[] = [];
    const reporter = createHerdrReporter({ spawn, env: ENV, onError: (m) => errors.push(m) });
    reporter.report("working");
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.includes("herdr 不在 PATH"));
  });
});
