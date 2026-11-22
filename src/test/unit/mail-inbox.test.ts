import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deliverMail, ownMailbox, senderLabel } from "../../extensions/hpl-orchestra/mail-inbox.js";
import { drainMail, mailPath, postMail, type MailMessage } from "../../extensions/hpl-orchestra/mail.js";
import { resolveSessionStatePath, teamsDir, writeTeamStateEffect, type TeamState } from "../../extensions/hpl-orchestra/state.js";

const ownerPane = "w9:p1";
const workerPane = "w9:p2";

let home: string;
const originalEnv = {
  home: process.env.HAPILON_HOME,
  pane: process.env.HERDR_PANE_ID,
  role: process.env.HAPI_ORCH_ROLE,
  herdr: process.env.HERDR_ENV,
};

before(() => {
  for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"] as const) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "hapilon-mail-inbox-test-"));
  process.env.HAPILON_HOME = home;
  process.env.HERDR_ENV = "1";
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

const originalHome = (saved: string): string => saved;

beforeEach(() => {
  rmSync(teamsDir(), { recursive: true, force: true });
  process.env.HERDR_PANE_ID = ownerPane;
});

const stateFor = (): TeamState => ({
  enabled: true,
  since: "2026-11-21T10:00:00.000Z",
  owner: { paneId: ownerPane, nickname: "阿岚" },
  roles: [
    { key: "worker", instances: [{ paneId: workerPane, model: null, nickname: "阿澈" }] },
    { key: "reviewer", instances: [{ paneId: "w9:p3", model: null }] },
  ],
});

describe("senderLabel", () => {
  const state = stateFor();

  it("role 昵称优先", () => {
    assert.equal(senderLabel(state, workerPane), "阿澈");
  });

  it("owner 用自己的昵称", () => {
    assert.equal(senderLabel(state, ownerPane), "阿岚");
  });

  it("未知发送方退回 pane id", () => {
    assert.equal(senderLabel(state, "w9:zz"), "w9:zz");
  });
});

describe("ownMailboxForTest", () => {
  it("role pane 定位到自己实例的落盘 key", () => {
    Effect.runSync(writeTeamStateEffect(stateFor(), resolveSessionStatePath()));
    process.env.HERDR_PANE_ID = workerPane;
    const own = ownMailbox();
    assert.equal(own?.paneId, workerPane);
    assert.equal(own?.storeKey, workerPane);
  });

  it("owner pane 用自己的 pane id 当 storeKey", () => {
    Effect.runSync(writeTeamStateEffect(stateFor(), resolveSessionStatePath()));
    process.env.HERDR_PANE_ID = ownerPane;
    const own = ownMailbox();
    assert.equal(own?.storeKey, ownerPane);
  });

  it("不在任何团队返回 undefined", () => {
    process.env.HERDR_PANE_ID = "w9:nowhere";
    assert.equal(ownMailbox(), undefined);
  });
});

describe("deliverMail + drainMail", () => {
  const fakePi = (sent: string[], opts: Array<{ deliverAs?: string }> = []): ExtensionAPI => ({
    sendUserMessage: (text: string, options?: { deliverAs?: "steer" | "followUp" }) => {
      sent.push(text);
      opts.push({ ...(options?.deliverAs ? { deliverAs: options.deliverAs } : {}) });
    },
  }) as unknown as ExtensionAPI;

  const post = (text: string, reportPath?: string): void => {
    const msg: MailMessage = {
      id: `m-${text}`,
      from: workerPane,
      to: ownerPane,
      kind: "done",
      text,
      ...(reportPath ? { reportPath } : {}),
    };
    Effect.runSync(postMail(ownerPane, msg));
  };

  const drain = (sent: string[], idle: boolean, opts?: Array<{ deliverAs?: string }>): void => {
    const result = Effect.runSync(
      Effect.either(drainMail(ownerPane, ownerPane, deliverMail(fakePi(sent, opts), stateFor(), () => idle))),
    );
    assert.equal(result._tag, "Right");
  };

  it("忙时不投递：信留在文件里，空闲后下一轮补投并清空", () => {
    const sent: string[] = [];
    post("回归测试通过", "/abs/worker-report.md");
    drain(sent, false);
    assert.deepEqual(sent, []);
    assert.equal(readFileSync(mailPath(ownerPane, ownerPane), "utf8").trim().split("\n").length, 1);
    drain(sent, true);
    assert.deepEqual(sent, ["[阿澈 w9:p2] 回归测试通过（报告：/abs/worker-report.md）"]);
    assert.equal(readFileSync(mailPath(ownerPane, ownerPane), "utf8"), "");
  });

  it("投递带 deliverAs: followUp：忙时进队而不反弹，信号不丢", () => {
    const sent: string[] = [];
    const opts: Array<{ deliverAs?: string }> = [];
    post("兜底");
    drain(sent, true, opts);
    assert.deepEqual(sent, ["[阿澈 w9:p2] 兜底"]);
    assert.deepEqual(opts, [{ deliverAs: "followUp" }]);
  });

  it("空闲时按顺序投完并清空文件", () => {
    const sent: string[] = [];
    post("第一封");
    post("第二封");
    drain(sent, true);
    assert.deepEqual(sent, ["[阿澈 w9:p2] 第一封", "[阿澈 w9:p2] 第二封"]);
    assert.equal(readFileSync(mailPath(ownerPane, ownerPane), "utf8"), "");
  });
});
