/**
 * version-check.ts 单元测试
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchLatestPiVersion, isNewerPiVersion, } from "../../extensions/hpl-startup-header/version-check.js";
describe("isNewerPiVersion()", () => {
    it("latest > current → true", () => {
        assert.strictEqual(isNewerPiVersion("0.81.0", "0.80.8"), true);
    });
    it("latest === current → false", () => {
        assert.strictEqual(isNewerPiVersion("0.80.8", "0.80.8"), false);
    });
    it("latest < current → false (降级)", () => {
        assert.strictEqual(isNewerPiVersion("0.80.0", "0.80.8"), false);
    });
    it("补丁号升 → true", () => {
        assert.strictEqual(isNewerPiVersion("0.80.9", "0.80.8"), true);
    });
    it("边界: 不同段数 — 1.0 vs 1.0.0", () => {
        assert.strictEqual(isNewerPiVersion("1.0", "1.0.0"), false);
        assert.strictEqual(isNewerPiVersion("1.0.1", "1.0"), true);
    });
    it("边界: 空字符串 → false", () => {
        assert.strictEqual(isNewerPiVersion("", "0.80.8"), false);
        assert.strictEqual(isNewerPiVersion("0.80.8", ""), true);
    });
    it("边界: 非数字组件安全降级", () => {
        assert.strictEqual(isNewerPiVersion("0.80.8-beta1", "0.80.8"), false);
        assert.strictEqual(isNewerPiVersion("0.80.9", "0.80.8-beta1"), true);
    });
});
describe("fetchLatestPiVersion()", () => {
    const makeFake = (ok, version) => {
        return async (_url, _init) => ({
            ok,
            json: async () => (version !== undefined ? { version } : {}),
        });
    };
    it("成功响应 → 返回 version", async () => {
        const result = await fetchLatestPiVersion("0.80.8", makeFake(true, "0.81.0"));
        assert.strictEqual(result, "0.81.0");
    });
    it("非 2xx → undefined", async () => {
        const result = await fetchLatestPiVersion("0.80.8", makeFake(false));
        assert.strictEqual(result, undefined);
    });
    it("body 无 version 字段 → undefined", async () => {
        const result = await fetchLatestPiVersion("0.80.8", makeFake(true));
        assert.strictEqual(result, undefined);
    });
    it("网络异常 → undefined", async () => {
        const throwing = async () => {
            throw new Error("network error");
        };
        const result = await fetchLatestPiVersion("0.80.8", throwing);
        assert.strictEqual(result, undefined);
    });
    it("超时 → undefined", async () => {
        let aborted = false;
        const timeoutFetch = async (_url, init) => {
            // 验证 signal 已设置
            if (init?.signal) {
                init.signal.addEventListener("abort", () => { aborted = true; });
            }
            // 永不 resolve，等待 signal 触发
            throw new DOMException("The operation was aborted", "AbortError");
        };
        const result = await fetchLatestPiVersion("0.80.8", timeoutFetch);
        assert.strictEqual(result, undefined);
    });
    it("PI_OFFLINE → undefined（不发起请求）", async () => {
        const oldOffline = process.env.PI_OFFLINE;
        process.env.PI_OFFLINE = "1";
        let called = false;
        const fake = async () => {
            called = true;
            return { ok: true, json: async () => ({ version: "1.0" }) };
        };
        try {
            const result = await fetchLatestPiVersion("0.80.8", fake);
            assert.strictEqual(result, undefined);
            assert.strictEqual(called, false, "不应发起网络请求");
        }
        finally {
            if (oldOffline === undefined) {
                delete process.env.PI_OFFLINE;
            }
            else {
                process.env.PI_OFFLINE = oldOffline;
            }
        }
    });
});
