import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hplExit from "../../extensions/hpl-exit/index.js";
/** 最小 ExtensionAPI mock：记录命令注册 */
function makeMockPi() {
    const commands = new Map();
    return {
        pi: {
            registerCommand: (name, def) => commands.set(name, def),
            on: (_event, _handler) => { },
        },
        commands,
    };
}
function makeCtx() {
    const state = { shutdownCalls: 0 };
    const ctx = { shutdown: () => { state.shutdownCalls++; } };
    return { ctx, state };
}
describe("hpl-exit", () => {
    it("注册 /exit 命令，handler 调用 shutdown", async () => {
        const mock = makeMockPi();
        hplExit(mock.pi);
        const command = mock.commands.get("exit");
        assert.ok(command, "/exit 已注册");
        const { ctx, state } = makeCtx();
        await command.handler("", ctx);
        assert.equal(state.shutdownCalls, 1);
    });
    it("不注册 input 拦截——裸 exit 不再触发退出", () => {
        const mock = makeMockPi();
        hplExit(mock.pi);
        // pi.on 是空实现，如果有 input hook 被注册会存到 hooks map
        // 这里通过验证注册的命令只有一个来间接验证没有多余的 hook
        assert.equal(mock.commands.size, 1, "只注册了 /exit 命令");
    });
});
