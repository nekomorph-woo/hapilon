/**
 * floating-pane.ts 单元测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FloatingPane, showFloatingPane } from "../../shared/floating-pane/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTheme: any = { fg: (_name: string, text: string) => text };

function makePane(lines: string[] = [], title = "Test") {
  const state = { called: false };
  const done = {
    get called() { return state.called; },
    fn() { state.called = true; },
  };
  const pane = new FloatingPane(null, mockTheme, null, done.fn, {
    title,
    lines,
    footer: "footer text",
  });
  return { pane, done };
}

describe("FloatingPane", () => {
  describe("render", () => {
    it("正常路径: 渲染 Unicode 边框 + 标题 + 内容", () => {
      const { pane } = makePane(["line 1", "line 2"]);
      const result = pane.render(80);
      assert.ok(result.length > 3, "至少 4 行");
      assert.ok(result[0]!.includes("╭"), "顶部边框 ╭"); // ╭
      assert.ok(result[0]!.includes("Test"), "包含标题");
      const lastBorder = result[result.length - 2]!;
      assert.ok(lastBorder.includes("╰"), "底部边框 ╰"); // ╰
      assert.ok(result[result.length - 1]!.includes("footer"), "包含 footer");
    });

    it("正常路径: 内容行用 │ 包裹", () => {
      const { pane } = makePane(["hello world"]);
      const result = pane.render(80);
      const contentLine = result.find((l: string) => l.includes("hello world"));
      assert.ok(contentLine, "内容行存在");
      assert.ok(contentLine!.includes("│"), "被 │ 包裹"); // │
    });

    it("边界条件: 空 lines 显示 No content", () => {
      const { pane } = makePane([]);
      const result = pane.render(80);
      assert.ok(result.some((l: string) => l.includes("No content")), "空内容显示提示");
    });
  });

  describe("handleInput", () => {
    it("正常路径: Esc 关闭", () => {
      const { pane, done } = makePane(["a", "b"]);
      pane.render(80);
      pane.handleInput("\x1b");
      assert.ok(done.called, "Esc 应调用 done");
    });

    it("正常路径: q 关闭", () => {
      const { pane, done } = makePane(["a"]);
      pane.render(80);
      pane.handleInput("q");
      assert.ok(done.called, "q 应调用 done");
    });

    it("边界条件: unhandled key 返回 false", () => {
      const { pane } = makePane(["a"]);
      pane.render(80);
      const result = pane.handleInput("x");
      assert.equal(result, false, "未识别按键返回 false");
    });

    it("正常路径: 滚动不崩溃", () => {
      const { pane } = makePane(["a"]);
      pane.render(80);
      pane.handleInput("\x1b[A"); // up
      pane.handleInput("\x1b[B"); // down
      // 不应崩溃
    });
  });

  describe("isFocusable", () => {
    it("返回 true", () => {
      const { pane } = makePane();
      assert.equal(pane.isFocusable, true);
    });
  });

  describe("static show", () => {
    it("正常路径: TUI 模式下调用 ui.custom", async () => {
      let customCalled = false;
      const mockCtx = {
        mode: "tui",
        hasUI: true,
        ui: {
          custom(_factory: unknown, _opts: unknown): Promise<void> {
            customCalled = true;
            return Promise.resolve();
          },
        },
      };
      await showFloatingPane(mockCtx, { title: "X", lines: ["a"] });
      assert.ok(customCalled, "ui.custom 被调用");
    });

    it("边界条件: 非 TUI 模式不调用 ui.custom", async () => {
      let customCalled = false;
      const mockCtx = {
        mode: "print",
        hasUI: false,
        ui: {
          custom(): Promise<void> {
            customCalled = true;
            return Promise.resolve();
          },
        },
      };
      await showFloatingPane(mockCtx, { title: "X", lines: ["a"] });
      assert.ok(!customCalled, "非 TUI 模式不调用 ui.custom");
    });
  });
});
