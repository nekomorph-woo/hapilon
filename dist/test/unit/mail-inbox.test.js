import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ownMailbox, senderLabel } from "../../extensions/hpl-orchestra/mail-inbox.js";
import { resolveSessionStatePath, teamsDir, writeTeamStateEffect } from "../../extensions/hpl-orchestra/state.js";
const ownerPane = "w9:p1";
const workerPane = "w9:p2";
let home;
const originalEnv = {
    home: process.env.HAPILON_HOME,
    pane: process.env.HERDR_PANE_ID,
    role: process.env.HAPI_ORCH_ROLE,
    herdr: process.env.HERDR_ENV,
};
before(() => {
    for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"])
        delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "hapilon-mail-inbox-test-"));
    process.env.HAPILON_HOME = home;
    process.env.HERDR_ENV = "1";
    delete process.env.HAPI_ORCH_ROLE;
});
after(() => {
    if (originalEnv.home === undefined)
        delete process.env.HAPILON_HOME;
    else
        process.env.HAPILON_HOME = originalEnv.home;
    if (originalEnv.pane === undefined)
        delete process.env.HERDR_PANE_ID;
    else
        process.env.HERDR_PANE_ID = originalEnv.pane;
    if (originalEnv.role === undefined)
        delete process.env.HAPI_ORCH_ROLE;
    else
        process.env.HAPI_ORCH_ROLE = originalEnv.role;
    if (originalEnv.herdr === undefined)
        delete process.env.HERDR_ENV;
    else
        process.env.HERDR_ENV = originalEnv.herdr;
    rmSync(home, { recursive: true, force: true });
});
const originalHome = (saved) => saved;
beforeEach(() => {
    rmSync(teamsDir(), { recursive: true, force: true });
    process.env.HERDR_PANE_ID = ownerPane;
});
const stateFor = () => ({
    enabled: true,
    since: "2026-11-21T10:00:00.000Z",
    owner: { paneId: ownerPane, nickname: "阿岚" },
    roles: [
        { key: "worker", instances: [{ paneId: workerPane, model: null, nickname: "阿澈" }] },
        { key: "reviewer", instances: [{ paneId: "w9:p3", model: null }] },
    ],
});
describe("senderLabel", () => {
    const state = stateFor();
    it("role 昵称优先", () => {
        assert.equal(senderLabel(state, workerPane), "阿澈");
    });
    it("owner 用自己的昵称", () => {
        assert.equal(senderLabel(state, ownerPane), "阿岚");
    });
    it("未知发送方退回 pane id", () => {
        assert.equal(senderLabel(state, "w9:zz"), "w9:zz");
    });
});
describe("ownMailboxForTest", () => {
    it("role pane 定位到自己实例的落盘 key", () => {
        Effect.runSync(writeTeamStateEffect(stateFor(), resolveSessionStatePath()));
        process.env.HERDR_PANE_ID = workerPane;
        const own = ownMailbox();
        assert.equal(own?.paneId, workerPane);
        assert.equal(own?.storeKey, workerPane);
    });
    it("owner pane 用自己的 pane id 当 storeKey", () => {
        Effect.runSync(writeTeamStateEffect(stateFor(), resolveSessionStatePath()));
        process.env.HERDR_PANE_ID = ownerPane;
        const own = ownMailbox();
        assert.equal(own?.storeKey, ownerPane);
    });
    it("不在任何团队返回 undefined", () => {
        process.env.HERDR_PANE_ID = "w9:nowhere";
        assert.equal(ownMailbox(), undefined);
    });
});
