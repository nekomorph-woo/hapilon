import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heatmap, hourlyHistogram, idleSkills, listAvailableSkills, localDateKey, originBreakdown, perSkill, tailShape, weeklyBuckets, } from "../../extensions/hpl-metrics/skills/stats.js";
import { appendGoal, readExcludedSkills, readGoals } from "../../extensions/hpl-metrics/skills/storage.js";
// 2026-09-30 是周三；10:00 与 22:00 本地时间
const T = (day, hour) => new Date(2026, 8, day, hour, 0, 0).getTime();
const event = (over) => ({
    ts: T(30, 10),
    skill: "ask",
    source: "explicit",
    args: "",
    session: "s1",
    project: "/work/demo",
    origin: "builtin",
    sessionPreview: "",
    ...over,
});
describe("时段聚合", () => {
    it("hourlyHistogram 落本地小时", () => {
        const hours = hourlyHistogram([event({}), event({ ts: T(30, 10) }), event({ ts: T(29, 22) })]);
        assert.equal(hours[10], 2);
        assert.equal(hours[22], 1);
        assert.equal(hours.reduce((a, b) => a + b), 3);
    });
    it("heatmap 按天升序、每天 24 格", () => {
        const days = heatmap([event({ ts: T(29, 9) }), event({ ts: T(30, 10) }), event({ ts: T(30, 10) })]);
        assert.deepEqual(days.map((day) => day.day), [localDateKey(T(29, 9)), localDateKey(T(30, 10))]);
        assert.equal(days[1].hours[10], 2);
        assert.equal(days[0].hours[9], 1);
    });
    it("weeklyBuckets 周一为界", () => {
        // 2026-09-28 周一；09-30 周三同桶，09-27 周日上一桶
        const weeks = weeklyBuckets([event({ ts: T(30, 10) }), event({ ts: T(28, 8) }), event({ ts: T(27, 8) })]);
        assert.deepEqual(weeks, [
            { weekStart: localDateKey(T(21, 8)), count: 1 },
            { weekStart: localDateKey(T(28, 8)), count: 2 },
        ]);
    });
});
describe("perSkill", () => {
    it("显式/自动分列、revisit 中位、tails 升序、purpose 注入", () => {
        const stats = perSkill([
            event({ ts: T(1, 9), args: "第一个问题" }),
            event({ ts: T(15, 9), args: "第二个问题" }),
            event({ ts: T(15, 9), source: "model" }),
            event({ ts: T(20, 9), skill: "snap", origin: "user", source: "model" }),
        ], { ask: "答疑专用" });
        assert.deepEqual(stats.map((stat) => stat.skill), ["ask", "snap"]);
        const ask = stats[0];
        assert.equal(ask.explicit, 2);
        assert.equal(ask.model, 1);
        assert.equal(ask.total, 3);
        assert.equal(ask.revisitMedianDays, 7, "gaps=[14d, 0d] 的中位");
        assert.deepEqual(ask.tails, ["第一个问题", "第二个问题"]);
        assert.equal(ask.purpose, "答疑专用");
        assert.equal(stats[1].revisitMedianDays, null);
    });
    it("tailShape：路径比例与重复前缀", () => {
        const shape = tailShape(["/var/folders/a.png", "/var/folders/b.png", "为什么 fold"]);
        assert.equal(shape.count, 3);
        assert.equal(shape.pathishRatio, 0.67);
        assert.equal(shape.topPrefix, "/var/folders");
        assert.equal(shape.topPrefixCount, 2);
        assert.equal(tailShape([]).count, 0);
    });
});
describe("来源与闲置", () => {
    it("originBreakdown 计数", () => {
        assert.deepEqual(originBreakdown([event({}), event({ origin: "user" }), event({ origin: "user" }), event({ origin: "project" })]), { builtin: 1, user: 2, project: 1 });
    });
    it("listAvailableSkills 收三个目录；idleSkills 做差集", () => {
        const home = mkdtempSync(join(tmpdir(), "hpl-metrics-stats-"));
        try {
            const savedCli = process.env.HAPILON_CLI_PATH;
            const savedCwd = process.cwd();
            try {
                delete process.env.HAPILON_CLI_PATH;
                mkdirSync(join(home, "agent", "skills", "dom"), { recursive: true });
                process.chdir(home);
                mkdirSync(join(home, ".pi", "skills", "local"), { recursive: true });
                assert.deepEqual(listAvailableSkills(home).map((skill) => skill.name).sort(), ["dom", "local"]);
                assert.deepEqual(idleSkills([{ name: "ask", description: "" }, { name: "dom", description: "" }, { name: "local", description: "" }], new Set(["dom"])).map((skill) => skill.name), ["ask", "local"]);
            }
            finally {
                if (savedCli !== undefined)
                    process.env.HAPILON_CLI_PATH = savedCli;
                process.chdir(savedCwd);
            }
        }
        finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
describe("storage", () => {
    it("分析目标追加去重；排除名单默认为空，可追加", () => {
        const home = mkdtempSync(join(tmpdir(), "hpl-metrics-storage-"));
        const saved = process.env.HAPILON_HOME;
        process.env.HAPILON_HOME = home;
        try {
            assert.equal(appendGoal("  深夜我在用 skill 干什么 "), true);
            assert.equal(appendGoal("深夜我在用 skill 干什么"), false, "重复目标不入库");
            assert.deepEqual(readGoals(), ["深夜我在用 skill 干什么"]);
            const excluded = readExcludedSkills();
            assert.equal(excluded.size, 0, "recap 已移出内置名单");
            writeFileSync(join(home, "agent", "skill-metrics", "excluded-skills.json"), JSON.stringify(["simplify"]));
            assert.ok(readExcludedSkills().has("simplify"));
        }
        finally {
            if (saved === undefined)
                delete process.env.HAPILON_HOME;
            else
                process.env.HAPILON_HOME = saved;
            rmSync(home, { recursive: true, force: true });
        }
    });
});
