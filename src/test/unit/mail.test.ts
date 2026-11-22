import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  clearMail,
  drainMail,
  isMailMessage,
  mailPath,
  newMailId,
  postMail,
  type MailMessage,
} from "../../extensions/hpl-orchestra/mail.js";
import { teamsDir } from "../../extensions/hpl-orchestra/state.js";

const storeKey = "abc123def456";
const paneId = "w1:p8";

let home: string;
const originalHome = process.env.HAPILON_HOME;

before(() => {
  home = mkdtempSync(join(tmpdir(), "hapilon-mail-test-"));
  process.env.HAPILON_HOME = home;
});

after(() => {
  if (originalHome === undefined) delete process.env.HAPILON_HOME;
  else process.env.HAPILON_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(teamsDir(), { recursive: true, force: true });
});

const msg = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  id: newMailId(),
  from: "w1:p7",
  to: paneId,
  kind: "done",
  text: "单元 1 完成",
  ...overrides,
});

/** 全部成功的投递回调：收进 log，返回 true。 */
const recordingDeliver = (log: MailMessage[]) => (m: MailMessage) =>
  Effect.sync(() => {
    log.push(m);
    return true;
  });

const rawLines = (): string[] =>
  readFileSync(mailPath(storeKey, paneId), "utf8").split("\n").filter((line) => line.trim().length > 0);

describe("mailPath", () => {
  it("storeKey 与 paneId 的冒号转下划线，目录与任务列表同层", () => {
    assert.equal(mailPath("a:b", "c:d"), join(teamsDir(), "a_b.mail", "c_d.jsonl"));
  });
});

describe("newMailId", () => {
  it("两次生成不重复", () => {
    assert.notEqual(newMailId(), newMailId());
  });
});

describe("isMailMessage", () => {
  it("未知 kind 拒绝", () => {
    assert.equal(isMailMessage({ ...msg(), kind: "urgent" }), false);
    assert.equal(isMailMessage(msg()), true);
  });
});

describe("postMail + drainMail", () => {
  it("post 后 drain 收到原文，全部成功后清空", () => {
    Effect.runSync(postMail(storeKey, msg()));
    Effect.runSync(postMail(storeKey, msg({ text: "第二条" })));
    const received: MailMessage[] = [];
    Effect.runSync(drainMail(storeKey, paneId, recordingDeliver(received)));
    assert.equal(received.length, 2);
    assert.equal(received[0]!.text, "单元 1 完成");
    assert.equal(received[1]!.text, "第二条");
    assert.equal(readFileSync(mailPath(storeKey, paneId), "utf8"), "");
  });

  it("信箱不存在时 drain 直接返回，不创建文件", () => {
    const received: MailMessage[] = [];
    Effect.runSync(drainMail(storeKey, paneId, recordingDeliver(received)));
    assert.equal(received.length, 0);
    assert.equal(existsSync(mailPath(storeKey, paneId)), false);
  });

  it("deliver 首败：已投前缀截断，剩余保留待重试", () => {
    Effect.runSync(postMail(storeKey, msg({ text: "第一" })));
    Effect.runSync(postMail(storeKey, msg({ text: "第二" })));
    Effect.runSync(postMail(storeKey, msg({ text: "第三" })));
    const delivered: string[] = [];
    Effect.runSync(drainMail(storeKey, paneId, (m) =>
      Effect.sync(() => {
        if (m.text === "第二") return false;
        delivered.push(m.text);
        return true;
      })));
    assert.deepEqual(delivered, ["第一"]);
    assert.deepEqual(
      rawLines().map((line) => (JSON.parse(line) as MailMessage).text),
      ["第二", "第三"],
    );
    const retried: string[] = [];
    Effect.runSync(drainMail(storeKey, paneId, (m) =>
      Effect.sync(() => {
        retried.push(m.text);
        return true;
      })));
    assert.deepEqual(retried, ["第二", "第三"]);
    assert.equal(readFileSync(mailPath(storeKey, paneId), "utf8"), "");
  });
});

describe("坏行容错", () => {
  it("非 JSON 行跳过不投递", () => {
    const path = mailPath(storeKey, paneId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{broken json\n" + `${JSON.stringify(msg({ text: "好的" }))}\n`);
    const received: MailMessage[] = [];
    Effect.runSync(drainMail(storeKey, paneId, recordingDeliver(received)));
    assert.deepEqual(received.map((m) => m.text), ["好的"]);
    assert.equal(readFileSync(path, "utf8"), "");
  });
});

describe("clearMail", () => {
  it("清空已有信箱", () => {
    Effect.runSync(postMail(storeKey, msg()));
    Effect.runSync(clearMail(storeKey, paneId));
    const received: MailMessage[] = [];
    Effect.runSync(drainMail(storeKey, paneId, recordingDeliver(received)));
    assert.equal(received.length, 0);
  });

  it("对不存在的信箱是空操作，不创建文件", () => {
    Effect.runSync(clearMail(storeKey, paneId));
    assert.equal(existsSync(mailPath(storeKey, paneId)), false);
  });
});
