import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMessageTime, messageTimeLine } from "../../extensions/hpl-message-time/index.js";
const theme = { fg: (slot, text) => `\x1b[${slot}]${text}\x1b[0m` };
test("formatMessageTime：本地时间 MM-DD HH:mm:ss，个位补零", () => {
    const ts = new Date(2026, 10, 5, 7, 8, 9).getTime();
    assert.equal(formatMessageTime(ts), "11-05 07:08:09");
});
test("messageTimeLine：按消息缩进对齐并补满整行", () => {
    const ts = new Date(2026, 10, 5, 7, 8, 9).getTime();
    const line = messageTimeLine({ timestamp: ts, outputPad: 2 }, 30, theme);
    assert.equal(line, theme.fg("dim", "  11-05 07:08:09".padEnd(30)));
});
test("messageTimeLine：组件无 timestamp 时回落消息对象上的", () => {
    const line = messageTimeLine({ outputPad: 1, lastMessage: { timestamp: new Date(2026, 0, 2, 3, 4, 5).toISOString() } }, 20, theme);
    assert.ok(line?.includes("01-02 03:04:05"));
});
test("messageTimeLine：没有时间就不出行", () => {
    assert.equal(messageTimeLine({ outputPad: 1 }, 20, theme), undefined);
    assert.equal(messageTimeLine({ outputPad: 1, lastMessage: {} }, 20, theme), undefined);
});
