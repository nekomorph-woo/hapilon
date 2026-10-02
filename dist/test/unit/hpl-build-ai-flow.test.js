/**
 * hpl-build-ai-flow 单测 — 照 hpl-simplify-command.test.ts 的 mock 模式。
 *
 * 覆盖：stages 表完整性、Gate 机械评估各分支、状态机迁移与守卫、
 * prompt 拼装、status 渲染、补全分派、decision-audit 三分支、guard 分支、命令 handler。
 */
import { before, after, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { LAST_STAGE, STAGES } from "../../extensions/hpl-build-ai-flow/stages.js";
import { advanceFlowEffect, evaluateGate, flowDir, forceAdvanceEffect, freezeFlowEffect, gotoStageEffect, KNOWN_CAPABILITIES, loadFlowEffect, openDebts, readActiveEffect, resolveDebtEffect, savePendingGoal, setCapabilityEffect, startFlowEffect, statePath, takePendingGoal, uniqueSlug, writeFileAtomic, } from "../../extensions/hpl-build-ai-flow/machine.js";
import { parseDecisionLog } from "../../extensions/hpl-build-ai-flow/decision-log.js";
import { buildFreezeNote, buildStagePrompt, stageMark } from "../../extensions/hpl-build-ai-flow/prompts.js";
import { capabilityBlock, capabilityStatusLine } from "../../extensions/hpl-build-ai-flow/capabilities.js";
import { nextStepAdvice, renderStatus } from "../../extensions/hpl-build-ai-flow/render.js";
import { buildCompletions } from "../../extensions/hpl-build-ai-flow/completions.js";
import { auditDecisionLog, parseAuditOutput, resolveAuditModel } from "../../extensions/hpl-build-ai-flow/decision-audit.js";
import hplBuildAiFlow from "../../extensions/hpl-build-ai-flow/index.js";
import { resetGuardState } from "../../extensions/hpl-build-ai-flow/guard.js";
function runOk(effect) {
    const r = Effect.runSync(Effect.either(effect));
    if (r._tag === "Left")
        throw new Error(`意外失败：${JSON.stringify(r.left)}`);
    return r.right;
}
function runErr(effect) {
    const r = Effect.runSync(Effect.either(effect));
    if (r._tag === "Right")
        throw new Error("预期失败但成功了");
    return r.left;
}
let cwd;
function freshCwd() {
    cwd = mkdtempSync(join(tmpdir(), "hpl-aiflow-"));
}
function writeArtifact(slug, name, content) {
    writeFileSync(join(flowDir(cwd, slug), name), content, "utf-8");
}
/** 各产物的标记合规内容（过 GATE_MARKERS 结构检查）+ 长度门槛 */
const MARKER_CONTENT = {
    "discovery.md": "## 已确认事实\n三条事实。\n## 数据源与可信度\n记录来源。\n## 无法确认项\n两项待确认。内容足够长过机械 Gate 的长度门槛。",
    "design.md": "主阅读顺序：先风险后趋势；层级两档；空数据与异常状态的展示约定在此。内容足够长过门槛。",
    "visual-direction.md": "候选：A（密）与 B（疏），各一段描述与小样路径；拍板：选 A，理由是与判断密度匹配。内容足够长。",
    "prototype.md": "一肥（最复杂案例）与一瘦（最空案例）的验证结论与文件路径，缺口表现记录在内。内容足够长。",
    "self-review.md": "六轴自评：诚实性 Concern（执行状态是代理指标但主标签写已执行）、可达性 Not verified（未做移动端检查）、其余 Pass；问题清单按严重度排序，已修与遗留分开。内容足够长。",
    "scale.md": "扩全量执行记录；保留一肥一瘦两样例的回归检查结果。内容足够长过机械 Gate 的长度门槛。",
};
function writeFilledStageArtifacts(slug, upTo) {
    for (const def of STAGES.slice(0, upTo + 1)) {
        for (const a of def.artifacts) {
            if (existsSync(join(flowDir(cwd, slug), a)))
                continue;
            let content = MARKER_CONTENT[a] ?? `${a} 的完整内容，足够超过三十个字符的最低门槛，用于 Gate 机械检查。`;
            if (a === "frame.md")
                content = "这是给领导看，用来判断本期质量风险的，不是用来汇报工作量的；次要读者是研发。";
            if (a === "decision-log.md")
                content = "D-001｜active｜覆盖率的分母只算本版本计划内用例｜2026-09-30";
            writeArtifact(slug, a, content);
        }
    }
}
// ─── mock pi / ctx ──────────────────────────────────────────────────
function makeMockPi() {
    const commands = new Map();
    // deno-lint-ignore no-explicit-any
    const tools = new Map();
    const sent = [];
    const toolCallHandlers = [];
    return {
        pi: {
            registerCommand: (name, def) => commands.set(name, def),
            // deno-lint-ignore no-explicit-any
            registerTool: (tool) => tools.set(tool.name, tool),
            sendUserMessage: (content) => sent.push(content),
            on: (event, handler) => {
                if (event === "tool_call")
                    toolCallHandlers.push(handler);
            },
        },
        commands,
        tools,
        sent,
        toolCallHandlers,
    };
}
/** start 两段式的第二段：模拟模型调 create_flow 提交提炼的 slug（错误分支以 throw 表达，同 pi 运行时） */
async function submitSlug(mock, ctx, slug) {
    const tool = mock.tools.get("create_flow");
    if (!tool)
        throw new Error("create_flow 未注册");
    try {
        const res = (await tool.execute("t1", { slug }, undefined, undefined, ctx));
        return { text: res.content[0].text, isError: false };
    }
    catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
}
function makeMockCtx(opts) {
    const notifies = [];
    const confirmCalls = [];
    return {
        ctx: {
            cwd,
            ui: {
                notify: (msg, kind) => notifies.push({ msg, kind }),
                confirm: (_t, message) => {
                    confirmCalls.push(message);
                    const c = opts?.confirm;
                    return Promise.resolve(typeof c === "function" ? c(_t, message) : (c ?? true));
                },
            },
            modelRegistry: {
                getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-test" }],
                complete: () => Promise.resolve({ content: [{ type: "text", text: `{"ok":true,"conflicts":[]}` }] }),
            },
        },
        notifies,
        confirmCalls,
    };
}
// ─── stages 表 ──────────────────────────────────────────────────────
describe("stages 表完整性", () => {
    it("0..9 连续且关键字段非空", () => {
        assert.equal(STAGES.length, 10);
        assert.equal(LAST_STAGE, 9);
        STAGES.forEach((s, i) => {
            assert.equal(s.index, i);
            assert.ok(s.slug.length > 0);
            assert.ok(s.zh.length > 0);
            assert.ok(s.autonomy.length > 0);
            assert.ok(s.coreQuestion.length > 0);
            assert.ok(s.checklist.length >= 3);
            assert.ok(s.artifacts.length >= 1);
            assert.ok(s.artifactNote.length > 0);
            assert.ok(s.stopCondition.length > 0);
            assert.ok(s.gateNote.length > 0);
        });
        assert.equal(STAGES[5].slug, "visual");
        assert.deepEqual(STAGES[9].artifacts, ["spec.md", "start-prompt.md"]);
        assert.ok(STAGES[9].checklist.some((c) => c.includes("retrospective"))); // 方法经验沉淀（可选，不进 Gate）
    });
});
// ─── 状态机与 Gate ──────────────────────────────────────────────────
describe("状态机与 Gate", () => {
    beforeEach(() => freshCwd());
    it("start 新建：stage 0 + active 指针", () => {
        const state = runOk(startFlowEffect(cwd, "demo", "演示", "做个演示"));
        assert.equal(state.stage, 0);
        assert.equal(runOk(readActiveEffect(cwd)), "demo");
    });
    it("pending 目标：存取即删，无暂存返回 null；uniqueSlug 撞名加序号", () => {
        assert.equal(takePendingGoal(cwd), null);
        savePendingGoal(cwd, "多行目标\n第二行");
        assert.equal(takePendingGoal(cwd), "多行目标\n第二行");
        assert.equal(takePendingGoal(cwd), null); // 读后即删
        runOk(startFlowEffect(cwd, "报告", "报告", ""));
        assert.equal(uniqueSlug(cwd, "报告"), "报告-2");
        assert.equal(uniqueSlug(cwd, "别的"), "别的");
    });
    it("start 已存在：报错（单会话设计）", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        const err = runErr(startFlowEffect(cwd, "demo", "演示", ""));
        assert.match(err.message, /已存在/);
    });
    it("next gate 未过 → needs-confirm 带缺口；补产物后 advance", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        const blocked = runOk(advanceFlowEffect(cwd, "demo"));
        assert.equal(blocked.kind, "needs-confirm");
        assert.ok(blocked.gaps.length > 0);
        writeArtifact("demo", "dump.md", "材料：领导一句话（整理应用测试情况）+ 旧报告两份 + 巡检计划表，困惑在覆盖口径。内容足够长。");
        const advanced = runOk(advanceFlowEffect(cwd, "demo"));
        assert.equal(advanced.kind, "advanced");
        assert.equal(advanced.state.stage, 1);
    });
    it("force 强推（非 S9）：gaps 记入 history", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        const forced = runOk(forceAdvanceEffect(cwd, "demo", ["dump.md 不存在"]));
        assert.equal(forced.kind, "advanced");
        assert.equal(forced.state.stage, 1);
        const h = forced.state.history.at(-1);
        assert.equal(h.kind, "force");
        assert.deepEqual(h.gaps, ["dump.md 不存在"]);
    });
    it("goto 无原因报错；skip/regress/revisit 留痕", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        assert.ok(runErr(gotoStageEffect(cwd, "demo", 5, " ")) instanceof Error || true);
        const skipped = runOk(gotoStageEffect(cwd, "demo", 6, "纯数据搬运无需原型"));
        assert.equal(skipped.stage, 6);
        assert.equal(skipped.history.at(-1).kind, "skip");
        const back = runOk(gotoStageEffect(cwd, "demo", 3, "口径冲突回炉"));
        assert.equal(back.stage, 3);
        assert.equal(back.history.at(-1).kind, "regress");
        const stay = runOk(gotoStageEffect(cwd, "demo", 3, "同阶段重做"));
        assert.equal(stay.stage, 3);
        assert.equal(stay.history.at(-1).kind, "revisit");
    });
    it("S9 gate 过 → ready-to-freeze 不落盘；freezeFlowEffect 才提交；frozen 后 goto 重开", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        runOk(gotoStageEffect(cwd, "demo", 9, "直奔收口测试"));
        writeFilledStageArtifacts("demo", 9);
        const ready = runOk(advanceFlowEffect(cwd, "demo"));
        assert.equal(ready.kind, "ready-to-freeze");
        // 未提交：磁盘仍是 active/S9，且没有任何 freeze 历史
        const disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(disk.status, "active");
        assert.equal(disk.stage, 9);
        assert.ok(!disk.history.some((h) => h.kind === "freeze"));
        const frozenState = runOk(freezeFlowEffect(cwd, "demo"));
        assert.equal(frozenState.status, "frozen");
        assert.equal(frozenState.history.at(-1).kind, "freeze");
        assert.equal(runOk(loadFlowEffect(cwd, "demo")).status, "frozen");
        const reopened = runOk(gotoStageEffect(cwd, "demo", 3, "领导要求加维度"));
        assert.equal(reopened.status, "active");
        assert.equal(reopened.history.at(-1).kind, "reopen");
    });
    it("Gate 机械检查：frame 填空句与 D- 条目", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        runOk(gotoStageEffect(cwd, "demo", 2, "直接测 frame gate"));
        assert.ok(!evaluateGate(cwd, "demo", 2).passed);
        writeArtifact("demo", "frame.md", "内容够长但没有定位句，应该报关键词缺失。".repeat(2));
        const noKeyword = evaluateGate(cwd, "demo", 2);
        assert.ok(!noKeyword.passed);
        assert.ok(noKeyword.failures.some((f) => f.includes("用来判断")));
        writeArtifact("demo", "frame.md", "这是给___看，用来判断___的。补一点长度避免内容不足判定。");
        assert.ok(evaluateGate(cwd, "demo", 2).failures.some((f) => f.includes("___")));
        writeArtifact("demo", "frame.md", "这是给领导看，用来判断本期风险的，不是汇报工作量的；主要判断是风险趋势与阻塞项。内容足够。");
        assert.ok(evaluateGate(cwd, "demo", 2).passed);
        runOk(gotoStageEffect(cwd, "demo", 3, "测 define gate"));
        writeArtifact("demo", "definitions.md", "覆盖率：是什么（计划内用例的通过比例）、不是什么（不含临时手工验证），从哪来（计划表 + 执行记录），能不能算（能）。内容足够长。");
        writeArtifact("demo", "decision-log.md", "还没有正式条目，只是占位说明文字，长度足够但不合格，没有 D- 编号条目。");
        assert.ok(evaluateGate(cwd, "demo", 3).failures.some((f) => f.includes("D-")));
        writeArtifact("demo", "decision-log.md", "D-001｜已拍板｜分母只算计划内用例｜2026-09-30");
        assert.ok(evaluateGate(cwd, "demo", 3).passed);
    });
});
// ─── Gate Debt（Review #2） ────────────────────────────
describe("Gate Debt", () => {
    beforeEach(() => freshCwd());
    it("force 创建 open debt，跨阶段注入 prompt，resolve 关闭并写 history", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        const forced = runOk(forceAdvanceEffect(cwd, "demo", ["dump.md 不存在"]));
        assert.equal(forced.state.debts.length, 1);
        assert.equal(forced.state.debts[0].id, "G-001");
        assert.equal(forced.state.debts[0].stage, 0);
        // 后续阶段 prompt 持续可见（不是只注入下一阶段一次）
        runOk(gotoStageEffect(cwd, "demo", 4, "跳到 design 验证 debt 可见性"));
        writeFilledStageArtifacts("demo", 3);
        const prompt = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
        assert.ok(prompt.includes("G-001"));
        assert.ok(prompt.includes("跨阶段持续存在"));
        const resolved = runOk(resolveDebtEffect(cwd, "demo", "G-001", "已补 dump.md"));
        assert.equal(openDebts(resolved).length, 0);
        assert.equal(resolved.history.at(-1).kind, "debt-resolve");
        assert.ok(resolved.history.at(-1).reason.includes("已补 dump.md"));
        // 关闭后不再注入
        const promptAfter = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
        assert.ok(!promptAfter.includes("G-001（S0"));
    });
    it("resolve 不存在的 id / 无说明 → 报错", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        runOk(forceAdvanceEffect(cwd, "demo", ["dump.md 不存在"]));
        assert.match(runErr(resolveDebtEffect(cwd, "demo", "G-999", "x")).message, /未找到/);
        assert.match(runErr(resolveDebtEffect(cwd, "demo", "G-001", " ")).message, /说明/);
    });
    it("status 渲染显示未关闭 debt（renderStatus）", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        runOk(forceAdvanceEffect(cwd, "demo", ["dump.md 不存在"]));
        const text = renderStatus(cwd, runOk(loadFlowEffect(cwd, "demo")));
        assert.ok(text.includes("Gate 缺口欠账（debt）：1 个未关闭"));
        assert.ok(text.includes("G-001(S0)"));
    });
});
// ─── 原子写（Review #3） ────────────────────────────────
describe("writeFileAtomic", () => {
    beforeEach(() => freshCwd());
    it("正常写与覆盖", () => {
        const path = join(cwd, "state.json");
        writeFileAtomic(path, "{\"a\":1}");
        assert.equal(readFileSync(path, "utf-8"), "{\"a\":1}");
        writeFileAtomic(path, "{\"a\":2}");
        assert.equal(readFileSync(path, "utf-8"), "{\"a\":2}");
        assert.ok(!existsSync(`${path}.tmp`));
    });
    it("写失败时原文件不被半截 JSON 替换（目录只读模拟）", () => {
        if (process.getuid?.() === 0)
            return; // root 下 chmod 不拦截，跳过
        const dir = join(cwd, "ro");
        mkdirSync(dir);
        writeFileAtomic(join(dir, "state.json"), "{\"good\":true}");
        chmodSync(dir, 0o500);
        try {
            assert.throws(() => writeFileAtomic(join(dir, "state.json"), "{\"half\"..."));
            assert.equal(readFileSync(join(dir, "state.json"), "utf-8"), "{\"good\":true}");
        }
        finally {
            chmodSync(dir, 0o755);
        }
    });
});
// ─── parseState 严格性（Review #7） ──────────────────────
describe("parseState fail closed / fail soft", () => {
    beforeEach(() => freshCwd());
    it("旧 state（无 debts/name/goal）可读并补默认；非法控制字段拒绝", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        const path = statePath(cwd, "demo");
        const legacy = JSON.parse(readFileSync(path, "utf-8"));
        delete legacy.debts;
        delete legacy.name;
        delete legacy.goal;
        writeFileSync(path, JSON.stringify(legacy), "utf-8");
        const state = runOk(loadFlowEffect(cwd, "demo"));
        assert.deepEqual(state.debts, []);
        assert.equal(state.name, "demo");
        assert.equal(state.goal, "");
        const goodRaw = { ...legacy, debts: [], name: "demo", goal: "g" };
        for (const [patch, match] of [
            [{ status: "frozn" }, /status 非法/],
            [{ version: 2 }, /version.*不受支持/],
            [{ history: "x" }, /history 不是数组/],
            [{ stage: 11 }, /stage 非法/],
        ]) {
            writeFileSync(path, JSON.stringify({ ...goodRaw, ...patch }), "utf-8");
            const err = runErr(loadFlowEffect(cwd, "demo"));
            assert.match(err.message, match);
        }
        writeFileSync(path, "{truncated", "utf-8");
        assert.match(runErr(loadFlowEffect(cwd, "demo")).message, /不是合法 JSON/);
    });
});
// ─── decision-log lifecycle（Review #4） ────────────────
describe("decision-log lifecycle 解析", () => {
    it("legacy 已拍板视为 active；supersedes/事件使旧条目退出 active；异常进 malformed", () => {
        const parsed = parseDecisionLog([
            "# 拍板记录",
            "D-001｜已拍板｜分母只算计划内用例｜2026-09-30",
            "D-002｜active｜分母改为计划内+回归用例｜2026-10-02｜supersedes D-001",
            "D-001｜superseded｜by D-002｜2026-10-02",
            "D-003｜active｜手工验证不计入覆盖｜2026-10-03",
            "D-003｜revoked｜口径下线｜2026-10-04",
        ].join("\n"));
        assert.deepEqual(parsed.activeIds, ["D-002"]); // D-001 被 supersedes，D-003 被 revoke，仅 D-002 有效
        assert.equal(parsed.entries.length, 3);
        assert.equal(parsed.events.length, 2);
        assert.deepEqual(parsed.malformed, []);
        const legacyOnly = parseDecisionLog("D-001｜已拍板｜旧格式条目｜2026-09-30");
        assert.deepEqual(legacyOnly.activeIds, ["D-001"]);
        const bad = parseDecisionLog(["D-001｜active｜内容｜2026-09-30", "D-002｜active｜取代｜2026-10-01｜supersedes D-099", "D-001｜maybe｜怪状态｜2026-10-01"].join("\n"));
        assert.ok(bad.malformed.some((m) => m.includes("D-099")));
    });
    it("audit 输出 malformed 透传，缺省为空，非字符串数组显式失败", () => {
        const ok = parseAuditOutput({ content: [{ type: "text", text: '{"ok":true,"conflicts":[],"malformed":["第 3 行 D-00x：字段不足"]}' }] });
        assert.equal(ok.malformed.length, 1);
        const missing = parseAuditOutput({ content: [{ type: "text", text: '{"ok":true,"conflicts":[]}' }] });
        assert.deepEqual(missing.malformed, []);
        assert.throws(() => parseAuditOutput({ content: [{ type: "text", text: '{"ok":true,"conflicts":[],"malformed":[42]}' }] }));
    });
    it("P-07 不变量：ok 完全由 conflicts 推导，模型自查报告矛盾时被纠正", () => {
        const contradicted = parseAuditOutput({
            content: [{ type: "text", text: '{"ok":true,"conflicts":[{"ids":["D-001"],"summary":"矛盾","suggestion":"追加条目"}]}' }],
        });
        assert.equal(contradicted.ok, false);
        assert.equal(contradicted.conflicts.length, 1);
    });
});
// ─── 上下文分层（Review #5）与结构标记（Review #8） ──────
describe("上下文分层与结构 Gate", () => {
    beforeEach(() => freshCwd());
    it("S4 prompt 按必读/参考分层，不再平铺全部产物", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        runOk(gotoStageEffect(cwd, "demo", 4, "直接到 design 验证分层"));
        writeFilledStageArtifacts("demo", 3);
        const prompt = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
        assert.ok(prompt.includes("必读（本阶段依据）：frame.md、definitions.md、decision-log.md"));
        assert.ok(prompt.includes("需要时参考：discovery.md"));
        assert.ok(!prompt.includes("先读工作区"));
        assert.ok(!prompt.includes("dump.md")); // dump 在 S4 三层都不列
    });
    it("GATE_MARKERS：缺结构标记不过，含标记过", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        runOk(gotoStageEffect(cwd, "demo", 1, "测 discovery 结构 Gate"));
        writeArtifact("demo", "discovery.md", "只有一段足够长的普通文字，没有任何必需的小节标题，长度远远超过三十个字符的门槛。");
        assert.ok(!evaluateGate(cwd, "demo", 1).passed);
        assert.ok(evaluateGate(cwd, "demo", 1).failures.some((f) => f.includes("已确认事实")));
        writeArtifact("demo", "discovery.md", MARKER_CONTENT["discovery.md"]);
        assert.ok(evaluateGate(cwd, "demo", 1).passed);
    });
});
// ─── Prompt 契约（P-01～P-05） ────────────────────────
describe("Prompt 契约", () => {
    it("S0：externalize 不 investigate", () => {
        const s0 = STAGES[0];
        assert.ok(s0.autonomy.includes("不为了 dump 看起来完整而主动开展大规模调查"));
        assert.ok(s0.autonomy.includes("待探索"));
        assert.ok(s0.checklist.some((c) => c.includes("待探索")));
    });
    it("S2：候选 → 用户反应 → 定稿的强制交互链", () => {
        const s2 = STAGES[2];
        assert.ok(s2.autonomy.includes("用户没有明确确认前"));
        assert.ok(s2.autonomy.includes("大白话"));
        assert.ok(s2.artifactNote.includes("只能在用户确认后写入"));
        assert.ok(s2.stopCondition.includes("未经用户确认"));
    });
    it("S5：候选必须沿关键视觉变量拉开差异并说明取舍", () => {
        const s5 = STAGES[5];
        assert.ok(s5.checklist.some((c) => c.includes("关键视觉变量")));
        assert.ok(s5.checklist.some((c) => c.includes("牺牲了什么")));
        assert.ok(s5.checklist.some((c) => c.includes("非专业")));
    });
    it("S7：证据式判读，无数字分", () => {
        const s7 = STAGES[7];
        const all = [s7.checklist.join(), s7.artifactNote].join();
        assert.ok(all.includes("Pass / Concern / Fail / Not verified"));
        assert.ok(all.includes("证据"));
        assert.ok(!all.includes("1~5"));
        assert.ok(!all.includes("<3"));
    });
    it("S8：升级规则存在且不自行 goto", () => {
        const s8 = STAGES[8];
        assert.ok(s8.checklist.some((c) => c.includes("升级规则")));
        assert.ok(s8.checklist.some((c) => c.includes("不自行 goto")));
        assert.ok(s8.stopCondition.includes("停止扩量"));
    });
});
// ─── stale：上游回退后的产物重确认 ─────────────────────
describe("stale：上游回退后的产物重确认", () => {
    beforeEach(() => freshCwd());
    /** 把产物 mtime 相对现在回拨/前拨，确定性构造旧/新版本 */
    function setTime(slug, name, deltaMs) {
        const p = join(flowDir(cwd, slug), name);
        const t = new Date(Date.now() + deltaMs);
        utimesSync(p, t, t);
    }
    function setupToS7() {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        runOk(gotoStageEffect(cwd, "demo", 7, "模拟已到 S7"));
        writeFilledStageArtifacts("demo", 6);
        for (const f of ["frame.md", "definitions.md", "decision-log.md", "design.md", "visual-direction.md", "prototype.md"]) {
            setTime("demo", f, -60_000); // 统一田调为「旧版本」
        }
    }
    it("acceptance：S7→goto 2→改 frame→旧产物不能空过，逐阶段重确认后传播推进", () => {
        setupToS7();
        runOk(gotoStageEffect(cwd, "demo", 2, "Frame 定位错了"));
        let state = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(state.stale?.from, 3);
        // 重写 frame（前拨 mtime 确保晚于回退点）→ S2 过，stale 不前移（2 < 3）
        writeArtifact("demo", "frame.md", "这是给研发看，用来判断阻塞项的，不是汇报进度的；重新定位后的版本。");
        setTime("demo", "frame.md", 60_000);
        let out = runOk(advanceFlowEffect(cwd, "demo"));
        assert.equal(out.kind, "advanced");
        state = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(state.stage, 3);
        assert.equal(state.stale?.from, 3);
        // S3：definitions 旧版本被挡，decision-log 豁免不挡
        let gate = evaluateGate(cwd, "demo", 3, state.stale);
        assert.ok(!gate.passed);
        assert.ok(gate.failures.some((f) => f.includes("旧版本")));
        assert.ok(!gate.failures.some((f) => f.includes("decision-log")));
        // 重写 definitions → S3 过，stale 前移到 4；S4 仍 stale（design 旧）
        writeArtifact("demo", "definitions.md", MARKER_CONTENT["definitions.md"] ?? "重新确认后的口径定义，内容足够长过机械 Gate 的长度门槛要求。");
        writeArtifact("demo", "decision-log.md", "D-001｜active｜分母只算计划内用例｜2026-09-30"); // 未重写也可，豁免
        setTime("demo", "definitions.md", 60_000);
        out = runOk(advanceFlowEffect(cwd, "demo"));
        assert.equal(out.kind, "advanced");
        state = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(state.stage, 4);
        assert.equal(state.stale?.from, 4);
        gate = evaluateGate(cwd, "demo", 4, state.stale);
        assert.ok(!gate.passed && gate.failures.some((f) => f.includes("旧版本")));
        // 重写 design → S4 过 → stale 到 5，S5 旧 visual 仍被挡（逐阶段传播）
        writeArtifact("demo", "design.md", MARKER_CONTENT["design.md"]);
        setTime("demo", "design.md", 60_000);
        out = runOk(advanceFlowEffect(cwd, "demo"));
        assert.equal(out.kind, "advanced");
        gate = evaluateGate(cwd, "demo", 5, runOk(loadFlowEffect(cwd, "demo")).stale);
        assert.ok(!gate.passed && gate.failures.some((f) => f.includes("旧版本")));
    });
    it("regress 后不改任何产物：旧产物全部被 stale 挡住（存在 ≠ 当前有效）", () => {
        setupToS7();
        runOk(gotoStageEffect(cwd, "demo", 3, "口径错了回炉"));
        const state = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(state.stale?.from, 4);
        const gate = evaluateGate(cwd, "demo", 4, state.stale);
        assert.ok(!gate.passed);
        assert.ok(gate.failures.some((f) => f.includes("旧版本")));
    });
    it("revisit 同阶段不没 stale；skip 不设 stale", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        runOk(gotoStageEffect(cwd, "demo", 4, "前进"));
        assert.equal(runOk(loadFlowEffect(cwd, "demo")).stale, null);
        runOk(gotoStageEffect(cwd, "demo", 4, "同阶段重做"));
        assert.equal(runOk(loadFlowEffect(cwd, "demo")).stale, null);
    });
    it("frozen reopen → 回退阶段之后 stale；回退目标自身与更早阶段不受影响", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        runOk(gotoStageEffect(cwd, "demo", 9, "直奔收口"));
        writeFilledStageArtifacts("demo", 9);
        runOk(freezeFlowEffect(cwd, "demo"));
        assert.equal(runOk(loadFlowEffect(cwd, "demo")).stale, null);
        runOk(gotoStageEffect(cwd, "demo", 3, "领导要求改口径"));
        const state = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(state.stale?.from, 4);
        // S3 自身不在 stale 范围：旧 definitions 可过（它是要重做的对象，但不是被作废对象）
        assert.ok(evaluateGate(cwd, "demo", 3, state.stale).passed);
    });
    it("force 越 stale：需确认 → 强推产生 Gate Debt，stale 随之前移", () => {
        setupToS7();
        runOk(gotoStageEffect(cwd, "demo", 3, "回炉"));
        let out = runOk(advanceFlowEffect(cwd, "demo"));
        // S3 自身 fresh（旧 definitions 田调过但在 stale 范围内 3>=3？—— stale.from=4，S3 不检查
        assert.equal(out.kind, "advanced");
        out = runOk(advanceFlowEffect(cwd, "demo")); // S4：stale 挡下
        assert.equal(out.kind, "needs-confirm");
        assert.ok(out.gaps.some((g) => g.includes("旧版本")));
        const forced = runOk(forceAdvanceEffect(cwd, "demo", out.gaps));
        assert.equal(forced.kind, "advanced");
        assert.equal(forced.state.debts.length, 1);
        assert.equal(forced.state.stale?.from, 5);
    });
    it("status 与 prompt 的 stale 措辞；上游前提检查只注入 S4+", () => {
        setupToS7();
        runOk(gotoStageEffect(cwd, "demo", 2, "回炉"));
        writeArtifact("demo", "frame.md", "这是给研发看，用来判断阻塞项的，不是汇报进度的；重新定位后的版本。");
        runOk(advanceFlowEffect(cwd, "demo")); // → S3
        const state = runOk(loadFlowEffect(cwd, "demo"));
        const text = renderStatus(cwd, state);
        assert.ok(text.includes("上游有调整（stale）：S3–S9"));
        const prompt = buildStagePrompt({ state, cwd });
        assert.ok(prompt.includes("仅供历史参考"));
        assert.ok(prompt.includes("decision-log 不整体重写"));
        assert.ok(!prompt.includes("上游前提检查")); // 当前在 S3，不注入（下一用例验 S4+）
    });
    it("上游前提检查：S0–S3 不注入，S4+ 注入", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "g"));
        const s3 = buildStagePrompt({ state: { ...runOk(loadFlowEffect(cwd, "demo")), stage: 3 }, cwd });
        assert.ok(!s3.includes("上游前提检查"));
        const s4 = buildStagePrompt({ state: { ...runOk(loadFlowEffect(cwd, "demo")), stage: 4 }, cwd });
        assert.ok(s4.includes("上游前提检查"));
        assert.ok(s4.includes("回上由用户决定"));
    });
});
// ─── prompt 拼装与渲染 ──────────────────────────────────────────────
describe("prompt 拼装与渲染", () => {
    beforeEach(() => freshCwd());
    it("buildStagePrompt 注入任务上下文与阶段内容", () => {
        runOk(startFlowEffect(cwd, "demo", "月度质量报告", "给领导看的应用测试月报"));
        writeArtifact("demo", "dump.md", "已有产物，用于注入清单。内容足够长。");
        const prompt = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
        assert.ok(prompt.includes("月度质量报告"));
        assert.ok(prompt.includes("阶段 0/9 dump"));
        assert.ok(prompt.includes("自主权："));
        assert.ok(prompt.includes("dump.md"));
        assert.ok(prompt.includes("停止条件"));
        assert.ok(!prompt.includes("先读工作区")); // 旧平铺行已由分层替换（S0 无上游产物，不出现必读行）
    });
    it("priorGaps 附注注入", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        const prompt = buildStagePrompt({
            state: runOk(loadFlowEffect(cwd, "demo")),
            cwd,
            priorGaps: ["frame.md 不存在"],
        });
        assert.ok(prompt.includes("上一阶段 Gate 缺口"));
        assert.ok(prompt.includes("frame.md 不存在"));
    });
    it("状态轨标记：✓/!/●/○/frozen", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        runOk(forceAdvanceEffect(cwd, "demo", ["缺口"]));
        const state = runOk(loadFlowEffect(cwd, "demo"));
        const marks = STAGES.map((s) => stageMark(s, state, new Set([0]))).join(" ");
        assert.ok(marks.includes("!dump"));
        assert.ok(marks.includes("●explore"));
        assert.ok(marks.includes("○freeze"));
        const frozen = { ...state, status: "frozen" };
        assert.ok(STAGES.every((s) => stageMark(s, frozen, new Set()).startsWith("✓")));
    });
    it("renderStatus 与建议下一步各分支", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", "目标"));
        const text = renderStatus(cwd, runOk(loadFlowEffect(cwd, "demo")));
        assert.ok(text.includes("●dump"));
        assert.ok(text.includes("Sensemaking"));
        assert.ok(text.includes("Gate 机械检查：未过"));
        assert.ok(nextStepAdvice(cwd, runOk(loadFlowEffect(cwd, "demo"))).includes("完成本阶段产物"));
        writeArtifact("demo", "dump.md", "补齐产物让 gate 通过：材料清单、困惑、已知情况都写全了，内容长度足够超过门槛。");
        assert.ok(nextStepAdvice(cwd, runOk(loadFlowEffect(cwd, "demo"))).includes("Gate 已过"));
        const frozenState = { ...runOk(loadFlowEffect(cwd, "demo")), status: "frozen", stage: 9 };
        assert.ok(nextStepAdvice(cwd, frozenState).includes("start-prompt.md"));
    });
});
// ─── 补全 ───────────────────────────────────────────────────────────
describe("补全分派", () => {
    beforeEach(() => freshCwd());
    it("空 query 给九个子命令；goto 给十档候选并标注相对位置", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        runOk(gotoStageEffect(cwd, "demo", 6, "进入实现阶段"));
        const subs = buildCompletions("", cwd);
        assert.equal(subs.length, 9);
        const gotoCands = buildCompletions("goto ", cwd);
        assert.equal(gotoCands.length, 10);
        const current = gotoCands.find((c) => (c.description ?? "").includes("当前"));
        assert.ok(current?.value === "goto 6 ");
        const back = buildCompletions("goto 5 ", cwd);
        assert.ok(back.some((c) => (c.description ?? "").includes("回跳")));
        const fwd = buildCompletions("goto 8 ", cwd);
        assert.ok(fwd.some((c) => (c.description ?? "").includes("前跳")));
    });
    it("start 前缀无补全（目标是自由文本）；无关词无补全", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        assert.equal(buildCompletions("start ", cwd), null);
        assert.equal(buildCompletions("status ", cwd), null);
    });
});
// ─── decision-audit ─────────────────────────────────────────────────
describe("decision-audit", () => {
    it("resolveAuditModel：tier 指代与 glob 兜底", () => {
        const available = [
            { provider: "anthropic", id: "claude-sonnet-test" },
            { provider: "openai", id: "gpt-x" },
        ];
        const tiers = {
            opus: [{ provider: "anthropic", id: "claude-opus-test" }],
            sonnet: [{ provider: "anthropic", id: "claude-sonnet-test" }],
            haiku: [],
        };
        const hit = resolveAuditModel("tier:sonnet", available, tiers);
        assert.equal(hit?.id, "claude-sonnet-test");
        assert.equal(resolveAuditModel("gpt-*", available, tiers)?.id, "gpt-x");
        assert.equal(resolveAuditModel("tier:haiku", available, tiers), undefined);
    });
    it("parseAuditOutput：围栏容忍与坏输出", () => {
        const ok = parseAuditOutput({ content: [{ type: "text", text: '```json\n{"ok":false,"conflicts":[{"ids":["D-001","D-004"],"summary":"新旧分母口径矛盾","suggestion":"追加新条目废止旧口径"}]}\n```' }] });
        assert.equal(ok.ok, false);
        assert.equal(ok.conflicts[0].ids.length, 2);
        assert.throws(() => parseAuditOutput({ content: [{ type: "text", text: "我认为没有冲突" }] }));
    });
    it("auditDecisionLog 三分支：无冲突 / 冲突 / 失败", async () => {
        const deps = (text) => ({
            decisionLog: "D-001｜已拍板｜A｜2026-09-30",
            goal: "目标",
            modelSpec: "claude-sonnet-test",
            available: [{ provider: "anthropic", id: "claude-sonnet-test" }],
            complete: () => Promise.resolve({ content: [{ type: "text", text }] }),
        });
        const clean = await Effect.runPromise(auditDecisionLog(deps(`{"ok":true,"conflicts":[]}`)));
        assert.equal(clean.ok, true);
        const conflict = await Effect.runPromise(auditDecisionLog(deps(`{"ok":false,"conflicts":[{"ids":["D-001"],"summary":"矛盾","suggestion":"追加条目"}]}`)));
        assert.equal(conflict.conflicts.length, 1);
        const failed = await Effect.runPromise(Effect.either(auditDecisionLog({
            ...deps(""),
            timeoutMs: 10,
            complete: () => new Promise(() => undefined), // 永不 resolve → 超时
        })));
        assert.equal(failed._tag, "Left");
    });
});
// ─── guard ──────────────────────────────────────────────────────────
describe("guard 阶段跳跃防护", () => {
    beforeEach(() => {
        freshCwd();
        resetGuardState();
    });
    function fireWrite(mock, path) {
        const ctx = makeMockCtx();
        const event = { type: "tool_call", toolName: "write", toolCallId: "t1", input: { path, content: "x" } };
        for (const h of mock.toolCallHandlers)
            void h(event, ctx.ctx);
        return ctx;
    }
    it("S0 写流程外文件提示一次，同阶段去重；.hapilon 内不提示；S6 不提示；无活跃不提示", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        assert.equal(mock.toolCallHandlers.length, 1);
        // 无活跃 flow
        let ctx = fireWrite(mock, "src/x.html");
        await Promise.resolve();
        assert.equal(ctx.notifies.length, 0);
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        // 流程外 → 提示（中性边界提醒，不预设 goto 6）
        ctx = fireWrite(mock, "src/x.html");
        await Promise.resolve();
        assert.equal(ctx.notifies.length, 1);
        assert.ok(ctx.notifies[0].msg.includes("S0 dump"));
        assert.ok(ctx.notifies[0].msg.includes("超出本阶段"));
        assert.ok(ctx.notifies[0].msg.includes("调查/辅助工作"));
        assert.ok(!ctx.notifies[0].msg.includes("goto 6"));
        assert.equal(ctx.notifies[0].kind, "warning");
        // 同阶段第二次 → 去重
        ctx = fireWrite(mock, "src/y.html");
        await Promise.resolve();
        assert.equal(ctx.notifies.length, 0);
        // 工作区内 → 不提示
        ctx = fireWrite(mock, ".hapilon/ai-flow/demo/dump.md");
        await Promise.resolve();
        assert.equal(ctx.notifies.length, 0);
        // S6 起不提示
        runOk(gotoStageEffect(cwd, "demo", 6, "进入实现阶段"));
        ctx = fireWrite(mock, "src/dashboard.html");
        await Promise.resolve();
        assert.equal(ctx.notifies.length, 0);
    });
});
// ─── S9 freeze 两阶段提交 ────────────────────────────────
describe("S9 freeze 两阶段提交", () => {
    const CONFLICT_TEXT = `{"ok":false,"conflicts":[{"ids":["D-001"],"summary":"新旧分母口径矛盾","suggestion":"追加新条目废止旧口径"}]}`;
    let homeBackup;
    before(() => {
        // 让 tier:sonnet 解析命中 mock 模型：临时 HAPILON_HOME + 档位表
        homeBackup = process.env.HAPILON_HOME;
        const home = mkdtempSync(join(tmpdir(), "hpl-aiflow-home-"));
        writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({ sonnet: [{ provider: "anthropic", id: "claude-sonnet-test" }] }), "utf-8");
        process.env.HAPILON_HOME = home;
    });
    after(() => {
        if (homeBackup === undefined)
            delete process.env.HAPILON_HOME;
        else
            process.env.HAPILON_HOME = homeBackup;
    });
    beforeEach(() => freshCwd());
    function makeSeqCtx(opts) {
        const notifies = [];
        const confirmCalls = [];
        const queue = [...(opts.confirms ?? [])];
        return {
            ctx: {
                cwd,
                ui: {
                    notify: (msg, kind) => notifies.push({ msg, kind }),
                    confirm: (_t, message) => {
                        confirmCalls.push(message);
                        const next = queue.shift();
                        if (next === undefined)
                            throw new Error(`confirm 队列耗尽：${message}`);
                        return Promise.resolve(next);
                    },
                },
                modelRegistry: {
                    getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-test" }],
                    complete: () => Promise.resolve({ content: [{ type: "text", text: opts.auditText ?? `{"ok":true,"conflicts":[]}` }] }),
                },
            },
            notifies,
            confirmCalls,
        };
    }
    /** S9 就绪：产物齐（含 decision-log） */
    async function readyAtS9(mock) {
        const setup = makeSeqCtx({});
        await mock.commands.get("build-ai-flow").handler("start demo", setup.ctx);
        await submitSlug(mock, setup.ctx, "demo");
        runOk(gotoStageEffect(cwd, "demo", 9, "直奔收口测试"));
        writeFilledStageArtifacts("demo", 9);
    }
    it("① gate 过 → 审查无冲突 → frozen", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        await readyAtS9(mock);
        const ctx = makeSeqCtx({ confirms: [true], auditText: `{"ok":true,"conflicts":[]}` });
        await mock.commands.get("build-ai-flow").handler("next", ctx.ctx);
        const disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(disk.status, "frozen");
        assert.equal(disk.history.filter((h) => h.kind === "freeze").length, 1);
        assert.ok(ctx.notifies.some((n) => n.msg.includes("已冻结")));
    });
    it("② gate 过 → 冲突 → 用户确认冻结 → frozen", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        await readyAtS9(mock);
        const ctx = makeSeqCtx({ confirms: [true, true], auditText: CONFLICT_TEXT });
        await mock.commands.get("build-ai-flow").handler("next", ctx.ctx);
        const disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(disk.status, "frozen");
        assert.ok(ctx.confirmCalls[1].includes("仍要冻结"));
    });
    it("③ gate 过 → 冲突 → 用户拒绝 → 保持 active/S9，history 无 freeze", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        await readyAtS9(mock);
        const ctx = makeSeqCtx({ confirms: [true, false], auditText: CONFLICT_TEXT });
        await mock.commands.get("build-ai-flow").handler("next", ctx.ctx);
        const disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(disk.status, "active");
        assert.equal(disk.stage, 9);
        assert.ok(!disk.history.some((h) => h.kind === "freeze"));
        assert.ok(ctx.notifies.some((n) => n.msg.includes("未冻结")));
        assert.ok(!mock.sent.some((s) => s.includes("已冻结")));
    });
    it("④ 拒绝后再次 /next 可重新进入 freeze 流程并成功", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        await readyAtS9(mock);
        const reject = makeSeqCtx({ confirms: [true, false], auditText: CONFLICT_TEXT });
        await mock.commands.get("build-ai-flow").handler("next", reject.ctx);
        assert.equal(runOk(loadFlowEffect(cwd, "demo")).status, "active");
        const retry = makeSeqCtx({ confirms: [false] }); // 跳过审查直接冻结
        await mock.commands.get("build-ai-flow").handler("next", retry.ctx);
        const disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(disk.status, "frozen");
        assert.equal(disk.history.filter((h) => h.kind === "freeze").length, 1);
    });
    it("⑤ S9 force：确认强推后同样走确认才冻结；拒绝则保持 active", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const setup = makeSeqCtx({});
        await mock.commands.get("build-ai-flow").handler("start demo", setup.ctx);
        await submitSlug(mock, setup.ctx, "demo");
        runOk(gotoStageEffect(cwd, "demo", 9, "收口但产物未齐"));
        // 只写 decision-log，不写 spec/start-prompt → S9 gate 不过
        writeArtifact("demo", "decision-log.md", "D-001｜active｜分母只算计划内用例｜2026-09-30");
        // 确认强推 + 跑审查发现冲突 + 拒绝冻结 → active
        const reject = makeSeqCtx({ confirms: [true, true, false], auditText: CONFLICT_TEXT });
        await mock.commands.get("build-ai-flow").handler("next", reject.ctx);
        let disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(disk.status, "active");
        assert.equal(disk.stage, 9);
        assert.ok(!disk.history.some((h) => h.kind === "freeze"));
        assert.ok(reject.confirmCalls[0].includes("强推"));
        // 再来一轮：强推 + 跳过审查 → 冻结，S9 强推缺口统一进 debt，freeze 条目不再带 gaps
        const approve = makeSeqCtx({ confirms: [true, false] });
        await mock.commands.get("build-ai-flow").handler("next", approve.ctx);
        disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(disk.status, "frozen");
        const fz = disk.history.find((h) => h.kind === "freeze");
        assert.equal(fz.gaps, undefined);
        const debt = disk.debts.find((d) => d.stage === 9);
        assert.ok(debt && !debt.resolvedAt && debt.gaps.length > 0);
    });
    it("⑥ history 中只有成功 freeze 才出现 freeze transition（拒绝轮零残留）", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        await readyAtS9(mock);
        const reject = makeSeqCtx({ confirms: [true, false], auditText: CONFLICT_TEXT });
        await mock.commands.get("build-ai-flow").handler("next", reject.ctx);
        const afterReject = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(afterReject.history.filter((h) => h.kind === "freeze").length, 0);
        const approve = makeSeqCtx({ confirms: [true, true], auditText: CONFLICT_TEXT });
        await mock.commands.get("build-ai-flow").handler("next", approve.ctx);
        const afterApprove = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(afterApprove.history.filter((h) => h.kind === "freeze").length, 1);
    });
});
// ─── 命令 handler ───────────────────────────────────────────────────
describe("命令 handler", () => {
    beforeEach(() => freshCwd());
    it("注册命令；start 派发提炼任务，create_flow 后才派发 S0；bare 无活跃给引导", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        assert.ok(def);
        const ctx = makeMockCtx();
        await def.handler("", ctx.ctx);
        assert.ok(mock.sent.at(-1).includes("没有活跃的 build-ai-flow"));
        await def.handler("start 给领导看的应用测试月报", ctx.ctx);
        assert.ok(mock.sent.at(-1).includes("a-b-c")); // 提炼规则在派发 prompt 里
        assert.ok(ctx.notifies.some((n) => n.msg.includes("已暂存")));
        const r = await submitSlug(mock, ctx.ctx, "app-test-monthly");
        assert.ok(!r.isError);
        assert.ok(mock.sent.at(-1).includes("阶段 0/9 dump"));
        assert.ok(existsSync(join(flowDir(cwd, "app-test-monthly"), "state.json")));
    });
    it("start 目标可多行，全文进提炼任务，create_flow 后 goal 全量入档", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        const ctx = makeMockCtx();
        const goal = "拆支付模块\n\n现状：渠道耦合在一个文件里\n- 改一个渠道全量回归\n- 无法按渠道独立发布\n目标：按渠道拆成独立目录";
        await def.handler(`start ${goal}`, ctx.ctx);
        assert.ok(mock.sent.at(-1).includes("按渠道拆成独立目录")); // 提炼任务带全文
        await submitSlug(mock, ctx.ctx, "pay-split");
        const state = runOk(loadFlowEffect(cwd, "pay-split"));
        assert.equal(state.name, "Pay Split");
        assert.ok(state.goal.includes("按渠道拆成独立目录"));
    });
    it("create_flow：无暂存拒建；不合格 slug 拒回并放回暂存可重试", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        const ctx = makeMockCtx();
        await def.handler("start", ctx.ctx);
        assert.ok(ctx.notifies.some((n) => n.msg.includes("用法") && n.msg.includes("多行")));
        const none = await submitSlug(mock, ctx.ctx, "demo");
        assert.ok(none.isError && none.text.includes("没有待创建"));
        await def.handler("start 把支付拆掉", ctx.ctx);
        const bad = await submitSlug(mock, ctx.ctx, "Demo");
        assert.ok(bad.isError && bad.text.includes("不合格式"));
        const good = await submitSlug(mock, ctx.ctx, "pay-split");
        assert.ok(!good.isError);
        assert.ok(existsSync(join(flowDir(cwd, "pay-split"), "state.json")));
    });
    it("create_flow 撞已有 flow：slug 加序号建新盘（不覆盖旧盘）", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        const ctx = makeMockCtx();
        runOk(startFlowEffect(cwd, "demo", "演示", "旧任务"));
        await def.handler("start 新一轮演示", ctx.ctx);
        const r = await submitSlug(mock, ctx.ctx, "demo");
        assert.ok(!r.isError);
        assert.ok(existsSync(join(flowDir(cwd, "demo-2"), "state.json")));
        const fresh = runOk(loadFlowEffect(cwd, "demo-2"));
        assert.equal(fresh.goal, "新一轮演示");
        assert.equal(runOk(loadFlowEffect(cwd, "demo")).goal, "旧任务");
    });
    it("debt 子命令：列表与显式 resolve", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        const ctx = makeMockCtx({ confirm: true });
        await def.handler("start demo", ctx.ctx);
        await submitSlug(mock, ctx.ctx, "demo");
        await def.handler("next", ctx.ctx); // gate 不过 → confirm true → 强推，产生 G-001
        ctx.notifies.length = 0;
        await def.handler("debt", ctx.ctx);
        assert.ok(ctx.notifies.some((n) => n.msg.includes("G-001") && n.msg.includes("未关闭")));
        await def.handler("debt resolve G-001 已补 dump.md", ctx.ctx);
        assert.ok(ctx.notifies.some((n) => n.msg.includes("已关闭") && n.msg.includes("剩余未关闭：0")));
        const disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(openDebts(disk).length, 0);
        assert.equal(disk.history.at(-1).kind, "debt-resolve");
    });
    it("freeze 前存在 open debt → 显式 warning 提示（不自动禁止）", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const yes = makeMockCtx({ confirm: true });
        await mock.commands.get("build-ai-flow").handler("start demo", yes.ctx);
        await submitSlug(mock, yes.ctx, "demo");
        await mock.commands.get("build-ai-flow").handler("next", yes.ctx); // 强推 → G-001 open
        runOk(gotoStageEffect(cwd, "demo", 9, "直奔收口"));
        writeFilledStageArtifacts("demo", 9);
        yes.notifies.length = 0;
        await mock.commands.get("build-ai-flow").handler("next", yes.ctx); // ready → debt warning → 审查 confirm(true) → clean → 冻结
        assert.ok(yes.notifies.some((n) => n.msg.includes("未关闭的 Gate 缺口欠账")));
        const disk = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(disk.status, "frozen"); // 人未拒绝，仍可冻结
        assert.equal(openDebts(disk).length, 1); // 冻结不自动关闭 debt
    });
    it("next：gate 不过 confirm 拒绝 → 不推进；confirm 同意 → 强推带缺口", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        const no = makeMockCtx({ confirm: false });
        await def.handler("start demo", no.ctx);
        await submitSlug(mock, no.ctx, "demo");
        await def.handler("next", no.ctx);
        const stateAfterNo = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(stateAfterNo.stage, 0);
        assert.ok(no.notifies.some((n) => n.msg.includes("未推进")));
        const yes = makeMockCtx({ confirm: true });
        await def.handler("next", yes.ctx);
        const stateAfterYes = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(stateAfterYes.stage, 1);
        assert.ok(mock.sent.at(-1).includes("上一阶段 Gate 缺口"));
    });
    it("goto 缺原因报 usage；带原因派发目标阶段", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        const ctx = makeMockCtx();
        await def.handler("start demo", ctx.ctx);
        await submitSlug(mock, ctx.ctx, "demo");
        await def.handler("goto 3", ctx.ctx);
        assert.ok(ctx.notifies.some((n) => n.msg.includes("原因")));
        await def.handler("goto 3 口径冲突回炉", ctx.ctx);
        assert.ok(mock.sent.at(-1).includes("阶段 3/9 define"));
    });
    it("status 渲染含状态轨与建议", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        const ctx = makeMockCtx();
        await def.handler("start demo", ctx.ctx);
        await submitSlug(mock, ctx.ctx, "demo");
        await def.handler("status", ctx.ctx);
        const status = ctx.notifies.find((n) => n.msg.includes("●dump"));
        assert.ok(status);
        assert.ok(status.msg.includes("建议下一步"));
    });
    it("list 列出已有 flow", async () => {
        const mock = makeMockPi();
        hplBuildAiFlow(mock.pi);
        const def = mock.commands.get("build-ai-flow");
        const ctx = makeMockCtx();
        await def.handler("start demo", ctx.ctx);
        await submitSlug(mock, ctx.ctx, "demo");
        ctx.notifies.length = 0;
        await def.handler("list", ctx.ctx);
        assert.ok(ctx.notifies.some((n) => n.msg.includes("demo")));
    });
});
// ─── Capability 集成（golden-case，设计 §16）────────────────────────
describe("Capability：状态与迁移", () => {
    beforeEach(() => freshCwd());
    it("enable 写状态 + history 留痕", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        const state = runOk(setCapabilityEffect(cwd, "demo", "golden-case", "enabled", "金额与状态是真值"));
        assert.equal(state.capabilities["golden-case"]?.status, "enabled");
        assert.equal(state.capabilities["golden-case"]?.enabledAtStage, 0);
        assert.equal(state.history.at(-1)?.kind, "cap-enable");
        const reloaded = runOk(loadFlowEffect(cwd, "demo"));
        assert.equal(reloaded.capabilities["golden-case"]?.reason, "金额与状态是真值");
    });
    it("未知能力 id 报错", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        const err = runErr(setCapabilityEffect(cwd, "demo", "artifact", "enabled", ""));
        assert.match(err.message, /未知能力/);
        assert.deepEqual(KNOWN_CAPABILITIES, ["golden-case"]);
    });
    it("enable→decline 翻转：单条目覆盖，history 双留痕", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        runOk(setCapabilityEffect(cwd, "demo", "golden-case", "enabled", ""));
        const state = runOk(setCapabilityEffect(cwd, "demo", "golden-case", "declined", "其实是纯视觉任务"));
        assert.equal(state.capabilities["golden-case"]?.status, "declined");
        assert.equal(state.capabilities["golden-case"]?.enabledAtStage, undefined);
        const kinds = state.history.slice(-2).map((h) => h.kind);
        assert.deepEqual(kinds, ["cap-enable", "cap-decline"]);
    });
    it("parseState fail closed：未知 id / 非法 status / 越界 enabledAtStage", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        const base = JSON.parse(readFileSync(statePath(cwd, "demo"), "utf-8"));
        for (const bad of [
            { "some-plugin": { status: "enabled" } },
            { "golden-case": { status: "maybe" } },
            { "golden-case": { status: "enabled", enabledAtStage: 42 } },
        ]) {
            writeFileSync(statePath(cwd, "demo"), JSON.stringify({ ...base, capabilities: bad }), "utf-8");
            const err = runErr(loadFlowEffect(cwd, "demo"));
            assert.match(err.message, /capabilities|能力/, JSON.stringify(bad));
        }
    });
    it("旧 state（无 capabilities 字段）向后兼容：补 {} 且推进正常", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        const base = JSON.parse(readFileSync(statePath(cwd, "demo"), "utf-8"));
        delete base.capabilities;
        writeFileSync(statePath(cwd, "demo"), JSON.stringify(base), "utf-8");
        const state = runOk(loadFlowEffect(cwd, "demo"));
        assert.deepEqual(state.capabilities, {});
        writeFilledStageArtifacts("demo", 0);
        const outcome = runOk(advanceFlowEffect(cwd, "demo"));
        assert.equal(outcome.kind, "advanced");
    });
});
describe("Capability：S3 Gate 代理检查", () => {
    beforeEach(() => freshCwd());
    const CAPS_ON = { "golden-case": { status: "enabled", enabledAtStage: 2 } };
    it("未启用：有草稿无封金也不拦", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        writeFilledStageArtifacts("demo", 3);
        mkdirSync(join(cwd, ".hapilon", "go-case"), { recursive: true });
        writeFileSync(join(cwd, ".hapilon", "go-case", "cases.yaml"), "cases: []", "utf-8");
        assert.ok(evaluateGate(cwd, "demo", 3, null).passed);
        assert.ok(evaluateGate(cwd, "demo", 3, null, {}).passed);
    });
    it("已启用但无 go-case 目录：不拦（不起草是用户拍板）", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        writeFilledStageArtifacts("demo", 3);
        assert.ok(evaluateGate(cwd, "demo", 3, null, CAPS_ON).passed);
    });
    it("已启用 + 有草稿 + 无封金快照 → 缺口", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        writeFilledStageArtifacts("demo", 3);
        mkdirSync(join(cwd, ".hapilon", "go-case"), { recursive: true });
        writeFileSync(join(cwd, ".hapilon", "go-case", "cases.yaml"), "cases: []", "utf-8");
        const gate = evaluateGate(cwd, "demo", 3, null, CAPS_ON);
        assert.ok(!gate.passed);
        assert.match(gate.failures.join("\n"), /封金/);
    });
    it("已启用 + 草稿 + 封金快照 → 过；declined 同未启用", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        writeFilledStageArtifacts("demo", 3);
        mkdirSync(join(cwd, ".hapilon", "go-case"), { recursive: true });
        writeFileSync(join(cwd, ".hapilon", "go-case", "cases.yaml"), "cases: []", "utf-8");
        writeFileSync(join(cwd, ".hapilon", "go-case", "frozen.md"), "v3 快照", "utf-8");
        assert.ok(evaluateGate(cwd, "demo", 3, null, CAPS_ON).passed);
        assert.ok(evaluateGate(cwd, "demo", 3, null, { "golden-case": { status: "declined" } }).passed);
    });
});
describe("Capability：prompt 注入与防骚扰", () => {
    beforeEach(() => freshCwd());
    function atStage(slug, target) {
        runOk(gotoStageEffect(cwd, slug, target, "测试定位"));
    }
    it("未决定：S2/S3 出现推荐条款，S4 起静默", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        atStage("demo", 2);
        assert.match(buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd }), /能力推荐（golden-case/);
        atStage("demo", 3);
        assert.match(buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd }), /能力推荐（golden-case/);
        atStage("demo", 4);
        assert.doesNotMatch(buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd }), /能力推荐|能力上下文/);
    });
    it("已拒绝：全程静默（S2 也不出现推荐）", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        atStage("demo", 2);
        runOk(setCapabilityEffect(cwd, "demo", "golden-case", "declined", "纯视觉"));
        const state = runOk(loadFlowEffect(cwd, "demo"));
        assert.deepEqual(capabilityBlock(cwd, state), []);
        assert.doesNotMatch(buildStagePrompt({ state, cwd }), /golden-case/);
    });
    it("已启用 S3：主工作点指引 + 上下文存在性降级", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        atStage("demo", 3);
        runOk(setCapabilityEffect(cwd, "demo", "golden-case", "enabled", ""));
        let prompt = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
        assert.match(prompt, /主工作点/);
        assert.doesNotMatch(prompt, /能力上下文/); // 无 go-case 文件 → 降级不列
        mkdirSync(join(cwd, ".hapilon", "go-case"), { recursive: true });
        writeFileSync(join(cwd, ".hapilon", "go-case", "cases.yaml"), "cases: []", "utf-8");
        writeFileSync(join(cwd, ".hapilon", "go-case", "frozen.md"), "v3", "utf-8");
        prompt = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
        assert.match(prompt, /能力上下文（golden-case·需要时参考）：\.hapilon\/go-case\/cases\.yaml/);
    });
    it("已启用 S6：观察指引 + 禁止路径 + manifest 上下文", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        atStage("demo", 6);
        runOk(setCapabilityEffect(cwd, "demo", "golden-case", "enabled", ""));
        mkdirSync(join(cwd, ".hapilon", "go-case"), { recursive: true });
        writeFileSync(join(cwd, ".hapilon", "go-case", "frozen.md"), "v3", "utf-8");
        writeFileSync(join(cwd, ".hapilon", "go-case", "manifest.json"), "{}", "utf-8");
        const prompt = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
        assert.match(prompt, /Implementation Observation/);
        assert.match(prompt, /禁止路径/);
        assert.match(prompt, /能力上下文（golden-case·必读）：\.hapilon\/go-case\/frozen\.md/);
        assert.match(prompt, /需要时参考）：.*manifest\.json/);
    });
    it("已启用 S4：frozen 权威 + 上游检查含能力条款；S7 两问；S9 记位置", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        atStage("demo", 4);
        runOk(setCapabilityEffect(cwd, "demo", "golden-case", "enabled", ""));
        mkdirSync(join(cwd, ".hapilon", "go-case"), { recursive: true });
        writeFileSync(join(cwd, ".hapilon", "go-case", "frozen.md"), "v3", "utf-8");
        let prompt = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
        assert.match(prompt, /权威约束/);
        assert.match(prompt, /能力可以发现问题，没有上游修改权/);
        for (const stage of [7, 9]) {
            runOk(gotoStageEffect(cwd, "demo", stage, "定位"));
            prompt = buildStagePrompt({ state: runOk(loadFlowEffect(cwd, "demo")), cwd });
            assert.match(prompt, stage === 7 ? /A\. implementation 是否满足 frozen case/ : /不复制内容/);
        }
    });
    it("status 与 freeze note 的能力行", () => {
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        runOk(setCapabilityEffect(cwd, "demo", "golden-case", "enabled", "金额真值"));
        const state = runOk(loadFlowEffect(cwd, "demo"));
        assert.match(renderStatus(cwd, state), /golden-case 已启用（S0 起：金额真值）/, capabilityStatusLine(state));
        assert.match(buildFreezeNote(state), /case 资产在 \.hapilon\/go-case\//);
        runOk(setCapabilityEffect(cwd, "demo", "golden-case", "declined", ""));
        assert.match(capabilityStatusLine(runOk(loadFlowEffect(cwd, "demo"))), /已拒绝/);
    });
    it("S4 skills 含 artifact-assist（次激活）", () => {
        assert.ok(STAGES[4].skills.includes("artifact-assist"));
    });
});
describe("Capability：cap 命令与补全", () => {
    beforeEach(() => freshCwd());
    it("cap enable / decline / 裸 cap / 未知 id", async () => {
        const { pi, commands } = makeMockPi();
        hplBuildAiFlow(pi);
        const handler = commands.get("build-ai-flow").handler;
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        let { ctx, notifies } = makeMockCtx();
        await handler("cap golden-case enable 金额真值", ctx);
        assert.ok(notifies.some((n) => n.msg.includes("已启用") && n.kind === "info"));
        assert.equal(runOk(loadFlowEffect(cwd, "demo")).capabilities["golden-case"]?.status, "enabled");
        ({ ctx, notifies } = makeMockCtx());
        await handler("cap nope enable", ctx);
        assert.ok(notifies.some((n) => n.msg.includes("未知能力")));
        ({ ctx, notifies } = makeMockCtx());
        await handler("cap", ctx);
        assert.ok(notifies.some((n) => n.msg.includes("已启用")));
        ({ ctx, notifies } = makeMockCtx());
        await handler("cap golden-case decline 换思路", ctx);
        assert.ok(notifies.some((n) => n.msg.includes("已拒绝")));
    });
    it("无活跃 flow 时 cap 报错；补全含 cap 候选", async () => {
        const { pi, commands } = makeMockPi();
        hplBuildAiFlow(pi);
        const { ctx, notifies } = makeMockCtx();
        await commands.get("build-ai-flow").handler("cap golden-case enable", ctx);
        assert.ok(notifies.some((n) => n.msg.includes("没有活跃 flow")));
        runOk(startFlowEffect(cwd, "demo", "演示", ""));
        runOk(setCapabilityEffect(cwd, "demo", "golden-case", "enabled", ""));
        const subs = buildCompletions("", cwd);
        assert.ok(subs.some((c) => c.value === "cap golden-case "));
        const ops = buildCompletions("cap golden-case", cwd);
        assert.ok(ops.some((c) => c.value === "cap golden-case enable "));
        assert.ok(ops.some((c) => c.value === "cap golden-case decline "));
    });
});
