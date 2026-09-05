/**
 * hpl-footer ding.ts 单元测试 — [HOT] 指示灯文案分级与渐变色
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dingLabel, dingColor, renderDing } from "../../extensions/hpl-footer/ding.js";

describe("dingLabel — 感叹号分级", () => {
  it("正常路径: 低占用无感叹号", () => {
    assert.equal(dingLabel(0), "[HOT]");
    assert.equal(dingLabel(35), "[HOT]");
  });

  it("边界条件: 69.9% 仍无感叹号，70% 出现 1 个", () => {
    assert.equal(dingLabel(69.9), "[HOT]");
    assert.equal(dingLabel(70), "[HOT!]");
  });

  it("边界条件: 各阈值感叹号数量 80→2 / 85→3 / 90→4 / 95→5", () => {
    assert.equal(dingLabel(80), "[HOT!!]");
    assert.equal(dingLabel(85), "[HOT!!!]");
    assert.equal(dingLabel(90), "[HOT!!!!]");
    assert.equal(dingLabel(95), "[HOT!!!!!]");
  });

  it("边界条件: 阈值之间取低档，超 95% 封顶 5 个", () => {
    assert.equal(dingLabel(79.9), "[HOT!]");
    assert.equal(dingLabel(84.9), "[HOT!!]");
    assert.equal(dingLabel(89.9), "[HOT!!!]");
    assert.equal(dingLabel(94.9), "[HOT!!!!]");
    assert.equal(dingLabel(100), "[HOT!!!!!]");
  });

  it("异常路径: 占用未知（null）时退回无感叹号", () => {
    assert.equal(dingLabel(null), "[HOT]");
  });
});

describe("dingColor — 渐变背景与自适应字色", () => {
  it("正常路径: 渐变分段端点颜色正确", () => {
    // 70% = 正黄，90% = 红，95% 及以上 = 深红
    assert.deepEqual(dingColor(70).bg, [255, 200, 0]);
    assert.deepEqual(dingColor(90).bg, [220, 40, 30]);
    assert.deepEqual(dingColor(95).bg, [139, 0, 0]);
    assert.deepEqual(dingColor(100).bg, [139, 0, 0]);
  });

  it("正常路径: 段内颜色单调插值（35% 介于暗黄与正黄之间）", () => {
    const mid = dingColor(35).bg!;
    // R 通道: 暗黄64 < mid < 正黄255
    assert.ok(mid[0] > 64 && mid[0] < 255);
    // B 通道恒为 0（暗黄→正黄 两端 B 均为 0）
    assert.equal(mid[2], 0);
  });

  it("正常路径: 黄→红段中点（80%）R 通道保持高位、G 通道下降", () => {
    const mid = dingColor(80).bg!;
    assert.ok(mid[1] < 200 && mid[1] > 40); // G 从 200 降向 40
  });

  it("正常路径: 亮背景配黑字、暗背景配白字", () => {
    // 70% 正黄（亮）→ 黑字
    assert.deepEqual(dingColor(70).fg, [30, 30, 30]);
    // 95% 深红（暗）→ 白字
    assert.deepEqual(dingColor(95).fg, [245, 245, 245]);
  });

  it("边界条件: 0% 无背景无字色", () => {
    assert.deepEqual(dingColor(0), { bg: null, fg: null });
  });

  it("异常路径: null 占用无背景，负数视同 0", () => {
    assert.deepEqual(dingColor(null), { bg: null, fg: null });
    assert.deepEqual(dingColor(-5), { bg: null, fg: null });
  });
});

describe("renderDing — ANSI 真彩包裹", () => {
  it("正常路径: 输出含背景码、前景码、文案、复位码", () => {
    const out = renderDing(70);
    assert.equal(out, "\x1b[48;2;255;200;0m\x1b[38;2;30;30;30m[HOT!]\x1b[0m");
  });

  it("边界条件: 0% 无背景时输出纯文案（无 ANSI 码）", () => {
    assert.equal(renderDing(0), "[HOT]");
  });

  it("异常路径: null 占用输出纯文案", () => {
    assert.equal(renderDing(null), "[HOT]");
  });
});
