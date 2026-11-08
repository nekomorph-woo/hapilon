// tasks-reconcile 纯函数单测：pi-tasks 存储路径分支、残留计数、提醒文案。
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReminderText, countUnfinishedTasks, resolveTaskFilePath } from "../../extensions/hpl-tasks-reconcile/store.js";

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

  function fixture(tasks: unknown): string {
    const path = join(dir, `tasks-${Math.abs(hash(JSON.stringify(tasks)))}.json`);
    writeFileSync(path, typeof tasks === "string" ? tasks : JSON.stringify({ nextId: 9, tasks }));
    return path;
  }

  function hash(s: string): number {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
    return h;
  }

  it("pending/in_progress 计残留，completed 不计", () => {
    const n = countUnfinishedTasks(
      fixture([
        { id: "1", status: "in_progress" },
        { id: "2", status: "pending" },
        { id: "3", status: "pending" },
        { id: "4", status: "completed" },
      ]),
    );
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

describe("buildReminderText", () => {
  it("含残留数、TaskUpdate 指引与 system-reminder 包裹，且不开新工", () => {
    const text = buildReminderText(3);
    assert.match(text, /<system-reminder>/);
    assert.match(text, /\b3 unfinished task/);
    assert.match(text, /TaskUpdate/);
    assert.match(text, /Do not start new substantive work/);
  });
});
