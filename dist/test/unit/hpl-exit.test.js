import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hplExit from "../../extensions/hpl-exit/index.js";
/** 最小 ExtensionAPI mock:记录命令与 input hook */
function makeMockPi() {
    const commands = new Map();
    const hooks = new Map();
    return {
        pi: {
            registerCommand: (name, def) => commands.set(name, def),
            on: (event, handler) => {
                hooks.set(event, handler);
            },
        },
        commands,
        inputHandler: (event, ctx) => hooks.get("input")?.(event, ctx),
    };
}
function makeCtx() {
    const state = { shutdownCalls: 0 };
    const ctx = { shutdown: () => {
            state.shutdownCalls++;
        } };
    return { ctx, state };
}
describe("hpl-exit", () => {
    it("注册 /exit 命令,handler 调用 shutdown", async () => {
        const mock = makeMockPi();
        hplExit(mock.pi);
        const command = mock.commands.get("exit");
        assert.ok(command, "/exit 已注册");
        const { ctx, state } = makeCtx();
        await command.handler("", ctx);
        assert.equal(state.shutdownCalls, 1);
    });
    it("裸 exit(交互)→ handled + shutdown", () => {
        const mock = makeMockPi();
        hplExit(mock.pi);
        const { ctx, state } = makeCtx();
        const result = mock.inputHandler?.({ text: "exit", source: "interactive" }, ctx);
        assert.equal(result?.action, "handled");
        assert.equal(state.shutdownCalls, 1);
    });
    it("带空白的 exit 也识别", () => {
        const mock = makeMockPi();
        hplExit(mock.pi);
        const { ctx, state } = makeCtx();
        const result = mock.inputHandler?.({ text: "  exit  ", source: "interactive" }, ctx);
        assert.equal(result?.action, "handled");
        assert.equal(state.shutdownCalls, 1);
    });
    it("非精确输入放行给模型,不 shutdown", () => {
        const mock = makeMockPi();
        hplExit(mock.pi);
        const { ctx, state } = makeCtx();
        for (const text of ["exit vim 怎么办", "exit now", "/exit", "请帮我 exit"]) {
            const result = mock.inputHandler?.({ text, source: "interactive" }, ctx);
            assert.equal(result, undefined, `"${text}" 不拦截`);
        }
        assert.equal(state.shutdownCalls, 0);
    });
    it("非交互来源(rpc/extension)不拦截", () => {
        const mock = makeMockPi();
        hplExit(mock.pi);
        const { ctx, state } = makeCtx();
        for (const source of ["rpc", "extension"]) {
            const result = mock.inputHandler?.({ text: "exit", source }, ctx);
            assert.equal(result, undefined, `${source} 不拦截`);
        }
        assert.equal(state.shutdownCalls, 0);
    });
});
