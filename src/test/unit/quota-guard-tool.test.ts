// quota_check 工具的判定纯函数：水位等级、滚动窗识别与输出格式。
// 阈值是 quota-guard skill 行动表的数据侧契约（97/90），改阈值两处同步。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quotaWindowLevel, isRollingWindow, formatQuotaCheckText } from "../../extensions/hpl-quota-usage/index.js";
import type { QuotaSnapshot } from "../../extensions/hpl-quota-usage/snapshot.js";

const NOW = Date.parse("2026-10-24T12:00:00+08:00");

function snap(windows: QuotaSnapshot["windows"]): QuotaSnapshot {
  return { provider: "glm", windows, timestamp: NOW };
}

describe("quotaWindowLevel", () => {
  it("阈值：>=97 HOT，>=90 WARN，否则 OK", () => {
    assert.equal(quotaWindowLevel(97), "HOT");
    assert.equal(quotaWindowLevel(96.9), "WARN");
    assert.equal(quotaWindowLevel(90), "WARN");
    assert.equal(quotaWindowLevel(89.9), "OK");
    assert.equal(quotaWindowLevel(0), "OK");
  });
});

describe("isRollingWindow", () => {
  it("以 h 结尾的是滚动窗（5h/3h），wk/mo 是长周期", () => {
    assert.equal(isRollingWindow("5h"), true);
    assert.equal(isRollingWindow("3h"), true);
    assert.equal(isRollingWindow("wk"), false);
    assert.equal(isRollingWindow("mo"), false);
  });
});

describe("formatQuotaCheckText", () => {
  it("all_ok：无警告行", () => {
    const text = formatQuotaCheckText(snap([{ window: "5h", percent: 63, resetAt: undefined }]), NOW);
    assert.ok(text.includes("5h  63%"));
    assert.ok(text.includes("verdict: all_ok"));
  });

  it("warn：列出窗口名", () => {
    const text = formatQuotaCheckText(snap([{ window: "wk", percent: 91, resetAt: undefined }]), NOW);
    assert.ok(text.includes("verdict: warn=wk"));
  });

  it("hot_rolling 与 hot_fixed 分开报", () => {
    const reset = NOW + 2 * 3600_000;
    const text = formatQuotaCheckText(snap([
      { window: "5h", percent: 98, resetAt: reset },
      { window: "wk", percent: 99, resetAt: undefined },
    ]), NOW);
    assert.ok(text.includes("hot_rolling=5h"));
    assert.ok(text.includes("hot_fixed=wk"));
    assert.ok(text.includes("剩 2h"), "重置倒计时应在场");
  });
});
