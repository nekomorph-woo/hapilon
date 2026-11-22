import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveHost } from "../../extensions/hpl-orchestra/host.js";
import { coreRunBg, isCoreNotFound, normalizeCoreStatus, parseCoreLaunch, parseCoreServerId, parseCoreTerminal, sendOutcome, isOurAgentApp, } from "../../extensions/hpl-orchestra/core.js";
import { fillOrchestratorSection } from "../../extensions/hpl-orchestra/roles.js";
import { instanceStoreKey, newRoleId, resolveSessionStatePath, teamStateError, } from "../../extensions/hpl-orchestra/state.js";
/** 剥掉本进程可能自带的团队身份变量，测试用干净底座。 */
const IDENTITY_VARS = ["HERDR_ENV", "HERDR_PANE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SERVER_ID"];
const cleanEnv = () => {
    const copy = { ...process.env };
    for (const key of IDENTITY_VARS)
        delete copy[key];
    return copy;
};
const env = (vars) => ({ ...cleanEnv(), ...vars });
describe("resolveHost 宿主判别", () => {
    it("HERDR_ENV=1 + HERDR_PANE_ID → tui", () => {
        const host = resolveHost(env({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HC_TERMINAL_ID: undefined }));
        assert.equal(host.kind, "tui");
        assert.ok(host.kind === "tui" && host.paneId === "w1:p1");
    });
    it("HC_TERMINAL_ID 非空且不在 herdr 面板 → core", () => {
        const host = resolveHost(env({ HERDR_ENV: undefined, HERDR_PANE_ID: undefined, HC_TERMINAL_ID: "t7" }));
        assert.equal(host.kind, "core");
        assert.ok(host.kind === "core" && host.terminalId === "t7");
    });
    it("herdr 面板内出现 HC_TERMINAL_ID → none（歧义）", () => {
        const host = resolveHost(env({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HC_TERMINAL_ID: "t7" }));
        assert.equal(host.kind, "none");
        assert.ok(host.kind === "none" && host.reason.includes("歧义"));
    });
    it("HERDR_ENV=1 但缺 HERDR_PANE_ID → none（残缺身份）", () => {
        const host = resolveHost(env({ HERDR_ENV: "1", HERDR_PANE_ID: undefined, HC_TERMINAL_ID: undefined }));
        assert.equal(host.kind, "none");
    });
    it("两者皆缺 → none", () => {
        const host = resolveHost(env({ HERDR_ENV: undefined, HERDR_PANE_ID: undefined, HC_TERMINAL_ID: undefined }));
        assert.equal(host.kind, "none");
    });
    it("HC_TERMINAL_SOCKET 摘要进命名空间，路径不落文件名", () => {
        const host = resolveHost(env({ HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/Users/x/.local/state/herdr-core/default/default.sock" }));
        assert.ok(host.kind === "core");
        assert.ok(host.kind === "core" && /^s[0-9a-f]{10}$/.test(host.namespace ?? ""));
    });
    it("HC_SERVER_ID 兜底命名空间", () => {
        const host = resolveHost(env({ HC_TERMINAL_ID: "t7", HC_SERVER_ID: "srv-1" }));
        assert.ok(host.kind === "core" && host.namespace === "srv-1");
    });
});
it("Core 新角色直接按选中的英文名启动，重名时用下一个名字", () => {
    const requestedNames = [];
    const result = Effect.runSync(coreRunBg({ cwd: "/tmp", argv: ["hapi", "--team-role", "worker"], names: ["ash", "blake"] }, (_bin, args) => {
        const name = args[args.indexOf("--name") + 1];
        requestedNames.push(name);
        if (name === "ash")
            return { status: 1, stderr: '{"error":{"kind":"name_taken","message":"already named"}}' };
        return { status: 0, stdout: '{"address":"t7","name":"blake"}' };
    }));
    assert.deepEqual(requestedNames, ["ash", "blake"]);
    assert.deepEqual(result, { paneId: "t7", nickname: "blake" });
});
describe("core 传输纯解析", () => {
    it("parseCoreLaunch 认 .address（hc run --bg --json 实测形状）", () => {
        assert.equal(parseCoreLaunch({ address: "t7" }), "t7");
        assert.equal(parseCoreLaunch({ result: { address: "t1b" } }), "t1b");
        assert.equal(parseCoreLaunch({ terminal_id: "t9" }), "t9");
        assert.equal(parseCoreLaunch({}), undefined);
    });
    it("parseCoreTerminal 认 address / status.app / state / reported / created_ms", () => {
        const terminal = parseCoreTerminal({
            address: "t7",
            state: "running",
            status: { app: "hapi", state: "idle" },
            reported: 1700000000000,
            created_ms: 1699999000000,
            label: "阿岚 · worker",
        });
        assert.ok(terminal);
        assert.equal(terminal.terminalId, "t7");
        assert.equal(terminal.app, "hapi");
        assert.equal(terminal.workStatus, "idle");
        assert.equal(terminal.state, "running");
        assert.equal(terminal.reportedMs, 1700000000000);
        assert.equal(terminal.createdMs, 1699999000000);
        // 字符串形态 status 兼容
        const loose = parseCoreTerminal({ address: "t7", status: "working" });
        assert.ok(loose && loose.workStatus === "working" && loose.app === undefined);
        assert.equal(parseCoreTerminal({ nope: 1 }), undefined);
    });
    it("isOurAgentApp 只认 hapi 身份", () => {
        assert.equal(isOurAgentApp("hapi"), true);
        assert.equal(isOurAgentApp("Hapilon"), true);
        assert.equal(isOurAgentApp("claude"), false);
        assert.equal(isOurAgentApp(undefined), false);
    });
    it("normalizeCoreStatus 与 herdr 词表同口径", () => {
        assert.equal(normalizeCoreStatus("working"), "working");
        assert.equal(normalizeCoreStatus("busy"), "working");
        assert.equal(normalizeCoreStatus("exited"), "done");
        assert.equal(normalizeCoreStatus("mystery"), "unknown");
        assert.equal(normalizeCoreStatus(undefined), "unknown");
    });
    it("sendOutcome：退出 0 且 JSON 可解析才算 sent，模糊输出是 failed", () => {
        assert.equal(sendOutcome(0, '{"wait":{"status":"idle"}}', ""), "sent");
        assert.equal(sendOutcome(0, "sent, whatever", ""), "failed");
        const refused = sendOutcome(1, "", "target not idle");
        assert.ok(refused === "refused");
        assert.equal(sendOutcome(1, "", "core exploded"), "failed");
    });
    it("parseCoreServerId 取 .core.id；isCoreNotFound 认 not_found 文本", () => {
        assert.equal(parseCoreServerId({ core: { id: "srv-1" } }), "srv-1");
        assert.equal(isCoreNotFound(new Error('{"error":{"code":"terminal_not_found"}}')), true);
        assert.equal(isCoreNotFound(new Error("boom")), false);
    });
});
describe("core 状态命名空间", () => {
    it("roleId 在场时 store key 与终端地址解耦", () => {
        const roleId = newRoleId();
        assert.equal(instanceStoreKey({ paneId: "t7", roleId }), roleId);
        assert.equal(instanceStoreKey({ paneId: "w1:p1" }), "w1:p1");
    });
    it("core 宿主状态文件带 socket 摘要命名空间前缀", () => {
        const saved = IDENTITY_VARS.map((key) => [key, process.env[key]]);
        try {
            for (const key of IDENTITY_VARS)
                delete process.env[key];
            process.env.HC_TERMINAL_ID = "t7";
            process.env.HC_TERMINAL_SOCKET = "/Users/x/state/a.sock";
            const namespaced = resolveSessionStatePath();
            assert.ok(/^core-s[0-9a-f]{10}-t7\.json$/.test(namespaced.split("/").pop()));
            assert.ok(!namespaced.includes("state")); // socket 原始路径不进文件名
            for (const key of ["HC_TERMINAL_SOCKET", "HC_SERVER_ID"])
                delete process.env[key];
            assert.ok(resolveSessionStatePath().split("/").pop().endsWith("core-t7.json"));
        }
        finally {
            for (const [key, value] of saved) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
    });
    it("host 字段只接受 'core'，非法值让状态整体判废", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapi-team-"));
        const path = join(dir, "state.json");
        const base = {
            enabled: true,
            since: new Date().toISOString(),
            owner: { paneId: "t7" },
            roles: [],
        };
        try {
            writeFileSync(path, JSON.stringify({ ...base, host: "core" }));
            assert.equal(teamStateError(path, []), undefined);
            writeFileSync(path, JSON.stringify({ ...base, host: "herdr" }));
            assert.ok(teamStateError(path, [])?.includes("结构不合法"));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe("宿主专属 prompt 路由", () => {
    const crew = [
        { key: "worker", paneId: "ADDR" },
        { key: "reviewer", paneId: "REV" },
    ];
    it("TUI 段派发走信箱通道（send-mail），不含 hc", () => {
        const text = fillOrchestratorSection(crew, "tui");
        assert.ok(text.includes("send-mail"));
        assert.ok(!text.includes("hc send"));
        assert.ok(!text.includes("team_ctl"));
    });
    it("core 段派发走信箱通道 + hc 等待、不含 herdr 命令", () => {
        const text = fillOrchestratorSection(crew, "core");
        assert.ok(text.includes("send-mail"));
        assert.ok(text.includes("hc wait"));
        assert.ok(text.includes("team_ctl"));
        assert.ok(!text.includes("herdr pane"));
        assert.ok(!text.includes("herdr agent"));
        assert.ok(!text.includes("$HERDR_PANE_ID"));
        // argv 直拉：core 自开面板不经 shell/send 文本投递
        assert.ok(!text.includes("/team:open"));
    });
    it("缺省路由 = TUI（兜底段兼容旧调用）", () => {
        const text = fillOrchestratorSection([]);
        assert.ok(text.includes("herdr pane run"));
    });
});
