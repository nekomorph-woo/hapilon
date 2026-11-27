import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantTextTimeText,
  formatToolElapsed,
  TimeLine,
  toolTimeText,
  type AssistantTextComponent,
  type StepTimeState,
  type ToolComponent,
} from "../../extensions/hpl-message-time/step-time.js";

const style = (text: string) => `<dim>${text}</dim>`;
const lines = (line: TimeLine): string[] => line.render(40).map((l) => l.trim()).filter((l) => l !== "");
const at = (h: number, m: number, s: number) => new Date(2026, 9, 24, h, m, s).getTime();

test("formatToolElapsed：10 秒内一位小数，之后整秒与分秒", () => {
  assert.equal(formatToolElapsed(230), "0.2s");
  assert.equal(formatToolElapsed(9_400), "9.4s");
  assert.equal(formatToolElapsed(45_300), "45s");
  assert.equal(formatToolElapsed(125_000), "2m05s");
});

test("工具块：执行前保持空行；开跑后显示开始时刻，耗时随时间走，完成后冻结", () => {
  const comp: ToolComponent = { executionStarted: false, isPartial: true, outputPad: 1 };
  const state: StepTimeState = {};
  assert.equal(toolTimeText(comp, state, at(12, 0, 0)), undefined);

  comp.executionStarted = true;
  assert.equal(toolTimeText(comp, state, at(12, 0, 0)), "12:00:00 · 0.0s");
  assert.equal(toolTimeText(comp, state, at(12, 0, 2)), "12:00:00 · 2.0s");

  Object.assign(comp, { isPartial: false, result: { durationMs: 2_300 } });
  assert.equal(toolTimeText(comp, state, at(12, 5, 0)), "12:00:00 · 2.3s");
});

test("TimeLine：resolve 给出文本才把空行换成时间行，文本没变就不动节点", () => {
  let text: string | undefined;
  const line = new TimeLine(() => text, 1, style);
  assert.deepEqual(lines(line), []);
  text = "12:00:00 · 2.0s";
  assert.deepEqual(lines(line), ["<dim>12:00:00 · 2.0s</dim>"]);
  assert.deepEqual(lines(line), ["<dim>12:00:00 · 2.0s</dim>"]);
  text = undefined;
  assert.deepEqual(lines(line), []);
});

test("toolTimeText：回放历史工具的开始时刻 = 结束时刻 - 耗时", () => {
  const comp: ToolComponent = { executionStarted: false, isPartial: false, result: { durationMs: 3_000, timestamp: at(23, 59, 58) }, outputPad: 1 };
  assert.equal(toolTimeText(comp, {}, at(0, 0, 0)), "23:59:55 · 3.0s");
});

test("toolTimeText：被中止的工具只显示开始时刻；历史里连时刻都没有就保持空行", () => {
  const aborted: ToolComponent = { executionStarted: true, isPartial: false, result: {}, outputPad: 1 };
  assert.equal(toolTimeText(aborted, {}, at(12, 0, 0)), "12:00:00");

  const stale: ToolComponent = { executionStarted: false, isPartial: false, result: {}, outputPad: 1 };
  assert.equal(toolTimeText(stale, {}, at(12, 0, 0)), undefined);
});

test("正文块：流式期间空行，写完后的第一帧记时刻并冻结", () => {
  const comp: AssistantTextComponent = { isStreaming: true, outputPad: 1 };
  const state: StepTimeState = {};
  assert.equal(assistantTextTimeText(comp, state, at(12, 0, 30)), undefined);

  comp.isStreaming = false;
  assert.equal(assistantTextTimeText(comp, state, at(12, 0, 41)), "12:00:41");
  assert.equal(assistantTextTimeText(comp, state, at(12, 5, 0)), "12:00:41");
});

test("正文块：回放时用会话条目的时间戳，即写完的时刻", () => {
  const comp: AssistantTextComponent = { isStreaming: false, outputPad: 1, timestamp: at(23, 47, 40) };
  assert.equal(assistantTextTimeText(comp, {}, at(0, 0, 0)), "23:47:40");
});
