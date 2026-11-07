import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ensurePiPatch, PATCH_RULES } from "../../patch/ensure-pi-patch.js";
const PI_MAIN_PACKAGE = "@earendil-works/pi-coding-agent";
const BILLION_CONTEXT_PACKAGE = "billion-context-pi";
/** 从本测试文件位置向上找 hapilon 依赖树里的某个包（与补丁模块的解析规则一致） */
function findRepoPackageDir(pkg) {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const candidate = join(dir, "node_modules", pkg);
        if (existsSync(join(candidate, "package.json")))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            throw new Error(`向上找不到 ${pkg}`);
        dir = parent;
    }
}
/**
 * 按补丁表构造最小 fixture 树：每个目标文件只放规则锚点（按 occurrences 重复），
 * bundle chunk 按签名分组各占一个文件。锚点取自规则表字面量，不读安装包。
 * bcContent 覆盖 billion-context 文件的初始内容，用于构造半补丁状态。
 */
function buildFixture(bcContent) {
    const root = mkdtempSync(join(tmpdir(), "hapi-patch-fixture-"));
    const piDir = join(root, "pi-tree", "node_modules", PI_MAIN_PACKAGE);
    const hapilonRoot = join(root, "hap-tree");
    const pkgDirs = new Map();
    const groups = new Map();
    let chunkSeq = 0;
    for (const rule of PATCH_RULES) {
        const pkg = rule.package ?? PI_MAIN_PACKAGE;
        const pkgDir = (rule.base ?? "pi") === "hapilon"
            ? join(hapilonRoot, "node_modules", pkg)
            : pkg === PI_MAIN_PACKAGE ? piDir : join(piDir, "node_modules", pkg);
        pkgDirs.set(pkg, pkgDir);
        const key = `${pkg}::${rule.file}::${rule.signature ?? ""}`;
        const group = groups.get(key) ?? { pkgDir, file: rule.file, signature: rule.signature, parts: [] };
        group.parts.push(Array(rule.occurrences).fill(rule.find).join("\n"));
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        const content = (group.signature ? `${group.signature}\n` : "") + group.parts.join("\n");
        const path = group.signature
            ? join(group.pkgDir, group.file, `chunk-${chunkSeq++}.js`)
            : join(group.pkgDir, group.file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf8");
    }
    for (const pkgDir of pkgDirs.values()) {
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), "{}", "utf8");
    }
    const bcFile = join(hapilonRoot, "node_modules", BILLION_CONTEXT_PACKAGE, "dist", "index.js");
    if (bcContent !== undefined)
        writeFileSync(bcFile, bcContent, "utf8");
    return { root, piDir, hapilonRoot, bcFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
/**
 * 锚点漂移（pi / 上游升级）在启动链上只会打一行警告，容易被忽略；这里把它变成红灯，
 * 强制升级的一方来更新 src/patch/ensure-pi-patch.ts 的锚点。
 * 首跑会把补丁真正写入安装包（与启动链同路径），二跑断言幂等。
 */
test("ensurePiPatch：对本仓库安装的 pi / billion-context 0.1.83 定位成功且锚点不失配，且幂等", () => {
    const first = ensurePiPatch();
    assert.notEqual(first.kind, "pi-not-found", "应当能定位到 node_modules/@earendil-works/pi-coding-agent");
    assert.notEqual(first.kind, "stale", JSON.stringify(first, null, 2));
    assert.notEqual(first.kind, "unwritable", JSON.stringify(first, null, 2));
    assert.equal(ensurePiPatch().kind, "already-patched", "第二次调用必须走已补丁幂等路径");
    // billion-context 两条规则在真实 0.1.83 上的落地形态
    const bc = readFileSync(join(findRepoPackageDir(BILLION_CONTEXT_PACKAGE), "dist", "index.js"), "utf8");
    const reminderLine = bc.split("\n").find((l) => l.includes("If some listed ranges are fully consumed"));
    assert.ok(reminderLine, "温和化压缩提醒应已落盘");
    assert.ok(reminderLine.includes("Leave the active working set untouched. If you compress, fold all chosen ranges in ONE call \\u2014 pass multiple content entries"), "新提醒应接上原句的单次调用参数说明");
    assert.doesNotMatch(reminderLine, /\b(must|required|before answering)\b/i);
    assert.ok(reminderLine.includes("or ONE plain string holding every range") && reminderLine.includes("they reappear in later nudges"), "原句后半的单次调用参数说明应原样保留");
    const stateIdx = bc.indexOf("const hapiNudgeState = { ...io.state, nudge:");
    const decideIdx = bc.indexOf("const nudge = decideNudge({");
    assert.ok(stateIdx !== -1 && decideIdx !== -1 && stateIdx < decideIdx, "无展示戳局部 state 必须构造在 decideNudge 之前");
    assert.ok(bc.includes("state: hapiNudgeState,"), "decideNudge 必须使用无展示戳的局部 state");
    assert.ok(!bc.includes("io.state.nudge.lastNudgeShownTokens = 0;") && !bc.includes("io.state.nudge.lastShownByTier = {};"), "不得直接改写 io.state.nudge（上游为不可变风格）");
});
test("ensurePiPatch（fixture）：两条 billion-context 规则命中、温和措辞精确、局部 state 先于 decideNudge、双 marker 落盘", (t) => {
    const fx = buildFixture();
    t.after(() => fx.cleanup());
    const result = ensurePiPatch({ piDir: fx.piDir, hapilonRoot: fx.hapilonRoot });
    assert.equal(result.kind, "patched");
    if (result.kind !== "patched")
        return;
    assert.ok(result.files.includes(`${BILLION_CONTEXT_PACKAGE}/dist/index.js`), `billion-context 应在补丁文件列表里：${JSON.stringify(result.files)}`);
    const text = readFileSync(fx.bcFile, "utf8");
    const reminderLine = text.split("\n").find((l) => l.includes("If some listed ranges are fully consumed"));
    assert.ok(reminderLine, "温和化压缩提醒未落盘");
    assert.ok(!reminderLine.includes("fold the ranges you keep"), "旧措辞应被替换");
    assert.ok(reminderLine.includes("consider compressing those ranges before continuing. Leave the active working set untouched. If you compress, fold all chosen ranges in ONE call \\u2014 pass multiple content entries"), "新提醒措辞与预期不一致");
    assert.doesNotMatch(reminderLine, /\b(must|required|before answering)\b/i);
    const runIdx = text.indexOf("run(io, ctx) {");
    const stateIdx = text.indexOf("const hapiNudgeState = { ...io.state, nudge:");
    const decideIdx = text.indexOf("const nudge = decideNudge({");
    assert.ok(runIdx !== -1 && runIdx < stateIdx && stateIdx < decideIdx, "局部 state 构造必须插在 run 内、decideNudge 之前");
    const stateArgIdx = text.indexOf("state: hapiNudgeState,");
    assert.ok(stateArgIdx !== -1 && stateArgIdx > decideIdx, "decideNudge 必须使用无展示戳的局部 state");
    assert.ok(!text.includes("io.state.nudge.lastNudgeShownTokens = 0;") && !text.includes("io.state.nudge.lastShownByTier = {};"), "不得直接改写 io.state.nudge（上游为不可变风格）");
    assert.ok(text.includes("hapiNudgeWording") && text.includes("hapiNudgeCooldownReset"), "两个 marker 都应落盘");
});
test("ensurePiPatch（fixture）：重复执行走 already-patched 幂等路径", (t) => {
    const fx = buildFixture();
    t.after(() => fx.cleanup());
    assert.equal(ensurePiPatch({ piDir: fx.piDir, hapilonRoot: fx.hapilonRoot }).kind, "patched");
    assert.equal(ensurePiPatch({ piDir: fx.piDir, hapilonRoot: fx.hapilonRoot }).kind, "already-patched");
});
test("ensurePiPatch（fixture）：单条 billion-context 规则已应用时另一条不被同 marker 短路（双向）", (t) => {
    const wording = PATCH_RULES.find((r) => r.marker === "hapiNudgeWording");
    const reset = PATCH_RULES.find((r) => r.marker === "hapiNudgeCooldownReset");
    assert.ok(wording && reset, "规则表应含两条 billion-context 规则");
    if (!wording || !reset)
        return;
    // 方向 A：冷却重置已在（旧版残留），措辞规则待应用
    {
        const fx = buildFixture(`${wording.find}\n${reset.replace}`);
        t.after(() => fx.cleanup());
        assert.equal(ensurePiPatch({ piDir: fx.piDir, hapilonRoot: fx.hapilonRoot }).kind, "patched");
        const text = readFileSync(fx.bcFile, "utf8");
        assert.ok(text.includes("hapiNudgeWording"), "措辞规则应被独立应用");
        assert.equal(text.split("hapiNudgeCooldownReset").length - 1, 1, "已应用的冷却重置不得重复插入");
        assert.equal(text.split("const hapiNudgeState = { ...io.state, nudge:").length - 1, 1);
        assert.ok(!text.includes("io.state.nudge.lastNudgeShownTokens = 0;") && !text.includes("io.state.nudge.lastShownByTier = {};"));
        assert.ok(!text.includes("fold the ranges you keep"));
    }
    // 方向 B：措辞已在，冷却重置待应用
    {
        const fx = buildFixture(`${wording.replace}\n${reset.find}`);
        t.after(() => fx.cleanup());
        assert.equal(ensurePiPatch({ piDir: fx.piDir, hapilonRoot: fx.hapilonRoot }).kind, "patched");
        const text = readFileSync(fx.bcFile, "utf8");
        assert.ok(text.includes("hapiNudgeCooldownReset"), "冷却重置应被独立应用");
        assert.equal(text.split("hapiNudgeWording").length - 1, 1);
        const stateIdx = text.indexOf("const hapiNudgeState = { ...io.state, nudge:");
        const decideIdx = text.indexOf("const nudge = decideNudge({");
        assert.ok(stateIdx !== -1 && stateIdx < decideIdx);
        assert.ok(text.includes("state: hapiNudgeState,") && !text.includes("state: io.state,"));
    }
});
test("ensurePiPatch（fixture）：billion-context 锚点失配 → stale 且整体不落盘", (t) => {
    const fx = buildFixture();
    t.after(() => fx.cleanup());
    const pristine = readFileSync(fx.bcFile, "utf8");
    writeFileSync(fx.bcFile, pristine.replace("var nudgeNode = {", "var nudgeNodeRenamed = {"), "utf8");
    const result = ensurePiPatch({ piDir: fx.piDir, hapilonRoot: fx.hapilonRoot });
    assert.equal(result.kind, "stale");
    if (result.kind !== "stale")
        return;
    assert.ok(result.problems.some((p) => p.includes(`${BILLION_CONTEXT_PACKAGE}/dist/index.js`) && p.includes("锚点出现 0 次（期望 1）")), JSON.stringify(result.problems));
    const after = readFileSync(fx.bcFile, "utf8");
    assert.ok(!after.includes("hapiNudgeWording") && !after.includes("hapiNudgeCooldownReset"), "任一锚点失配时整个补丁不得写入文件");
});
