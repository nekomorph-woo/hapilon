// tasks-reconcile 纯函数单测：pi-tasks 存储路径分支、残留计数、提醒文案。
// 生命周期守卫用假 pi.on 挂 handler 手动触发（同 recap-lifecycle 模式）。
import assert from "node:assert/strict";
import { describe, it, after, before } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tasksReconcile from "../../extensions/hpl-tasks-reconcile/index.js";
import { setNotifySink } from "../../extensions/notify.js";
import { buildReminderText, countUnfinishedTasks, pickContextInjection, readUnfinishedTasks, resolveTaskFilePath, } from "../../extensions/hpl-tasks-reconcile/store.js";
describe("resolveTaskFilePath", () => {
    const cwd = "/tmp/work";
    const base = { cwd, sessionId: "s1", piTasks: undefined };
    it("PI_TASKS=off 与 scope=memory 都走内存态，返回 undefined", () => {
        assert.equal(resolveTaskFilePath({ ...base, piTasks: "off" }), undefined);
        assert.equal(resolveTaskFilePath({ ...base, taskScope: "memory" }), undefined);
    });
    it("PI_TASKS 绝对 / 相对 / named 三种写法分别解析", () => {
        assert.equal(resolveTaskFilePath({ ...base, piTasks: "/abs/t.json" }), "/abs/t.json");
        assert.equal(resolveTaskFilePath({ ...base, piTasks: "./rel/t.json" }), join(cwd, "rel/t.json"));
        assert.equal(resolveTaskFilePath({ ...base, piTasks: "mylist" }), "mylist");
    });
    it("project scope 固定到工作区 .pi/tasks/tasks.json", () => {
        assert.equal(resolveTaskFilePath({ ...base, taskScope: "project" }), join(cwd, ".pi", "tasks", "tasks.json"));
    });
    it("session scope 按 sessionId 定位工作区任务文件；缺 sessionId 视为内存态", () => {
        assert.equal(resolveTaskFilePath({ ...base, taskScope: "session" }), join(cwd, ".pi", "tasks", "tasks-s1.json"));
        assert.equal(resolveTaskFilePath({ ...base, taskScope: "session", sessionId: undefined }), undefined);
    });
    it("scope 缺省视同 session", () => {
        assert.equal(resolveTaskFilePath(base), join(cwd, ".pi", "tasks", "tasks-s1.json"));
    });
});
describe("countUnfinishedTasks", () => {
    const dir = mkdtempSync(join(tmpdir(), "hapi-tasks-reconcile-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    function fixture(tasks) {
        const path = join(dir, `tasks-${Math.abs(hash(JSON.stringify(tasks)))}.json`);
        writeFileSync(path, typeof tasks === "string" ? tasks : JSON.stringify({ nextId: 9, tasks }));
        return path;
    }
    function hash(s) {
        let h = 0;
        for (const c of s)
            h = (h * 31 + c.charCodeAt(0)) | 0;
        return h;
    }
    it("pending/in_progress 计残留，completed 不计", () => {
        const n = countUnfinishedTasks(fixture([
            { id: "1", status: "in_progress" },
            { id: "2", status: "pending" },
            { id: "3", status: "pending" },
            { id: "4", status: "completed" },
        ]));
        assert.equal(n, 3);
    });
    it("全部 completed 与空列表返回 0", () => {
        assert.equal(countUnfinishedTasks(fixture([{ id: "1", status: "completed" }])), 0);
        assert.equal(countUnfinishedTasks(fixture([])), 0);
    });
    it("缺 tasks 数组与损坏 JSON 抛错（fail fast，不静默当 0）", () => {
        assert.throws(() => countUnfinishedTasks(fixture({ nextId: 1 })));
        assert.throws(() => countUnfinishedTasks(fixture("{not json")));
    });
});
describe("readUnfinishedTasks", () => {
    const dir = mkdtempSync(join(tmpdir(), "hapi-tasks-reconcile-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    it("过滤 completed，仅保留 id/subject/status", () => {
        const path = join(dir, "tasks-list.json");
        writeFileSync(path, JSON.stringify({
            nextId: 3,
            tasks: [
                { id: "1", subject: "Fix auth", status: "in_progress" },
                { id: "2", subject: "Update docs", status: "pending" },
                { id: "3", subject: "Done thing", status: "completed" },
            ],
        }));
        assert.deepEqual(readUnfinishedTasks(path), [
            { id: "1", subject: "Fix auth", status: "in_progress" },
            { id: "2", subject: "Update docs", status: "pending" },
        ]);
    });
});
describe("pickContextInjection", () => {
    const tasks = [
        { id: "1", subject: "Fix auth", status: "in_progress" },
        { id: "2", subject: "Update docs", status: "pending" },
    ];
    it("空清单不注入", () => {
        assert.equal(pickContextInjection([], false), undefined);
        assert.equal(pickContextInjection([], true), undefined);
    });
    it("常态注入一行计数，含 unfinished 数与分状态计数", () => {
        const text = pickContextInjection(tasks, false);
        assert.match(text, /^<system-reminder>Task list: 2 unfinished \(1 in_progress, 1 pending\)\.<\/system-reminder>$/);
    });
    it("压缩后注入完整清单，含每条 id/status/subject 与权威声明", () => {
        const text = pickContextInjection(tasks, true);
        assert.match(text, /Context was just compacted/);
        assert.match(text, /- #1 \[in_progress\] Fix auth/);
        assert.match(text, /- #2 \[pending\] Update docs/);
    });
});
describe("buildReminderText", () => {
    it("含残留计数、清单全文、TaskUpdate 指引与 system-reminder 包裹，且不开新工", () => {
        const text = buildReminderText([
            { id: "3", subject: "Fix auth", status: "in_progress" },
            { id: "5", subject: "Update docs", status: "pending" },
        ]);
        assert.match(text, /<system-reminder>/);
        assert.match(text, /2 unfinished \(1 in_progress, 1 pending\)/);
        assert.match(text, /- #3 \[in_progress\] Fix auth/);
        assert.match(text, /TaskUpdate/);
        assert.match(text, /Do not start new substantive work/);
    });
});
describe("生命周期守卫（settle 提醒自激循环回归）", () => {
    const dir = mkdtempSync(join(tmpdir(), "hapi-tasks-reconcile-lc-"));
    const taskFile = join(dir, "tasks.json");
    const prevPiTasks = process.env.PI_TASKS;
    const notifications = [];
    const handlers = new Map();
    const ctx = {
        cwd: dir,
        sessionManager: { getSessionId: () => "s1" },
    };
    before(() => {
        writeFileSync(taskFile, JSON.stringify({
            nextId: 2,
            tasks: [{ id: "1", subject: "Wait for benchmark", status: "in_progress" }],
        }));
        process.env.PI_TASKS = taskFile;
        setNotifySink({ notify: (message) => notifications.push(message) });
        tasksReconcile({
            on: ((event, handler) => {
                handlers.set(event, handler);
                return () => handlers.delete(event);
            }),
        });
    });
    after(() => {
        rmSync(dir, { recursive: true, force: true });
        if (prevPiTasks === undefined)
            delete process.env.PI_TASKS;
        else
            process.env.PI_TASKS = prevPiTasks;
    });
    const fire = (event, payload = {}) => Promise.resolve(handlers.get(event)?.(payload, ctx));
    it("首次 settle 注入提醒并请求续跑；续跑轮的 agent_start 不重置守卫，风暴止于一次", async () => {
        await fire("input");
        const first = (await fire("agent_before_settle", { entries: [] }));
        assert.equal(first?.continue, true);
        const reminder = first.entries.at(-1);
        assert.equal(reminder.type, "custom_message");
        assert.equal(reminder.customType, "hapi-tasks-reconcile");
        assert.match(String(reminder.content), /1 unfinished/);
        // 续跑本身就是一次新的低层 run：这里曾把守卫清回 false，形成每分钟数十条的提醒风暴
        await fire("agent_start");
        const second = await fire("agent_before_settle", { entries: [] });
        assert.equal(second, undefined);
        await fire("agent_settled");
        assert.equal(notifications.length, 1);
        assert.match(notifications[0], /仍有 1 项未收尾/);
    });
    it("真实用户输入重新武装：每次输入最多再提醒一次", async () => {
        await fire("input");
        const again = (await fire("agent_before_settle", { entries: [] }));
        assert.equal(again?.continue, true);
        await fire("agent_start");
        const suppressed = await fire("agent_before_settle", { entries: [] });
        assert.equal(suppressed, undefined);
    });
    it("无残留时不注入不续跑，settled 也不通知", async () => {
        writeFileSync(taskFile, JSON.stringify({ nextId: 2, tasks: [{ id: "1", subject: "Done", status: "completed" }] }));
        await fire("input");
        const result = await fire("agent_before_settle", { entries: [] });
        assert.equal(result, undefined);
        const before = notifications.length;
        await fire("agent_settled");
        assert.equal(notifications.length, before);
    });
});
