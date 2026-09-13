import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hapilonHomes, listSessionFiles, loadSamples, parseSession, resolvePonytailDefault, } from "../../extensions/hpl-metrics/sessions.js";
import { groupSamples, median, renderPonytailLines } from "../../extensions/hpl-metrics/ponytail.js";
import { parseMetricsArgs, usageText } from "../../extensions/hpl-metrics/index.js";
/** 造一个会话文件：两条 assistant 消息、一次 ponytail 切档 */
function sessionLines(options) {
    const lines = [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: options.timestamp, cwd: options.cwd }),
    ];
    for (const mode of options.modes ?? []) {
        lines.push(JSON.stringify({ type: "custom", customType: "ponytail-mode", data: { mode } }));
    }
    lines.push(JSON.stringify({
        type: "message",
        timestamp: options.timestamp,
        message: {
            role: "assistant",
            model: options.model,
            usage: { output: options.outputTokens, input: 1000, cost: { total: 0.01 } },
            content: [
                { type: "text", text: "解释一下" },
                { type: "thinking", thinking: "这段不该计入正文" },
                { type: "toolCall", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "x", newText: "0123456789" }] } },
                { type: "toolCall", name: "write", arguments: { path: "b.ts", content: "新建文件内容" } },
                { type: "toolCall", name: "bash", arguments: { command: "ls" } },
                { type: "toolCall", name: "Agent", arguments: { prompt: "research" } },
            ],
        },
    }));
    return lines;
}
let base;
let home;
before(() => {
    base = mkdtempSync(join(tmpdir(), "hapi-metrics-"));
    // 两个 home，其中一个缺少 agent/sessions（应被过滤掉）
    home = join(base, ".hapilon-dev");
    mkdirSync(join(home, "agent", "sessions", "--projA--"), { recursive: true });
    mkdirSync(join(base, ".hapilon"), { recursive: true });
    mkdirSync(join(base, "not-a-home"), { recursive: true });
});
after(() => rmSync(base, { recursive: true, force: true }));
describe("parseMetricsArgs（不带子命令只出用法，不执行分析）", () => {
    it("空参数 / help → usage", () => {
        assert.equal(parseMetricsArgs("").kind, "usage");
        assert.equal(parseMetricsArgs("--help").kind, "usage");
        assert.equal(parseMetricsArgs("help").kind, "usage");
    });
    it("未知子命令 → usage 并带原因", () => {
        const parsed = parseMetricsArgs("cost");
        assert.equal(parsed.kind, "usage");
        assert.match(parsed.kind === "usage" ? parsed.reason ?? "" : "", /未知子命令/);
    });
    it("ponytail 及全部选项", () => {
        const parsed = parseMetricsArgs("ponytail --group-by model --since 2026-09-01 --project hapilon --json");
        assert.equal(parsed.kind, "ponytail");
        if (parsed.kind !== "ponytail")
            return;
        assert.equal(parsed.groupBy, "model");
        assert.equal(parsed.project, "hapilon");
        assert.equal(parsed.json, true);
        assert.equal(new Date(parsed.sinceMs).toISOString().slice(0, 10), "2026-09-01");
    });
    it("默认分组是 ponytail；非法分组/时间 → usage", () => {
        const parsed = parseMetricsArgs("ponytail");
        assert.equal(parsed.kind === "ponytail" ? parsed.groupBy : "", "ponytail");
        assert.equal(parseMetricsArgs("ponytail --group-by 天气").kind, "usage");
        assert.equal(parseMetricsArgs("ponytail --since 不是日期").kind, "usage");
    });
    it("用法文本列出子命令且说明不执行统计", () => {
        const text = usageText();
        assert.match(text, /ponytail/);
        assert.match(text, /不执行任何统计/);
    });
});
describe("会话解析与聚合", () => {
    it("parseSession：token/成本/正文与代码载荷/工具计数/档位", () => {
        const file = join(home, "agent", "sessions", "--projA--", "s1.jsonl");
        writeFileSync(file, sessionLines({ cwd: "/w/projA", timestamp: "2026-09-10T00:00:00Z", model: "glm-5.3", outputTokens: 500, modes: ["lite"] }).join("\n"));
        const sample = parseSession(file, home, { mode: "full", source: "assumed" });
        assert.ok(sample);
        assert.equal(sample.project, "/w/projA");
        assert.equal(sample.outputTokens, 500);
        assert.equal(sample.costUsd, 0.01);
        assert.equal(sample.models.join(), "glm-5.3");
        assert.equal(sample.proseChars, "解释一下".length, "thinking 不计入正文");
        assert.equal(sample.codeChars, 10 + "新建文件内容".length);
        assert.equal(sample.editCalls, 1);
        assert.equal(sample.writeCalls, 1);
        assert.equal(sample.filesTouched, 2);
        assert.equal(sample.bashCalls, 1);
        assert.equal(sample.subagentCalls, 1);
        assert.equal(sample.ponytail, "lite");
        assert.equal(sample.ponytailSource, "session");
    });
    it("会话内多条不同档位 → mixed；没有记录 → 默认推测", () => {
        const mixed = join(home, "agent", "sessions", "--projA--", "s2.jsonl");
        writeFileSync(mixed, sessionLines({ cwd: "/w/projA", timestamp: "2026-09-11T00:00:00Z", model: "glm-5.3", outputTokens: 100, modes: ["lite", "ultra"] }).join("\n"));
        assert.equal(parseSession(mixed, home, { mode: "full", source: "assumed" })?.ponytail, "mixed");
        const plain = join(home, "agent", "sessions", "--projA--", "s3.jsonl");
        writeFileSync(plain, sessionLines({ cwd: "/w/projA", timestamp: "2026-09-12T00:00:00Z", model: "deepseek-v4-flash", outputTokens: 900 }).join("\n"));
        const sample = parseSession(plain, home, { mode: "full", source: "assumed" });
        assert.equal(sample?.ponytail, "full");
        assert.equal(sample?.ponytailSource, "assumed");
    });
    it("分组：档位/模型/天/项目；assumed 带 ? 标记", () => {
        const samples = loadSamples({ homeDir: base, ponytailDefault: { mode: "full", source: "assumed" } });
        assert.equal(samples.length, 3);
        const byPonytail = groupSamples(samples, "ponytail");
        const keys = byPonytail.map((group) => group.key).sort();
        assert.deepEqual(keys, ["full?", "lite", "mixed"]);
        const lite = byPonytail.find((group) => group.key === "lite");
        assert.equal(lite.sessions, 1);
        assert.equal(lite.outputMedian, 500);
        const byDay = groupSamples(samples, "day");
        assert.equal(byDay.length, 3);
        assert.deepEqual(byDay.map((group) => group.key).sort(), ["2026-09-10", "2026-09-11", "2026-09-12"]);
        const byModel = groupSamples(samples, "model");
        assert.equal(byModel.find((group) => group.key === "glm-5.3").sessions, 2);
        const byProject = groupSamples(samples, "project");
        assert.deepEqual(byProject.map((group) => group.key), ["projA"]);
    });
    it("since / project 过滤", () => {
        assert.equal(loadSamples({ homeDir: base, sinceMs: Date.parse("2026-09-11T00:00:00Z") }).length, 2);
        assert.equal(loadSamples({ homeDir: base, project: "projA" }).length, 3);
        assert.equal(loadSamples({ homeDir: base, project: "没有这个项目" }).length, 0);
    });
    it("hapilonHomes 只认含 agent/sessions 的 .hapilon* 目录", () => {
        const homes = hapilonHomes(base).map((path) => path.replace(base, ""));
        assert.deepEqual(homes.sort(), ["/.hapilon-dev"]);
    });
    it("listSessionFiles 枚举 jsonl", () => {
        assert.equal(listSessionFiles(home).length, 3);
    });
    it("resolvePonytailDefault：env 优先，否则落到 full", () => {
        assert.equal(resolvePonytailDefault({ PONYTAIL_DEFAULT_MODE: "ultra" }, base).mode, "ultra");
        assert.equal(resolvePonytailDefault({ PONYTAIL_DEFAULT_MODE: "乱填" }, base).mode, "full");
        assert.equal(resolvePonytailDefault({}, base).source, "assumed");
    });
    it("median：奇数/偶数/空", () => {
        assert.equal(median([3, 1, 2]), 2);
        assert.equal(median([4, 1]), 3);
        assert.equal(median([]), 0);
    });
    it("渲染：表头 + 每会话均值列 + 无代码时比值显示 — + 表尾警告", () => {
        const samples = loadSamples({ homeDir: base, ponytailDefault: { mode: "full", source: "assumed" } });
        const groups = groupSamples(samples, "ponytail");
        const lines = renderPonytailLines(groups, {
            homes: [home], groupBy: "ponytail", samples: samples.length, ponytailFromSession: 2,
        });
        const text = lines.join("\n");
        assert.match(text, /分组/);
        assert.match(text, /out中位/);
        assert.match(text, /文本\/代码/);
        assert.match(text, /体量指标只说明/);
        assert.match(text, /2\/3 个会话取自会话内记录/);
        const empty = renderPonytailLines([], { homes: [], groupBy: "ponytail", samples: 0, ponytailFromSession: 0 });
        assert.match(empty.join("\n"), /没有符合条件的会话/);
    });
});
