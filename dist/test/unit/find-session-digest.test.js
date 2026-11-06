import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { Effect, Exit, Cause, Option } from "effect";
import { buildSessionDigest, segmentEntries, SEGMENT_CHAR_LIMIT, MERGE_CHAR_LIMIT, MODEL_OUTPUT_CHAR_LIMIT, } from "../../extensions/hpl-find-session/digest.js";
import { readSessionEntries } from "../../extensions/hpl-find-session/index-core.js";
const MODEL = { provider: "p", id: "m", name: "M" };
const SEGMENT_MARKER = "连续一段消息";
const MERGE_MARKER = "分段小结";
const INTERMEDIATE_MARKER = "中间小结";
function entry(line, text, role = "user") {
    return { line, id: `m${line}`, role, timestamp: "", text, truncated: false, toolCallIds: [], toolCallId: "" };
}
/** 模型依赖：按 systemPrompt 区分分段/中间合并/最终合并，记录每次输入并按 scripted 返回。 */
function scriptedDeps(scripted, calls) {
    return {
        available: [MODEL],
        currentModel: undefined,
        resolvedTiers: { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] },
        complete: async (_model, messages, systemPrompt) => {
            const user = messages.map((m) => m.content).join("\n");
            calls?.push({ system: systemPrompt, user });
            return { content: scripted(systemPrompt, user) };
        },
    };
}
async function expectFailure(effect, check) {
    const exit = await Effect.runPromiseExit(effect);
    assert.ok(Exit.isFailure(exit), "期望失败但成功了");
    const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
    assert.ok(failure && check(failure), `失败类型不符：${JSON.stringify(failure)}`);
    return failure;
}
function writeSession(dir, file, messages) {
    const path = join(dir, file);
    const lines = [
        { type: "session", id: "s1", timestamp: "2026-11-06T10:00:00.000Z", cwd: "/p" },
    ];
    messages.forEach((m, i) => {
        lines.push({
            type: "message",
            id: `msg${i}`,
            timestamp: `2026-11-06T10:01:00.000Z`,
            message: { role: m.role, content: m.role === "toolResult" ? [{ type: "text", text: m.text }] : m.text },
        });
    });
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
}
function readProgressFiles(dir) {
    const progressDir = join(dir, ".digest-progress");
    if (!existsSync(progressDir))
        return [];
    return readdirSync(progressDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(progressDir, f), "utf8")));
}
describe("segmentEntries：完整 prompt 文本预算切分", () => {
    it("单个超 6000 字符消息切成多片，全部文本按序覆盖，不静默丢失", () => {
        const long = "长".repeat(20_000);
        const segments = segmentEntries([entry(2, long), entry(3, "末尾消息")]);
        assert.ok(segments.length >= 4, `超长消息应切多片，实际 ${segments.length} 段`);
        const joined = segments.flat().map((e) => e.text).join("");
        assert.ok(joined.startsWith(long), "超长消息全文保留");
        assert.equal(segments.flat().at(-1).text, "末尾消息", "末尾消息不丢");
        assert.ok(segments.flat().every((e) => e.line === 2 || e.line === 3), "分片保留原始行号");
    });
    it("每段渲染后的完整 prompt 文本都不超过 SEGMENT_CHAR_LIMIT", () => {
        const entries = Array.from({ length: 12 }, (_, i) => entry(i + 2, "字".repeat(1500), i % 2 ? "assistant" : "user"));
        entries.push(entry(99, "尾".repeat(25_000), "toolResult"));
        const segments = segmentEntries(entries);
        for (const [i, seg] of segments.entries()) {
            const rendered = seg.map((e) => {
                const tag = e.role === "user" ? "用户" : e.role === "assistant" ? "助手" : "工具结果";
                const suffix = e.truncated ? "…[工具结果过长已截断]" : "";
                return `行${e.line} ${tag}: ${e.text}${suffix}`;
            }).join("\n");
            assert.ok(rendered.length <= SEGMENT_CHAR_LIMIT, `段 ${i + 1} 渲染后 ${rendered.length} 超预算 ${SEGMENT_CHAR_LIMIT}`);
        }
        assert.ok(segments.flat().map((e) => e.text).join("").includes("尾".repeat(25_000)), "超长尾条不丢");
    });
    it("行号标签把本不超限的条目推过预算时仍切分，最后一条不丢", () => {
        // 每条正文 1990 字符：标签前 3 条=5970 不超限，标签后 3 条渲染 >6000，必须 2 条一段
        const entries = Array.from({ length: 4 }, (_, i) => entry(i + 2, "x".repeat(1990)));
        const segments = segmentEntries(entries);
        assert.equal(segments.flat().at(-1).line, 5, "最后一条在场");
        for (const seg of segments) {
            const size = seg.reduce((n, e) => n + `行${e.line} 用户: `.length + e.text.length, 0);
            assert.ok(size <= SEGMENT_CHAR_LIMIT);
        }
    });
    it("普通条目分段 flat 后与输入一致（保持共享测试兼容）", () => {
        const entries = Array.from({ length: 30 }, (_, i) => entry(i + 2, "字".repeat(2000)));
        const segments = segmentEntries(entries);
        assert.deepEqual(segments.flat(), entries);
    });
});
describe("buildSessionDigest：分级合并不截尾", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-digest2-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    it("段数足以触发分级合并时，末段主题经中间小结进入最终模型输入", async () => {
        const calls = [];
        let n = 0;
        const deps = scriptedDeps((system) => {
            if (system.includes(SEGMENT_MARKER)) {
                const k = ++n;
                return `段${k}小结：主题${k}${"述".repeat(3000)}`;
            }
            if (system.includes(INTERMEDIATE_MARKER))
                return `中间小结（携带末段主题Z）`;
            return "最终摘要：末段主题Z在场";
        }, calls);
        const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `消息${i}：${"内容".repeat(1100)}` }));
        const path = writeSession(dir, "many.jsonl", messages);
        const stats = statSync(path);
        const outcome = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, deps, MODEL));
        const segmentCount = outcome.segments;
        assert.ok(segmentCount >= 2, `应多段触发分级，实际 ${segmentCount}`);
        // 每次模型输入都不得超过字符预算
        for (const c of calls)
            assert.ok(c.user.length <= MERGE_CHAR_LIMIT, `模型输入 ${c.user.length} 超预算 ${MERGE_CHAR_LIMIT}`);
        // 中间合并层确实发生了，且最后一组的输入包含最末段小结
        const intermediateCalls = calls.filter((c) => c.system.includes(INTERMEDIATE_MARKER));
        assert.ok(intermediateCalls.length >= 2, "应有多组中间合并");
        const lastSegmentInInput = calls.some((c) => c.user.includes(`段${segmentCount}小结`));
        assert.ok(lastSegmentInInput, "最末段小结应进入某次模型输入");
        // 最终合并输入来自中间小结（承载末段主题），且不含 slice 截尾
        const finalCall = calls.at(-1);
        assert.ok(finalCall.system.includes(MERGE_MARKER));
        assert.ok(finalCall.user.includes("中间小结"), "最终输入承载中间层信息");
        assert.ok(outcome.summary.includes("主题Z"), "末段主题保留到最终摘要");
    });
    it("合并输入包含全部分段编号，不因长度被 slice", async () => {
        const calls = [];
        let n = 0;
        const deps = scriptedDeps((system) => {
            if (system.includes(SEGMENT_MARKER))
                return `段${++n}小结`;
            return "摘要";
        }, calls);
        const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: `消息${i}：${"内容".repeat(1100)}` }));
        const path = writeSession(dir, "noslice.jsonl", messages);
        const stats = statSync(path);
        const outcome = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, deps, MODEL));
        const allUsers = calls.map((c) => c.user).join("\n");
        assert.ok(allUsers.includes(`段${outcome.segments}小结`), "最末段编号进入过模型输入");
    });
});
describe("buildSessionDigest：续建、坏模型、进度损坏、文件变化", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-digest3-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    it("崩溃续建：已完成段不重跑，只调剩余段 + 合并", async () => {
        const messages = Array.from({ length: 20 }, (_, i) => ({ role: "user", text: `消息${i}：${"内容".repeat(400)}` }));
        const path = writeSession(dir, "resume.jsonl", messages);
        const stats = statSync(path);
        const totalSegments = segmentEntries((await readSessionEntries(path))).length;
        let calls = 0;
        const failing = scriptedDeps((system) => {
            if (system.includes(SEGMENT_MARKER)) {
                calls++;
                if (calls === 2)
                    throw new Error("模型调用中断");
                return `段${calls}小结`;
            }
            return "合并摘要";
        });
        await expectFailure(buildSessionDigest(path, stats.size, dir, failing, MODEL), (e) => e.cause?.includes("模型调用中断") === true);
        const saved = readProgressFiles(dir).find((p) => p.path === path);
        assert.equal(saved.segmentSummaries.length, 1);
        let resumeCalls = 0;
        const resume = scriptedDeps((system) => {
            if (system.includes(SEGMENT_MARKER)) {
                resumeCalls++;
                return `续段${resumeCalls}`;
            }
            return "续建合并摘要";
        });
        const done = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, resume, MODEL));
        assert.equal(resumeCalls, totalSegments - 1, "只补剩余段");
        assert.equal(done.summary, "续建合并摘要");
    });
    it("模型返回空正文或非法输出：DigestModelError", async () => {
        const path = writeSession(dir, "bad.jsonl", [{ role: "user", text: "问题" }]);
        const stats = statSync(path);
        const empty = scriptedDeps(() => "  ");
        const err = await expectFailure(buildSessionDigest(path, stats.size, dir, empty, MODEL), (e) => {
            const f = e;
            return f._tag === "DigestModelError" && f.stage === "segment";
        });
        assert.ok(String(err.cause).includes("空正文"));
        const garbage = scriptedDeps(() => ({ nope: true }));
        await expectFailure(buildSessionDigest(path, stats.size, dir, garbage, MODEL), (e) => e._tag === "DigestModelError");
    });
    it("损坏的进度文件报清晰 DigestFileError，不当无进度静默重建", async () => {
        const path = writeSession(dir, "corrupt.jsonl", [{ role: "user", text: "问题" }]);
        const stats = statSync(path);
        const progressDir = join(dir, ".digest-progress");
        writeFileSync(join(progressDir, "broken-file.json"), "{not json");
        // 同名进度：先用真实 hash 写坏文件
        const { createHash } = await import("node:crypto");
        const hash = createHash("sha1").update(path).digest("hex").slice(0, 16);
        writeFileSync(join(progressDir, `${hash}.json`), "{not json");
        const err = await expectFailure(buildSessionDigest(path, stats.size, dir, scriptedDeps(() => "x"), MODEL), (e) => Boolean(e.cause?.includes("进度文件损坏")));
        assert.ok(err, "应报进度损坏");
        // 结构非法（字段类型错）同样报错
        writeFileSync(join(progressDir, `${hash}.json`), JSON.stringify({ version: 2, path, sizeBytes: "错", mtimeMs: 1, segmentSummaries: [] }));
        await expectFailure(buildSessionDigest(path, stats.size, dir, scriptedDeps(() => "x"), MODEL), (e) => Boolean(e.cause?.includes("进度文件损坏")));
        // 版本过期才是静默重建
        writeFileSync(join(progressDir, `${hash}.json`), JSON.stringify({ version: 1, path, sizeBytes: stats.size, mtimeMs: stats.mtimeMs, segmentSummaries: ["旧"] }));
        const deps = scriptedDeps((system) => (system.includes(SEGMENT_MARKER) ? "新段小结" : "新摘要"));
        const outcome = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, deps, MODEL));
        assert.equal(outcome.summary, "新摘要");
    });
    it("建索引期间文件被修改：DigestFileError(changed)，进度被清走", async () => {
        const myDir = mkdtempSync(join(tmpdir(), "fs-digest4-"));
        after(() => rmSync(myDir, { recursive: true, force: true }));
        const path = writeSession(myDir, "moving.jsonl", [{ role: "user", text: "问题" }]);
        const stats = statSync(path);
        const done = Effect.runPromiseExit(buildSessionDigest(path, stats.size, myDir, scriptedDeps(() => "摘要"), MODEL));
        utimesSync(path, new Date(stats.mtimeMs + 5000), new Date(stats.mtimeMs + 5000));
        const result = await done;
        assert.ok(Exit.isFailure(result));
        const failure = Option.getOrUndefined(Cause.failureOption(result.cause));
        assert.equal(failure?._tag, "DigestFileError");
        assert.equal(failure?.stage, "changed");
        assert.equal(readProgressFiles(myDir).filter((p) => p.path === path).length, 0, "进度已清理");
    });
});
const PREFIX_LEN = `行2 用户: `.length;
describe("segmentEntries：临界换行与分片序号", () => {
    it("两条正文恰好压线：含换行成本时必须切段，不含则同段", () => {
        // 每条渲染 3000，两条 = 3000 + 1(换行) + 3000 = 6001 > 6000 → 必须分两段
        const over = [entry(2, "x".repeat(3000 - PREFIX_LEN)), entry(3, "x".repeat(3000 - PREFIX_LEN))];
        assert.equal(segmentEntries(over).length, 2, "压线两条 + 换行应超预算切段");
        // 每条渲染 2999：2999 + 1 + 2999 = 5999 ≤ 6000 → 同段
        const under = [entry(2, "x".repeat(2999 - PREFIX_LEN)), entry(3, "x".repeat(2999 - PREFIX_LEN))];
        assert.equal(segmentEntries(under).length, 1, "未压线两条应同段");
    });
    it("超长消息分片带行号与分片序号标签，渲染成本计入预算", () => {
        const long = "长".repeat(12_000);
        const segments = segmentEntries([entry(2, long)]);
        assert.ok(segments.length >= 2);
        const all = segments.flat();
        assert.ok(all.every((e) => e.partLabel?.includes("第")), "每个分片带序号标签");
        // 分片文本按序拼回原文
        assert.equal(segments.flat().map((e) => e.text).join(""), long, "分片文本拼回原文");
        // 渲染后每段不超过预算
        for (const seg of segments) {
            const rendered = seg.reduce((n, e) => {
                const part = e.partLabel ?? "";
                return n + `行${e.line} 用户${part}: `.length + e.text.length + 1;
            }, -1);
            assert.ok(rendered <= SEGMENT_CHAR_LIMIT, `渲染 ${rendered} 超预算`);
        }
    });
});
describe("mergeSummaries：字符预算分组与输出上限", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-digest5-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    it("段小结各 3000 字符时按字符预算分组，全部分段信息进入最终输入，无模型输入超预算", async () => {
        const calls = [];
        let n = 0;
        const deps = scriptedDeps((system, user) => {
            if (system.includes(SEGMENT_MARKER))
                return `${++n}号段小结：` + "细".repeat(2900);
            if (system.includes(INTERMEDIATE_MARKER))
                return `中间小结(${user.length}入)：主题Y`;
            return "最终摘要：主题Y在场";
        }, calls);
        const messages = Array.from({ length: 150 }, (_, i) => ({ role: "user", text: `消息${i}：${"内容".repeat(1100)}` }));
        const path = writeSession(dir, "budget.jsonl", messages);
        const stats = statSync(path);
        const outcome = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, deps, MODEL));
        for (const c of calls) {
            assert.ok(c.user.length <= MERGE_CHAR_LIMIT, `模型输入 ${c.user.length} 超预算 ${MERGE_CHAR_LIMIT}`);
        }
        const intermediates = calls.filter((c) => c.system.includes(INTERMEDIATE_MARKER));
        assert.ok(intermediates.length >= 2, "长小结应按字符预算拆多组");
        const finalCall = calls.at(-1);
        // 所有组的中间小结都进入最终输入
        for (const it of intermediates) {
            const out = `中间小结(${it.user.length}入)：主题Y`;
            assert.ok(finalCall.user.includes(out), "每个中间小结都在最终输入中");
        }
        assert.ok(outcome.summary.includes("主题Y"));
        void MODEL_OUTPUT_CHAR_LIMIT;
    });
    it("模型忽略字数限制返回超长：DigestModelError 明确失败，不静默截尾", async () => {
        const path = writeSession(dir, "overlong.jsonl", [{ role: "user", text: "问题" }]);
        const stats = statSync(path);
        const greedy = scriptedDeps((system) => system.includes(SEGMENT_MARKER) ? "超".repeat(MODEL_OUTPUT_CHAR_LIMIT + 1) : "摘要");
        const err = await expectFailure(buildSessionDigest(path, stats.size, dir, greedy, MODEL), (e) => {
            const f = e;
            return f._tag === "DigestModelError" && f.cause?.includes("模型输出超长") === true;
        });
        assert.ok(String(err.cause).includes(String(MODEL_OUTPUT_CHAR_LIMIT + 1)));
        // 恰好边界：通过
        const exact = scriptedDeps((system) => system.includes(SEGMENT_MARKER) ? "恰".repeat(MODEL_OUTPUT_CHAR_LIMIT) : "最终摘要");
        const outcome = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, exact, MODEL));
        assert.equal(outcome.summary, "最终摘要");
    });
});
