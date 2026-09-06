import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRecapTimer, type TimerHandle } from "../../extensions/hpl-recap/timer.js";

describe("hpl-recap timer", () => {
  it("reset 会取消上一轮并只保留最新回调", () => {
    const scheduled: Array<() => void> = [];
    let cleared = 0;
    let fired = 0;
    const timer = createRecapTimer(
      () => { fired++; },
      (callback) => {
        const handle = () => callback();
        scheduled.push(handle);
        return handle as unknown as TimerHandle;
      },
      () => { cleared++; },
    );

    timer.reset(100);
    timer.reset(200);
    assert.equal(cleared, 1);
    assert.equal(scheduled.length, 2);
    assert.notEqual(scheduled[0], scheduled[1]);
    scheduled[1]!();
    assert.equal(fired, 1);
    timer.clear();
    assert.equal(cleared, 2);
  });
});
