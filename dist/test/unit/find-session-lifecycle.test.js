/**
 * hpl-find-session 生命周期测试（index 层，真实 RpcClient 子进程）。
 *
 * 真实 pi CLI 对未知模型容忍常驻（"Using custom model id"），因此这里用真
 * 子进程验证打开/overlay 关闭/再次打开/session_shutdown 的资源释放与 stderr
 * 截留还原。恢复顺序、启动失败、迟到事件、退出报错属 FindSessionRpc 单元语义，
 * 由 find-session-rpc-session.test.ts 以 FakeClient 覆盖。
 */
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hplFindSession from "../../extensions/hpl-find-session/index.js";
let tempHome = "";
const notifications = [];
const overlay = {};
const commands = new Map();
const shutdownHandlers = [];
const mockPi = {
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
        if (event === "session_shutdown")
            shutdownHandlers.push(handler);
        return () => { };
    },
};
function makeCtx(mode = "tui") {
    return {
        mode,
        ui: {
            notify: (message, type) => notifications.push({ message, type }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            custom: async (factory, options) => {
                overlay.factory = factory;
                overlay.options = options;
                await new Promise((resolve) => { overlay.done = () => { resolve(); }; });
            },
        },
        waitForIdle: async () => { },
        switchSession: async () => ({ cancelled: false }),
    };
}
/** 轮询直到条件成立或超时；避免对子进程启动时序做硬编码 sleep 断言 */
async function until(what, check, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline)
            assert.fail(`超时：${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
const stubTui = { terminal: { rows: 40 } };
const stubTheme = { fg: (_c, t) => t };
/** 构造真实 pane 并关闭浮层（等价 pane 的 done 路径） */
function openAndCloseOverlay() {
    assert.ok(overlay.factory, "浮层工厂未就绪");
    assert.ok(overlay.done, "浮层完成回调未挂");
    overlay.factory(stubTui, stubTheme, {}, overlay.done);
    overlay.done();
}
before(() => {
    tempHome = mkdtempSync(join(tmpdir(), "hapilon-find-session-"));
    mkdirSync(join(tempHome, "agent", "sessions"), { recursive: true });
    // haiku 档不给 thinking：index 级真子进程不走 setThinkingLevel 请求（桩无法应答协议）；
    // provider/id 用实测过的组合：已知 provider + 未知模型 id → pi 容忍常驻（custom model id）
    writeFileSync(join(tempHome, "model-tiers-resolved.json"), JSON.stringify({ haiku: [{ provider: "anthropic", id: "bogus-model-xyz" }] }));
    process.env.HAPILON_HOME = tempHome;
    hplFindSession(mockPi);
});
after(() => {
    delete process.env.HAPILON_HOME;
    rmSync(tempHome, { recursive: true, force: true });
});
it("注册 /find-session 与 session_shutdown 兜底", () => {
    assert.ok(commands.get("find-session"));
    assert.equal(shutdownHandlers.length, 1);
});
it("非 TUI 环境只提示，不启动子进程", async () => {
    const command = commands.get("find-session");
    assert.ok(command);
    await command.handler("", makeCtx("print"));
    assert.ok(notifications.some((n) => n.message.includes("TUI")));
    assert.equal(overlay.factory, undefined);
});
it("空档位只提示，不启动子进程", async () => {
    const previousHome = process.env.HAPILON_HOME;
    const emptyHome = mkdtempSync(join(tmpdir(), "hapilon-find-session-empty-"));
    process.env.HAPILON_HOME = emptyHome;
    try {
        const command = commands.get("find-session");
        assert.ok(command);
        await command.handler("", makeCtx());
        assert.ok(notifications.some((n) => n.message.includes("haiku 档没有可用模型")));
        assert.equal(overlay.factory, undefined);
    }
    finally {
        process.env.HAPILON_HOME = previousHome;
        rmSync(emptyHome, { recursive: true, force: true });
    }
});
it("打开后父 stderr 不被替换；overlay 完成统一释放；之后可再次打开", async () => {
    const command = commands.get("find-session");
    assert.ok(command);
    const originalWrite = process.stderr.write;
    const handlerPromise = command.handler("", makeCtx());
    await until("浮层工厂就绪", () => overlay.factory !== undefined);
    assert.equal(overlay.options?.overlay, true);
    assert.equal(process.stderr.write, originalWrite, "运行期间父 stderr 未被替换");
    // 完成浮层：真实 pane 由工厂构造（构造即校验接线），done 关闭并触发统一释放
    openAndCloseOverlay();
    await handlerPromise;
    assert.equal(process.stderr.write, originalWrite, "释放后父 stderr 未被替换");
    notifications.length = 0;
    // 再次打开：active 已清空，重复打开守卫不再拦截
    const secondHandler = command.handler("", makeCtx());
    const firstFactory = overlay.factory;
    await until("第二次浮层就绪", () => overlay.factory !== undefined && overlay.factory !== firstFactory);
    openAndCloseOverlay();
    await secondHandler;
    assert.equal(process.stderr.write, originalWrite, "第二次释放后父 stderr 未被替换");
    assert.ok(notifications.every((n) => !n.message.includes("已打开")), "重复打开守卫已随释放解除");
});
it("session_shutdown 释放面板实例，之后允许再次打开", async () => {
    const command = commands.get("find-session");
    assert.ok(command);
    const originalWrite = process.stderr.write;
    const shutdown = shutdownHandlers[0];
    assert.ok(shutdown);
    const handlerPromise = command.handler("", makeCtx());
    await until("浮层工厂就绪", () => overlay.factory !== undefined);
    shutdown({ type: "session_shutdown", reason: "quit" }, makeCtx());
    openAndCloseOverlay();
    await handlerPromise;
    await until("stderr 已还原", () => process.stderr.write === originalWrite);
    // shutdown 清了 active：可以再开
    const reopen = command.handler("", makeCtx());
    const firstFactory = overlay.factory;
    await until("shutdown 后可再次打开", () => overlay.factory !== undefined && overlay.factory !== firstFactory);
    openAndCloseOverlay();
    await reopen;
    assert.equal(process.stderr.write, originalWrite, "shutdown 释放后父 stderr 未被替换");
});
