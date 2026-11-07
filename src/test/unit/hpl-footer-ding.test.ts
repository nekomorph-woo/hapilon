/**
 * hpl-footer ding.ts 单元测试 — 占用徽章：<?> 未知、盲文点阵呼吸、无徽章段
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dingColor, dingGlyph, renderDing } from "../../extensions/hpl-footer/ding.js";

describe("dingGlyph — 盲文水位与呼吸", () => {
  it("正常路径: 水位点阵 8 档对应 0-100%，从底部逐层点亮", () => {
    assert.equal(dingGlyph(0), "<⡀>");
    assert.equal(dingGlyph(12), "<⡀>");
    assert.equal(dingGlyph(25), "<⣀>");
    assert.equal(dingGlyph(50), "<⣤>");
    assert.equal(dingGlyph(79.9), "<⣶>");
  });

  it("正常路径: 呼吸档烧开轮换，四拍 1.5s 循环复位", () => {
    assert.equal(dingGlyph(85, 0), "<⣿>");
    assert.equal(dingGlyph(85, 1500), "<⣾>");
    assert.equal(dingGlyph(85, 3000), "<⣽>");
    assert.equal(dingGlyph(85, 4500), "<⣼>");
    assert.equal(dingGlyph(85, 6000), "<⣿>");
  });

  it("异常路径: 占用未知显示 <?>", () => {
    assert.equal(dingGlyph(null, 1500), "<?>");
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
  it("正常路径: 水位档带渐变色块（70% 黄底黑字 ⣶）", () => {
    const out = renderDing(70);
    assert.equal(out, "\x1b[48;2;255;200;0m\x1b[38;2;30;30;30m<⣶>\x1b[0m");
  });

  it("边界条件: 0% 空点阵无背景", () => {
    assert.equal(renderDing(0), "<⡀>");
  });

  it("异常路径: null 占用输出 <?>", () => {
    assert.equal(renderDing(null), "<?>");
  });
});

describe("renderDing — 呼吸（字符 1.5s 轮换、背景 3s 呼吸）", () => {
  it("正常路径: 背景四拍起伏（3s 拍）——基准/提亮/基准/压暗（R 通道）", () => {
    const rOf = (ms: number) => renderDing(85, ms).match(/\x1b\[48;2;(\d+);/)![1];
    const base = rOf(0);
    assert.equal(rOf(3000) !== base, true); // 提亮
    assert.equal(rOf(6000), base); // 第 3 拍回基准
    assert.equal(rOf(9000) !== base, true); // 压暗
    assert.equal(rOf(12000), base); // 第 5 拍 = 新周期首拍
  });

  it("边界条件: 79.9% 不呼吸，80% 开始呼吸（字符与背景双验证）", () => {
    assert.equal(renderDing(79.9, 1500), renderDing(79.9, 0));
    assert.equal(renderDing(80, 1500) !== renderDing(80, 0), true); // 字符拍变
    assert.equal(renderDing(80, 3000) !== renderDing(80, 1500), true); // 背景拍也变
  });

  it("边界条件: 字色不随拍变（fg 按未调制基色算）", () => {
    const fg = (ms: number) => renderDing(85, ms).match(/\x1b\[38;2;[^m]+m/)![0];
    assert.equal(fg(1500), fg(0));
    assert.equal(fg(9000), fg(0));
  });

  it("异常路径: null 占用与呼吸无关", () => {
    assert.equal(renderDing(null, 1500), renderDing(null, 9000));
  });
});

describe("renderDing — 字符/背景拍独立", () => {
  it("正常路径: 1500ms：水位档外字符拍 1 → ⣾、背景拍 0 → 未调制基色", () => {
    // 90%：字符走呼吸 ⣾（U+28FE）；背景 3s 拍 0 → gain 1 → RED 基色
    const out = renderDing(90, 1500);
    assert.equal(out, "\x1b[48;2;220;40;30m\x1b[38;2;245;245;245m<⣾>\x1b[0m");
  });

  it("正常路径: 3000ms：字符拍 2 → ⣽、背景拍 1 → 提亮，两拍脱钩", () => {
    const out = renderDing(90, 3000);
    assert.equal(out, "\x1b[48;2;255;50;38m\x1b[38;2;245;245;245m<⣽>\x1b[0m");
  });
});
