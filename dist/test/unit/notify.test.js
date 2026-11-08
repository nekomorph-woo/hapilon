import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { notify, resetNotifySink, setNotifySink } from "../../extensions/notify.js";
describe("notify() 无 sink 时的回落分流", () => {
    const warns = [];
    afterEach(() => {
        warns.length = 0;
        resetNotifySink();
    });
    it("info 丢弃，不碰 stderr", () => {
        const original = console.warn;
        console.warn = (message) => warns.push(message);
        try {
            notify("信息性汇总", "info");
            notify("默认参数也是 info");
        }
        finally {
            console.warn = original;
        }
        assert.deepEqual(warns, []);
    });
    it("warning/error 走 console.warn 留痕", () => {
        const original = console.warn;
        console.warn = (message) => warns.push(message);
        try {
            notify("配置不是合法 JSON", "warning");
            notify("读取失败", "error");
        }
        finally {
            console.warn = original;
        }
        assert.deepEqual(warns, ["配置不是合法 JSON", "读取失败"]);
    });
    it("sink 在场时全部走 sink，不分流", () => {
        const seen = [];
        setNotifySink({ notify: (message, type) => seen.push({ message, type }) });
        notify("信息", "info");
        notify("警告", "warning");
        assert.deepEqual(seen, [
            { message: "信息", type: "info" },
            { message: "警告", type: "warning" },
        ]);
    });
});
