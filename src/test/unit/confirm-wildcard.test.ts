/**
 * requestConfirm 通配选项单元测试 — mock ctx.ui
 *
 * 覆盖：无建议时保持原 4 选项；有建议时增出通配入口；
 * 选通配后输入值 / 留空回退 / 取消 → 拒绝。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { requestConfirm } from "../../extensions/hpl-protected-paths/confirm.js";

interface MockCalls {
  select: Array<{ title: string; options: string[] }>;
  input: Array<{ title: string; placeholder: string | undefined }>;
}

function mockCtx(choice: string | undefined, typed: string | undefined): {
  ctx: unknown;
  calls: MockCalls;
} {
  const calls: MockCalls = { select: [], input: [] };
  const ctx = {
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        calls.select.push({ title, options });
        return choice;
      },
      input: async (title: string, placeholder?: string) => {
        calls.input.push({ title, placeholder });
        return typed;
      },
    },
  };
  return { ctx, calls };
}

describe("requestConfirm() — 通配选项", () => {
  it("无 allowSuggestion → 维持原 4 选项，无通配入口", async () => {
    const { ctx, calls } = mockCtx("Allow this Session", undefined);
    const result = await requestConfirm(ctx as never, "T", "M");
    assert.deepStrictEqual(calls.select[0]?.options, [
      "Allow Once",
      "Allow this Session",
      "Allow this Project",
      "Deny",
    ]);
    assert.deepStrictEqual(result, { status: "approved", scope: "session" });
  });

  it("有 allowSuggestion → 增出通配入口（会话/项目各一）", async () => {
    const { ctx, calls } = mockCtx("Deny", undefined);
    await requestConfirm(ctx as never, "T", "M", { allowSuggestion: "git push*" });
    assert.deepStrictEqual(calls.select[0]?.options, [
      "Allow Once",
      "Allow this Session",
      "Allow this Project",
      "Allow Pattern this Session",
      "Allow Pattern this Project",
      "Deny",
    ]);
  });

  it("选通配（会话）+ 输入自定义模式 → addTrust 应收到该模式", async () => {
    const { ctx, calls } = mockCtx("Allow Pattern this Session", "git push --force*");
    const result = await requestConfirm(ctx as never, "T", "M", { allowSuggestion: "git push*" });
    assert.deepStrictEqual(result, {
      status: "approved",
      scope: "session",
      allowPattern: "git push --force*",
    });
    assert.strictEqual(calls.input[0]?.placeholder, "git push*");
  });

  it("选通配（项目）→ scope project", async () => {
    const { ctx } = mockCtx("Allow Pattern this Project", "npm install*");
    const result = await requestConfirm(ctx as never, "T", "M", { allowSuggestion: "npm install*" });
    assert.deepStrictEqual(result, {
      status: "approved",
      scope: "project",
      allowPattern: "npm install*",
    });
  });

  it("留空提交 → 回退到建议模式", async () => {
    const { ctx } = mockCtx("Allow Pattern this Session", "");
    const result = await requestConfirm(ctx as never, "T", "M", { allowSuggestion: "git push*" });
    assert.deepStrictEqual(result, {
      status: "approved",
      scope: "session",
      allowPattern: "git push*",
    });
  });

  it("输入框取消（undefined）→ 拒绝", async () => {
    const { ctx } = mockCtx("Allow Pattern this Session", undefined);
    const result = await requestConfirm(ctx as never, "T", "M", { allowSuggestion: "git push*" });
    assert.deepStrictEqual(result, { status: "rejected" });
  });

  it("非交互 → unavailable（不触碰 ui）", async () => {
    const ctx = { hasUI: false, ui: {} };
    const result = await requestConfirm(ctx as never, "T", "M", { allowSuggestion: "git push*" });
    assert.deepStrictEqual(result, { status: "unavailable" });
  });
});
