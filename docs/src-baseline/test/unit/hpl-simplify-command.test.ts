/**
 * hpl-simplify 命令 handler 测试 — 交互流程（#56）
 *
 * 用 mock pi 验证：命令注册、check 阶段只读 prompt 派发、
 * apply 子命令的编号解析与人工确认闸门。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import hplSimplify from "../../extensions/hpl-simplify/index.js";
import { buildAuditPrompt, buildApplyPrompt } from "../../extensions/hpl-simplify/audit.js";

/** 最小 ExtensionAPI mock：记录注册与发送的消息 */
function makeMockPi() {
  const commands = new Map<string, { handler: Function }>();
  const sent: string[] = [];
  return {
    pi: {
      registerCommand: (name: string, def: { handler: Function }) => commands.set(name, def),
      sendUserMessage: (content: string) => sent.push(content),
    } as never,
    commands,
    sent,
  };
}

/** 最小 ExtensionCommandContext mock：记录通知与确认 */
function makeMockCtx(confirmResult: boolean | null = null) {
  const notifies: Array<{ msg: string; kind: string }> = [];
  const confirmCalls: string[] = [];
  return {
    ctx: {
      ui: {
        notify: (msg: string, kind: string) => notifies.push({ msg, kind }),
        confirm: (_title: string, message: string) => {
          confirmCalls.push(message);
          return Promise.resolve(confirmResult);
        },
      },
    } as never,
    notifies,
    confirmCalls,
  };
}

describe("hpl-simplify 命令", () => {
  let mock: ReturnType<typeof makeMockPi>;

  beforeEach(() => {
    mock = makeMockPi();
    hplSimplify(mock.pi);
  });

  it("注册 /simplify 命令", () => {
    assert.ok(mock.commands.has("simplify"), "simplify 命令已注册");
  });

  describe("check 阶段（只读审查）", () => {
    it("无参数：派发 HEAD 审查 prompt，通知用户裁决方式", async () => {
      const { ctx, notifies } = makeMockCtx();
      await mock.commands.get("simplify")!.handler("", ctx);
      assert.equal(mock.sent.length, 1, "发送一条 prompt");
      assert.ok(mock.sent[0].includes("git show HEAD"), "HEAD 范围");
      assert.ok(mock.sent[0].includes("DO NOT"), "只读禁令");
      assert.ok(
        notifies[0].msg.includes("/simplify apply"),
        "通知里告知 apply 裁决方式",
      );
    });

    it("--staged：派发 staged 审查", async () => {
      const { ctx } = makeMockCtx();
      await mock.commands.get("simplify")!.handler("--staged", ctx);
      assert.ok(mock.sent[0].includes("git diff --cached"), "staged diff 命令");
    });

    it("未知参数：报用法提示，不派发任何 prompt", async () => {
      const { ctx, notifies } = makeMockCtx();
      await mock.commands.get("simplify")!.handler("--bogus", ctx);
      assert.equal(mock.sent.length, 0, "零派发");
      assert.ok(notifies[0].kind === "error", "错误通知");
    });

    it("审查 prompt 与 buildAuditPrompt 同源", async () => {
      const { ctx } = makeMockCtx();
      await mock.commands.get("simplify")!.handler("main..HEAD", ctx);
      assert.equal(mock.sent[0], buildAuditPrompt({ kind: "range", from: "main", to: "HEAD" }));
    });
  });

  describe("apply 子命令（受控执行 + 人工闸门）", () => {
    it("apply 2,4：解析编号、确认通过后派发执行 prompt", async () => {
      const { ctx, confirmCalls } = makeMockCtx(true);
      await mock.commands.get("simplify")!.handler("apply 2,4", ctx);
      assert.equal(confirmCalls.length, 1, "执行前确认一次");
      assert.equal(mock.sent.length, 1);
      assert.equal(mock.sent[0], buildApplyPrompt([2, 4]), "与 buildApplyPrompt 同源");
    });

    it("确认拒绝：不派发任何 prompt", async () => {
      const { ctx } = makeMockCtx(false);
      await mock.commands.get("simplify")!.handler("apply 2,4", ctx);
      assert.equal(mock.sent.length, 0, "拒绝即零执行");
    });

    it("无 ui（json/rpc 降级）：直接派发不阻塞", async () => {
      const ctx = { ui: undefined } as never;
      await mock.commands.get("simplify")!.handler("apply 1", ctx);
      assert.equal(mock.sent.length, 1, "无 UI 时派发（自动化场景）");
    });

    it("apply 无有效编号：报用法，不派发", async () => {
      const { ctx, notifies } = makeMockCtx();
      await mock.commands.get("simplify")!.handler("apply abc", ctx);
      assert.equal(mock.sent.length, 0);
      assert.ok(notifies[0].kind === "error");
    });
  });
});
