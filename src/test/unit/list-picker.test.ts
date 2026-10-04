import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ListPickerComponent, pickFromList } from "../../shared/list-picker.js";

const themeStub = { fg: (_key: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
// DynamicBorder 走全局单例主题，测试环境需先初始化
initTheme("hapilon-dark");
const tuiStub = { requestRender: () => {} } as unknown as TUI;

function makePicker(options: string[], doneLabel?: string) {
  const results: Array<{ action: string; value?: string }> = [];
  const component = new ListPickerComponent(
    tuiStub as never,
    themeStub,
    (result) => results.push(result),
    "测试选择",
    options,
    { doneLabel },
  );
  return { component, results };
}

/** 组件可见行（Container.render 按宽度拼行）。 */
function visibleLines(component: ListPickerComponent): string[] {
  return component.render(80).filter((line) => line.trim().length > 0);
}

describe("ListPickerComponent", () => {
  const manyModels = Array.from({ length: 50 }, (_, i) => `provider/model-${i}`);

  it("完成固定在首行，长列表只渲染可视窗口并带滚动指示", () => {
    const { component } = makePicker(manyModels, "完成");
    const lines = visibleLines(component);
    const listStart = lines.findIndex((line) => line.includes("✓ 完成"));
    assert.ok(listStart >= 0, "完成项必须可见");
    assert.ok(lines.some((line) => line.includes("model-0")), "首屏应有模型");
    assert.ok(!lines.some((line) => line.includes("model-49")), "长列表不应全量渲染");
    assert.ok(lines.some((line) => /\(1\/51\)/.test(line)), "应有滚动指示");
  });

  it("输入即模糊过滤，无匹配有提示", () => {
    const { component } = makePicker(manyModels, "完成");
    for (const ch of "model-7") component.handleInput(ch);
    const lines = visibleLines(component);
    assert.ok(lines.some((line) => line.includes("model-7")), "应命中 model-7 系");
    assert.ok(!lines.some((line) => line.includes("model-10")), "不匹配的模型不应出现");
    for (const ch of "\x1b") component.handleInput(ch);
  });

  it("enter 在完成项上返回 done，在模型上返回 select（组件单发，选中即关）", () => {
    const first = makePicker(["a/x", "b/y"], "完成");
    first.component.handleInput("\r"); // 初始停在完成项
    assert.deepEqual(first.results, [{ action: "done" }]);

    const second = makePicker(["a/x", "b/y"], "完成");
    second.component.handleInput("\x1b[B"); // 下移到第一个模型
    second.component.handleInput("\r");
    assert.deepEqual(second.results, [{ action: "select", value: "a/x" }]);
  });

  it("esc 返回 cancel", () => {
    const { component, results } = makePicker(["a/x"], "完成");
    component.handleInput("\x1b");
    assert.deepEqual(results, [{ action: "cancel" }]);
  });

  it("无完成项时首行即第一个模型，enter 直接选中", () => {
    const { component, results } = makePicker(["a/x", "b/y"]);
    component.handleInput("\r");
    assert.deepEqual(results, [{ action: "select", value: "a/x" }]);
  });
});

describe("pickFromList 无 TUI 回落", () => {
  function stubCtx(selectResult: string | null | undefined) {
    return {
      ui: {
        custom: async () => {
          throw new Error("no tui");
        },
        select: async (_title: string, options: string[]) =>
          selectResult === undefined ? options[0] : selectResult === null ? undefined : selectResult,
      },
    } as never;
  }

  it("ctx.ui.custom 不可用时回落 select，选中完成项返回 null", async () => {
    const picked = await pickFromList(stubCtx("完成") as never, "标题", ["a/x", "b/y"], "完成");
    assert.equal(picked, null);
  });

  it("回落路径选中模型返回模型串，取消返回 undefined", async () => {
    assert.equal(await pickFromList(stubCtx("a/x") as never, "标题", ["a/x", "b/y"], "完成"), "a/x");
    assert.equal(await pickFromList(stubCtx(null) as never, "标题", ["a/x"], "完成"), undefined);
  });

  it("空选项直接返回 undefined", async () => {
    assert.equal(await pickFromList(stubCtx(undefined) as never, "标题", [], "完成"), undefined);
  });
});
