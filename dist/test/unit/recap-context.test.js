import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRecapMessages } from "../../extensions/hpl-recap/context.js";
describe("hpl-recap 上下文截取", () => {
    it("按 buildContextEntries 的最近条目保留尾部预算", () => {
        const result = buildRecapMessages([
            { type: "message", message: { role: "user", content: "旧消息" } },
            { type: "message", message: { role: "assistant", content: "中间消息" } },
            { type: "message", message: { role: "user", content: "最新消息-保留" } },
        ], 12, 123);
        assert.equal(result.length, 1);
        assert.equal(result[0].timestamp, 123);
        assert.equal(result[0].content.length, 12);
        assert.match(result[0].content, /最新消息-保留$/);
    });
    it("无可总结条目返回空消息，不触发 complete", () => {
        assert.deepEqual(buildRecapMessages([{ type: "model_change" }], 8000), []);
    });
});
