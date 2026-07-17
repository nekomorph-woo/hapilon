/**
 * hpl-footer format.ts 单元测试 — 文本拼装纯函数
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatTokens,
  formatWindow,
  buildLine1,
  buildStatusLine,
  aggregateUsage,
  buildStatsLeft,
  visibleWidth,
  layoutLine,
  shortenHome,
  truncatePlain,
} from "../../extensions/hpl-footer/format.js";

describe("formatTokens — 自适应 token 格式", () => {
  it("正常路径: 各量级格式正确", () => {
    assert.equal(formatTokens(234), "234");
    assert.equal(formatTokens(2200), "2.2k");
    assert.equal(formatTokens(34000), "34k");
    assert.equal(formatTokens(1200000), "1.2M");
  });

  it("边界条件: 量级切换点", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1000), "1.0k");
    assert.equal(formatTokens(10000), "10k");
    assert.equal(formatTokens(1000000), "1.0M");
  });
});

describe("formatWindow — 窗口小写紧凑格式", () => {
  it("正常路径: 常见窗口尺寸", () => {
    assert.equal(formatWindow(200000), "200k");
    assert.equal(formatWindow(1000000), "1m");
    assert.equal(formatWindow(128000), "128k");
  });

  it("边界条件: 非整 m 值保留一位小数，0 原样", () => {
    assert.equal(formatWindow(1500000), "1.5m");
    assert.equal(formatWindow(0), "0");
    assert.equal(formatWindow(500), "500");
  });
});

describe("buildLine1 — 第 1 行", () => {
  it("正常路径: 目录 + 分支用竖线分隔", () => {
    assert.equal(buildLine1("~/hapi", "main"), "~/hapi | main");
  });

  it("边界条件: 无分支时仅目录，无竖线", () => {
    assert.equal(buildLine1("~/hapi", null), "~/hapi");
  });
});

describe("buildStatusLine — 第 3 行", () => {
  it("正常路径: 多条状态用竖线分隔", () => {
    assert.equal(buildStatusLine(["状态A", "状态B"]), "状态A | 状态B");
  });

  it("边界条件: 单条状态无分隔符", () => {
    assert.equal(buildStatusLine(["仅一条"]), "仅一条");
  });

  it("边界条件: 空数组返回 null（整行隐藏）", () => {
    assert.equal(buildStatusLine([]), null);
  });
});

describe("aggregateUsage — usage 累加", () => {
  const entry = (role: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
    type: "message",
    message: { role, usage: { input, output, cacheRead, cacheWrite } },
  });

  it("正常路径: 多条 assistant 消息累加，命中率取最后一条", () => {
    const stats = aggregateUsage([
      entry("assistant", 100, 50, 900, 0),   // 命中率 90%
      entry("assistant", 200, 100, 300, 500), // 命中率 30%
    ]);
    assert.equal(stats.input, 300);
    assert.equal(stats.output, 150);
    assert.ok(Math.abs(stats.cacheHitRate! - 30) < 0.01);
  });

  it("边界条件: 空会话返回全 0 且无命中率", () => {
    assert.deepEqual(aggregateUsage([]), { input: 0, output: 0, cacheHitRate: undefined });
  });

  it("边界条件: 非 assistant 消息与非 message 条目被忽略", () => {
    const stats = aggregateUsage([
      entry("user", 999, 999),
      { type: "compaction" },
      entry("assistant", 10, 20),
    ]);
    assert.equal(stats.input, 10);
    assert.equal(stats.output, 20);
  });

  it("异常路径: 最后一条 prompt token 为 0 时命中率为 undefined", () => {
    const stats = aggregateUsage([entry("assistant", 0, 5, 0, 0)]);
    assert.equal(stats.cacheHitRate, undefined);
  });
});

describe("buildStatsLeft — 第 2 行左侧", () => {
  it("正常路径: 完整统计行格式", () => {
    const line = buildStatsLeft(
      { input: 2200, output: 1200, cacheHitRate: 86.6 },
      41.2, 1000000, "[DING]",
    );
    assert.equal(line, "up.2.2k | down.1.2k | hit: 86.6% | ctx/win: 41.2%/1m | [DING]");
  });

  it("边界条件: 0 值项跳过（up/down/hit 均可省略）", () => {
    const line = buildStatsLeft({ input: 0, output: 0 }, 0.3, 1000000, "[DING]");
    assert.equal(line, "ctx/win: 0.3%/1m | [DING]");
  });

  it("异常路径: 占用未知（null）时百分比显示 ?", () => {
    const line = buildStatsLeft({ input: 100, output: 0 }, null, 200000, "[DING]");
    assert.equal(line, "up.100 | ctx/win: ?/200k | [DING]");
  });
});

describe("visibleWidth / layoutLine — ANSI 宽度与布局", () => {
  it("正常路径: visibleWidth 剥离真彩 ANSI 码", () => {
    assert.equal(visibleWidth("[DING]"), 6);
    assert.equal(visibleWidth("\x1b[48;2;255;200;0m\x1b[38;2;30;30;30m[DING!]\x1b[0m"), 7);
  });

  it("正常路径: 左右两端对齐，宽度正好填满", () => {
    const line = layoutLine("left", "right", 20);
    assert.equal(line, "left" + " ".repeat(11) + "right");
    assert.equal(visibleWidth(line), 20);
  });

  it("正常路径: 左侧含 ANSI 码不影响布局宽度", () => {
    const left = "\x1b[48;2;255;200;0mA\x1b[0m"; // 可见宽度 1
    const line = layoutLine(left, "R", 10);
    assert.equal(visibleWidth(line), 10);
  });

  it("边界条件: 宽度不足时截断右侧，保留左侧", () => {
    const line = layoutLine("0123456789", "MODELNAME", 15);
    assert.ok(line.startsWith("0123456789"));
    assert.ok(visibleWidth(line) <= 15);
  });

  it("异常路径: 宽度极小时仅输出左侧", () => {
    assert.equal(layoutLine("abc", "right", 4), "abc");
  });
});

describe("shortenHome — 家目录缩写", () => {
  it("正常路径: home 前缀替换为 ~", () => {
    assert.equal(shortenHome("/Users/me/proj", "/Users/me"), "~/proj");
    assert.equal(shortenHome("/Users/me", "/Users/me"), "~");
  });

  it("边界条件: home 外路径原样返回", () => {
    assert.equal(shortenHome("/Volumes/data/x", "/Users/me"), "/Volumes/data/x");
    // 前缀相似但非目录边界，不误替换
    assert.equal(shortenHome("/Users/meow/x", "/Users/me"), "/Users/meow/x");
  });

  it("异常路径: home 为空时原样返回", () => {
    assert.equal(shortenHome("/a/b", undefined), "/a/b");
  });
});

describe("truncatePlain — 纯文本截断", () => {
  it("正常路径: 不超宽原样返回", () => {
    assert.equal(truncatePlain("abc", 10), "abc");
  });

  it("边界条件: 超宽截断并追加省略号", () => {
    assert.equal(truncatePlain("0123456789", 8), "01234...");
    assert.equal(truncatePlain("0123456789", 10), "0123456789");
  });
});

describe("buildStatusLine — 控制字符清洗", () => {
  it("异常路径: 状态文本中的换行/制表符被压成单个空格", () => {
    assert.equal(buildStatusLine(["a\nb", "c\t\td"]), "a b | c d");
  });
});
