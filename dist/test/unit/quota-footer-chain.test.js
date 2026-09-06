/**
 * quota snapshot → 缓存文件通道 → footer 限额段 的链路测试
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSnapshot as parseGlmSnapshot } from "../../extensions/hpl-quota-usage/providers/glm.js";
import { parseSnapshot as parseCodexSnapshot } from "../../extensions/hpl-quota-usage/providers/codex.js";
import { parseSnapshot as parseDeepSeekSnapshot } from "../../extensions/hpl-quota-usage/providers/deepseek.js";
import { readQuotaSnapshot, writeQuotaSnapshot } from "../../extensions/hpl-quota-usage/cache.js";
import { buildQuotaSegment } from "../../extensions/hpl-footer/format.js";
import { snapshotHot } from "../../extensions/hpl-quota-usage/snapshot.js";
describe("quota 链路：snapshot → cache → footer", () => {
    let tmpBase;
    let originalCache;
    beforeEach(() => {
        tmpBase = mkdtempSync(join(tmpdir(), "hapilon-quota-chain-"));
        originalCache = process.env["HAPILON_QUOTA_CACHE"];
        process.env["HAPILON_QUOTA_CACHE"] = join(tmpBase, "cache.json");
    });
    afterEach(() => {
        if (originalCache !== undefined)
            process.env["HAPILON_QUOTA_CACHE"] = originalCache;
        else
            delete process.env["HAPILON_QUOTA_CACHE"];
        rmSync(tmpBase, { recursive: true, force: true });
    });
    it("glm snapshot 写缓存后 footer 拼出模板 A 段", () => {
        const now = Date.now();
        const payload = {
            code: 200,
            msg: "操作成功",
            data: {
                limits: [
                    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 18, nextResetTime: now + 2.2 * 3600 * 1000 },
                    { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 76, nextResetTime: now + 9.3 * 86400 * 1000 },
                ],
            },
        };
        const snapshot = parseGlmSnapshot(payload, now);
        assert.deepEqual(snapshot.windows.map((w) => w.window), ["5h", "wk"]);
        writeQuotaSnapshot(snapshot);
        const loaded = readQuotaSnapshot(now);
        assert.equal(loaded.provider, "glm");
        const segment = buildQuotaSegment(loaded.windows.map((w) => ({ percent: w.percent, window: w.window, resetAt: w.resetAt })), loaded.balanceCny, now);
        assert.match(segment, /^18%\/5h~2h12m 76%\/wk~9d$/);
        assert.equal(snapshotHot(loaded), false);
    });
    it("codex snapshot 映射 5h/wk 双窗口，reset_at 秒转毫秒", () => {
        const now = Date.now();
        const snapshot = parseCodexSnapshot({
            plan_type: "plus",
            rate_limit: {
                primary_window: { used_percent: 2, limit_window_seconds: 18000, reset_at: Math.floor(now / 1000) + 2700 },
                secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: Math.floor(now / 1000) + 6 * 86400 },
            },
        }, now);
        assert.deepEqual(snapshot.windows.map((w) => w.window), ["5h", "wk"]);
        assert.ok(snapshot.windows[0].resetAt > now, "reset_at 已转毫秒");
        const segment = buildQuotaSegment(snapshot.windows, snapshot.balanceCny, now);
        assert.match(segment, /^2%\/5h~4[45]m 5%\/wk~[56]d$/);
    });
    it("deepseek snapshot 走余额模板，footer 显示 ¥", () => {
        const now = Date.now();
        const snapshot = parseDeepSeekSnapshot({
            is_available: true,
            balance_infos: [{ currency: "CNY", total_balance: "327.48" }, { currency: "USD", total_balance: "0.00" }],
        }, now);
        assert.equal(snapshot.balanceCny, "327");
        assert.equal(snapshot.windows.length, 0);
        const segment = buildQuotaSegment(snapshot.windows, snapshot.balanceCny, now);
        assert.equal(segment, "¥327");
    });
    it("≥90% 窗口触发 hot，footer 分段上色由 index 据此切 warning", () => {
        const now = Date.now();
        const snapshot = {
            provider: "glm",
            windows: [{ window: "5h", percent: 92, resetAt: now + 3600_000 }],
            timestamp: now,
        };
        assert.equal(snapshotHot(snapshot), true);
    });
    it("过期缓存（>15min）读取返回 undefined，footer 静默无段", () => {
        const stale = {
            provider: "glm",
            windows: [{ window: "5h", percent: 18, resetAt: Date.now() + 1000 }],
            timestamp: Date.now() - 16 * 60 * 1000,
        };
        writeQuotaSnapshot(stale);
        assert.equal(readQuotaSnapshot(), undefined);
    });
    it("缓存文件损坏读取返回 undefined 不抛异常", () => {
        writeFileSync(process.env["HAPILON_QUOTA_CACHE"], "{broken json", "utf8");
        assert.equal(readQuotaSnapshot(), undefined);
    });
});
