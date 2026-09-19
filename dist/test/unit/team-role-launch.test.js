import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPaneRunCommand, paneSplitEnvArgs } from "../../extensions/hpl-orchestra/herdr.js";
import { rolePromptPathFor, teamTasksPathFor } from "../../extensions/hpl-orchestra/state.js";
describe("team role 启动链路", () => {
    describe("buildPaneRunCommand()", () => {
        it("role 与 prompt 文件随命令行携带", () => {
            const command = buildPaneRunCommand("reviewer", "sonnet", "/tmp/teams/w1_t0.prompt");
            assert.match(command, /--team-role reviewer/);
            assert.match(command, /--team-role-prompt-file \/tmp\/teams\/w1_t0\.prompt/);
            assert.match(command, /--model sonnet/);
        });
        it("空 role 不产生 flag（orchestrator 自身/未知场景）", () => {
            const command = buildPaneRunCommand("");
            assert.ok(!command.includes("--team-role"));
        });
        it("内置角色无 prompt 文件时不带文件 flag", () => {
            const command = buildPaneRunCommand("worker");
            assert.match(command, /--team-role worker/);
            assert.ok(!command.includes("--team-role-prompt-file"));
        });
        it("任务列表路径随命令行携带（角色 pane 自己的 PI_TASKS）", () => {
            const command = buildPaneRunCommand("worker", undefined, undefined, "/tmp/teams/w1_p8.tasks.json");
            assert.match(command, /--team-tasks \/tmp\/teams\/w1_p8\.tasks\.json/);
        });
        it("无任务列表路径时不带 --team-tasks", () => {
            assert.ok(!buildPaneRunCommand("worker").includes("--team-tasks"));
            // 没有角色就没有任务列表：flag 不许单独出现
            assert.ok(!buildPaneRunCommand("", undefined, undefined, "/tmp/x.tasks.json").includes("--team-tasks"));
        });
    });
    describe("paneSplitEnvArgs()", () => {
        it("只注入 HAPILON_HOME，不注入任何 role 身份变量", () => {
            const previous = process.env.HAPILON_HOME;
            try {
                process.env.HAPILON_HOME = "/tmp/hapilon-dev";
                assert.deepStrictEqual(paneSplitEnvArgs(), ["--env", "HAPILON_HOME=/tmp/hapilon-dev"]);
                const joined = paneSplitEnvArgs().join(" ");
                assert.ok(!joined.includes("HAPI_ORCH"));
            }
            finally {
                if (previous === undefined)
                    delete process.env.HAPILON_HOME;
                else
                    process.env.HAPILON_HOME = previous;
            }
        });
        it("无 HAPILON_HOME 时为空", () => {
            const previous = process.env.HAPILON_HOME;
            try {
                delete process.env.HAPILON_HOME;
                assert.deepStrictEqual(paneSplitEnvArgs(), []);
            }
            finally {
                if (previous !== undefined)
                    process.env.HAPILON_HOME = previous;
            }
        });
    });
    describe("rolePromptPathFor()", () => {
        it("pane id 冒号转下划线，落在 teams 目录", () => {
            const path = rolePromptPathFor("w1:tJ:3");
            assert.match(path, /teams[/\\]w1_tJ_3\.prompt$/);
        });
    });
    describe("teamTasksPathFor()", () => {
        it("与 prompt 同款命名：pane id 冒号转下划线 + .tasks.json", () => {
            const path = teamTasksPathFor("w1:tJ:3");
            assert.match(path, /teams[/\\]w1_tJ_3\.tasks\.json$/);
        });
    });
});
