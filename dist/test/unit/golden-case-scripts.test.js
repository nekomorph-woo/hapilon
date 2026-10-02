// golden-case 判卷/审计脚本的活体回归：判卷器是金标体系的信任核心，脚本改坏必须被 test:unit 拦住。
// 被测对象是 resources/skills/golden-case/scripts/ 下的 .mjs（不参与 tsc 编译），故一律
// 按真实调用方式起子进程跑 CLI，断言落在退出码与产物上——不是读源码猜行为。
// 覆盖：operator 判定内核（含 fail-closed 与 v1 派生兼容）、freeze-check 红牌、
// audit 三类异常、yaml-lite 对不可判定期望的拒判。固定数据全部本文件内联，不依赖任何外部目录。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// dist/test/unit/ → 仓库根 → resources/...
const SCRIPTS = fileURLToPath(new URL("../../../resources/skills/golden-case/scripts", import.meta.url));
function runScript(script, args) {
    const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
// 临时工作区：每个用例自带，跑完即删，互不干扰
function withTmp(fn) {
    const dir = mkdtempSync(join(tmpdir(), "gce-scripts-"));
    try {
        return fn(dir);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
// 跑 explorer 并从产物 HTML 里读回数据模型：判定内核没导出（explorer.mjs 是 CLI），
// 且真正要保证的是「写进 YAML 的 operator 一路走到视图里的 status/message」。
function explorerModel(dir, cases, runs, frozen) {
    const casesPath = join(dir, "cases.yaml");
    const outPath = join(dir, "case-explorer.html");
    writeFileSync(casesPath, cases);
    const args = ["--cases", casesPath, "--title", "回归", "--out", outPath];
    if (runs) {
        const runsPath = join(dir, "runs.json");
        writeFileSync(runsPath, JSON.stringify(runs));
        args.push("--runs", runsPath);
    }
    if (frozen !== undefined) {
        const frozenPath = join(dir, "frozen.md");
        writeFileSync(frozenPath, frozen);
        args.push("--frozen", frozenPath);
    }
    const r = runScript("explorer.mjs", args);
    assert.equal(r.status, 0, `explorer 应正常退出：${r.stderr}`);
    const html = readFileSync(outPath, "utf8");
    const m = html.match(/<script>const DATA = ([\s\S]*?)<\/script>/);
    assert.ok(m, "产物 HTML 里应有内联的 DATA");
    return JSON.parse(m[1].replace(/;\s*$/, "")).cases;
}
// format.md 的真实示例块：文档改坏（字段拼接、快照与主示例冲突）在这里红——不保留手抄副本
const FORMAT_MD = join(SCRIPTS, "..", "references", "format.md");
function fencedYamlAfter(doc, heading) {
    const section = doc.split(heading)[1];
    assert.ok(section, `format.md 应有 ${heading} 小节`);
    const m = section.match(/```(?:yaml)?\n([\s\S]*?)```/);
    assert.ok(m, `${heading} 之后应有 fenced block`);
    return m[1];
}
function docCaseYaml() {
    return fencedYamlAfter(readFileSync(FORMAT_MD, "utf8"), /^## Case schema$/m);
}
function docFrozenYaml() {
    return fencedYamlAfter(readFileSync(FORMAT_MD, "utf8"), /\*\*v3 structured snapshot\*\*/m);
}
async function docCase() {
    const { parseYaml } = (await import(pathToFileURL(join(SCRIPTS, "yaml-lite.mjs")).href));
    const doc = parseYaml(docCaseYaml());
    const c = doc.cases[0];
    assert.equal(c.id, "CASE-005");
    return c;
}
const OPERATOR_CASES = `cases:
  - id: CASE-101
    name: operator 矩阵
    observe: [ge_pass]
    expect:
      ge_pass: 7
    verification_points:
      - {id: VP-001, name: ">= 达标", source: ge_pass, operator: ">=", expected: 5}
      - {id: VP-002, name: ">= 不达标", source: ge_fail, operator: ">=", expected: 5}
      - {id: VP-003, name: "<= 达标（等于边界）", source: le_pass, operator: "<=", expected: 10}
      - {id: VP-004, name: "> 达标", source: gt_pass, operator: ">", expected: 3}
      - {id: VP-005, name: "< 达标", source: lt_pass, operator: "<", expected: 3}
      - {id: VP-006, name: "!= 达标", source: ne_pass, operator: "!=", expected: 1}
      - {id: VP-007, name: "!= 不达标（相等）", source: ne_fail, operator: "!=", expected: 1}
      - {id: VP-008, name: ">= 文本小数期望", source: ge_decimal, operator: ">=", expected: 74.8}
      - {id: VP-009, name: ">= 遇非数值（fail-closed）", source: nonnum, operator: ">=", expected: 5}
      - {id: VP-010, name: "未知 operator（fail-closed）", source: unknown_op, operator: "~=", expected: 1}
      - {id: VP-011, name: "空 operator 按 ==", source: empty_op, operator: "", expected: 8}
      - {id: VP-012, name: "== 与 >= 差分（同为 7 vs 5）", source: eq_fail, operator: "==", expected: 5}

  - id: CASE-102
    name: v1 派生路径（无 verification_points）
    observe: [ok_count, ok_state, ok_decimal]
    expect:
      ok_count: 1
      ok_state: PAID
      ok_decimal: 74.8

  - id: CASE-103
    name: v1 派生路径的 == 仍能判 FAIL
    observe: [mismatch]
    expect:
      mismatch: 2
`;
const OPERATOR_RUNS = {
    _meta: { source: "golden-case-scripts.test.ts 合成", captured: "2026-09-19 18:00" },
    "CASE-101:ge_pass": 7,
    "CASE-101:ge_fail": 3,
    "CASE-101:le_pass": 10,
    "CASE-101:gt_pass": 4,
    "CASE-101:lt_pass": 2,
    "CASE-101:ne_pass": 2,
    "CASE-101:ne_fail": 1,
    "CASE-101:ge_decimal": 80,
    "CASE-101:nonnum": "success",
    "CASE-101:unknown_op": 1,
    "CASE-101:empty_op": 8,
    "CASE-101:eq_fail": 7,
    "CASE-102:ok_count": 1,
    "CASE-102:ok_state": "PAID",
    "CASE-102:ok_decimal": 74.8,
    "CASE-103:mismatch": 3,
};
const OPERATOR_EXPECTED = {
    "VP-001": "PASS",
    "VP-002": "FAIL",
    "VP-003": "PASS",
    "VP-004": "PASS",
    "VP-005": "PASS",
    "VP-006": "PASS",
    "VP-007": "FAIL",
    "VP-008": "PASS",
    "VP-009": "FAIL",
    "VP-010": "FAIL",
    "VP-011": "PASS",
    "VP-012": "FAIL",
};
function operatorRun() {
    const cases = withTmp((dir) => explorerModel(dir, OPERATOR_CASES, OPERATOR_RUNS));
    return { byId: new Map(cases.map((c) => [c.id, c])) };
}
const operatorCache = operatorRun();
const vpOf = (caseId, vpId) => {
    const c = operatorCache.byId.get(caseId);
    assert.ok(c, `缺少 ${caseId}`);
    const vp = c.vps.find((v) => v.id === vpId);
    assert.ok(vp, `缺少 ${vpId}`);
    return vp;
};
describe("golden-case · explorer 的 VP operator 判定", () => {
    it("六个承诺的比较符全部真生效（含边界相等与保文本小数）", () => {
        for (const [id, status] of Object.entries(OPERATOR_EXPECTED)) {
            const vp = vpOf("CASE-101", id);
            assert.equal(vp.status, status, `${id}（${vp.operator} ${String(vp.expected)} vs 实际 ${String(vp.actual)}）`);
        }
    });
    it("`>=` 与 `==` 是差分判定：同一对值，>= 过而 == 不过", () => {
        assert.equal(vpOf("CASE-101", "VP-001").status, "PASS", "7 >= 5");
        assert.equal(vpOf("CASE-101", "VP-012").status, "FAIL", "7 == 5 必须 FAIL——不得被当成 >= 放行");
    });
    it("非数值遇有序比较：fail-closed，且 message 说明无法比较", () => {
        const vp = vpOf("CASE-101", "VP-009");
        assert.equal(vp.status, "FAIL");
        assert.match(vp.message, /非数值/);
        assert.match(vp.message, />=/);
    });
    it("未知 operator：fail-closed，message 点名该符号（不静默当 ==）", () => {
        const vp = vpOf("CASE-101", "VP-010");
        assert.equal(vp.status, "FAIL");
        assert.match(vp.message, /未知 operator/);
        assert.match(vp.message, /~=/);
    });
    it("case 级判定由 VP 聚合：有 FAIL 即 FAIL，并给出首失败 VP 列表", () => {
        const run = operatorCache.byId.get("CASE-101")?.run;
        assert.ok(run, "CASE-101 应有 run");
        assert.equal(run.status, "FAIL");
        assert.deepEqual(run.fail.sort(), ["VP-002", "VP-007", "VP-009", "VP-010", "VP-012"]);
        assert.equal(run.ok, 7, "12 个 VP 里 5 个 FAIL → 通过 7 个");
    });
});
describe("golden-case · v1 派生路径零变化", () => {
    it("派生 VP 的 operator 恒为 ==、带 derived 标记，判定行为不变（全 PASS / 有错即 FAIL）", () => {
        const derived = operatorCache.byId.get("CASE-102");
        assert.ok(derived);
        assert.equal(derived.vps.length, 3);
        assert.deepEqual(derived.vps.map((v) => v.operator), ["==", "==", "=="]);
        assert.deepEqual(derived.vps.map((v) => v.status), ["PASS", "PASS", "PASS"]);
        assert.equal(derived.vps[0].derived, true, "派生 VP 必须带 derived 标记");
        assert.equal(derived.run?.status, "PASS");
        const mismatch = operatorCache.byId.get("CASE-103");
        assert.ok(mismatch);
        assert.equal(mismatch.vps[0].operator, "==");
        assert.equal(mismatch.vps[0].status, "FAIL");
        assert.equal(mismatch.run?.status, "FAIL");
    });
});
describe("golden-case · freeze-check 守门", () => {
    const CASES = `cases:
  - id: CASE-003
    name: 含税总价
    observe: [checkpoint_a_price, checkpoint_c_total]
    expect:
      checkpoint_a_price: 88.0
      checkpoint_c_total: 76.8
`;
    const FROZEN = `# 冻结清单（需求方确认）
frozen:
  CASE-003:
    checkpoint_a_price: 88.0
    checkpoint_c_total: 74.8
  CASE-005:
    total_charged_for_payment: 74.8
`;
    it("对「偷改期望 + 删 case」的作弊件抓红牌：改值 CHANGED + 缺失 CASE-MISSING，exit 1", () => {
        const r = withTmp((dir) => {
            const casesPath = join(dir, "cases.yaml");
            const frozenPath = join(dir, "frozen.md");
            writeFileSync(casesPath, CASES);
            writeFileSync(frozenPath, FROZEN);
            return runScript("freeze-check.mjs", ["--cases", casesPath, "--frozen", frozenPath]);
        });
        assert.equal(r.status, 1, `命中红牌必须 exit 1：${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /CASE-003:checkpoint_c_total \[CHANGED\]/);
        assert.match(r.stdout, /74\.8/);
        assert.match(r.stdout, /CASE-005:[^\n]*\[CASE-MISSING\]/);
        const cards = r.stdout.split("\n").filter((l) => /\[(CHANGED|KEY-REMOVED|CASE-MISSING)\]/.test(l));
        assert.equal(cards.length, 2, `应恰好两张红牌：\n${r.stdout}`);
    });
    it("期望未被改动时不误报：exit 0 全绿", () => {
        const r = withTmp((dir) => {
            const casesPath = join(dir, "cases.yaml");
            const frozenPath = join(dir, "frozen.md");
            writeFileSync(casesPath, CASES.replace("checkpoint_c_total: 76.8", "checkpoint_c_total: 74.8"));
            writeFileSync(frozenPath, FROZEN.replace(/\n  CASE-005:\n    total_charged_for_payment: 74\.8\n/, ""));
            return runScript("freeze-check.mjs", ["--cases", casesPath, "--frozen", frozenPath]);
        });
        assert.equal(r.status, 0, `无改动应全绿：${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /🟢 全绿/);
    });
});
describe("golden-case · audit 覆盖对账", () => {
    const CASES = `cases:
  - id: CASE-101
    name: 有主 case
    expect:
      total: 88.0
  - id: CASE-102
    name: 无主 case（没进测试代码）
    expect:
      ok_state: PAID
`;
    // 一个文件同时触发三类：无源锚 CASE-999、无主 CASE-102、断言行写死 CASE-101 的金标 88.0
    const ADAPTER = `// CASE-999 锚点指向不存在的 case
@Test
void paysWithCoupon() {
  // CASE-101 支付链路
  assertThat(result.total()).isEqualTo(88.0);
}
`;
    it("坏样例三类异常一次报全：UNOWNED / ORPHAN / LITERAL，exit 1", () => {
        const r = withTmp((dir) => {
            const casesPath = join(dir, "cases.yaml");
            const testsDir = join(dir, "tests");
            mkdirSync(testsDir);
            writeFileSync(casesPath, CASES);
            writeFileSync(join(testsDir, "CouponTest.java"), ADAPTER);
            return runScript("audit.mjs", ["--cases", casesPath, "--tests", testsDir]);
        });
        assert.equal(r.status, 1, `有异常必须 exit 1：${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /无主 case/);
        assert.match(r.stdout, /CASE-102/);
        assert.match(r.stdout, /无源 test/);
        assert.match(r.stdout, /CASE-999/);
        assert.match(r.stdout, /期望字面量嫌疑/);
        assert.match(r.stdout, /CASE-101:total = 88/);
    });
    it("锚点齐、断言从 case 加载时不误报：exit 0", () => {
        const r = withTmp((dir) => {
            const casesPath = join(dir, "cases.yaml");
            const testsDir = join(dir, "tests");
            mkdirSync(testsDir);
            writeFileSync(casesPath, CASES);
            writeFileSync(join(testsDir, "CouponTest.java"), "// CASE-101 CASE-102 都引用\nassertThat(got).isEqualTo(c.total);\n");
            return runScript("audit.mjs", ["--cases", casesPath, "--tests", testsDir]);
        });
        assert.equal(r.status, 0, `无异常应 exit 0：${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /🟢 审计通过/);
    });
});
// 判定内核模块（explorer 与 freeze-check 共用），直接 import 断言其拒判语义
const yamlLite = (await import(pathToFileURL(join(SCRIPTS, "yaml-lite.mjs")).href));
describe("golden-case · yaml-lite 对不可判定期望的拒判", () => {
    it("描述性字符串判为不可判定；数值、纯 ASCII 标识、保文本小数仍可判定", () => {
        assert.equal(yamlLite.isUndecidable("余额扣得正确，用户体验良好"), true);
        assert.equal(yamlLite.isUndecidable("user experience good"), true, "含空白 = 描述");
        assert.equal(yamlLite.isUndecidable(74.8), false);
        assert.equal(yamlLite.isUndecidable("74.8"), false);
        assert.equal(yamlLite.isUndecidable("PAID"), false);
        assert.equal(yamlLite.numEq("74.8", 74.8), true, "保文本小数按数值比");
    });
    it("中文常量期望照常判（bad 只作 UI 提示），真描述会字面 FAIL 而非跳过", () => {
        const CASES = `cases:
  - id: CASE-201
    name: 期望里混了一句中文常量
    observe: [mood, stock_after]
    expect:
      mood: 余额扣得正确，用户体验良好
      stock_after: 2

  - id: CASE-202
    name: 期望全是中文常量
    observe: [mood]
    expect:
      mood: 余额扣得正确，用户体验良好

  - id: CASE-203
    name: 真写成了描述
    observe: [mood]
    expect:
      mood: 余额扣得正确，用户体验良好
`;
        const cases = withTmp((dir) => explorerModel(dir, CASES, {
            "CASE-201:mood": "余额扣得正确，用户体验良好",
            "CASE-201:stock_after": 2,
            "CASE-202:mood": "余额扣得正确，用户体验良好",
            "CASE-203:mood": "余额扣错了 3 元",
        }));
        const c = cases[0];
        assert.equal(c.vps[0].bad, true, "中文常量标 bad 供 UI 提示");
        assert.equal(c.vps[1].bad, false);
        assert.equal(c.health, "BROKEN", "含 bad 期望的 case 健康度仍提示 BROKEN");
        assert.ok(c.run);
        assert.deepEqual(c.run.results.map((r) => r.vp_id), ["VP-001", "VP-002"], "bad VP 照常判定，不排除出判定结果");
        assert.equal(c.run.results[0].status, "PASS", "中文常量按字面相等判");
        assert.equal(c.run.status, "PASS");
        const all = cases[1];
        assert.equal(all.vps[0].bad, true);
        assert.equal(all.run?.status, "PASS", "全 bad 也照判：相等即 PASS");
        const described = cases[2];
        assert.equal(described.run?.results[0].status, "FAIL", "真描述与实测不等 → 字面 FAIL（fail-closed，不静默跳过）");
        assert.equal(described.run?.status, "FAIL");
    });
});
describe("golden-case · report 聚合（文本与 JUnit XML 双路径）", () => {
    // 最小 case 集两个 case：覆盖 pass / fail / skip / 部分缺失 / --only 圈子集
    const CASES = `cases:
  - id: CASE-301
    name: 聚合夹具
    observe: [alpha, beta, gamma]
    expect:
      alpha: 1
      beta: 2
      gamma: 3
  - id: CASE-302
    name: 圈子集夹具
    observe: [delta, epsilon]
    expect:
      delta: 4
      epsilon: 5
`;
    function runReport(dir, outputs) {
        const casesPath = join(dir, "cases.yaml");
        writeFileSync(casesPath, CASES);
        const outs = outputs.map((text, i) => {
            const p = join(dir, `out${i}.txt`);
            writeFileSync(p, text);
            return p;
        });
        const r = runScript("report.mjs", ["--cases", casesPath, ...outs]);
        return { code: r.status, stdout: r.stdout };
    }
    it("vitest/jest verbose 符号行：✓/×/○ 分别聚合为 PASSED/FAILED/SKIPPED", () => {
        const out = [
            " ✓ tests/shop.test.ts > CASE-301:alpha 3ms",
            "   ✓ CASE-301:gamma (5 ms)",
            " × tests/shop.test.ts > CASE-301:beta 4ms",
        ].join("\n");
        const { code, stdout } = withTmp((dir) => runReport(dir, [out]));
        assert.match(stdout, /✓ alpha/);
        assert.match(stdout, /✗ beta/);
        assert.match(stdout, /✓ gamma/);
        assert.equal(code, 1, "有 FAILED 锤必须退出非零");
    });
    it("JUnit XML：vitest --reporter=junit 形态，failure 正文进详情，skipped 自闭合", () => {
        const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<testsuites name="vitest">',
            '<testsuite name="tests/shop.test.ts">',
            '<testcase classname="tests/shop.test.ts" name="CASE-301:alpha" time="0.003"/>',
            '<testcase classname="tests/shop.test.ts" name="CASE-301:beta" time="0.004">',
            '<failure message="expected 2 to be 7">AssertionError: expected 2 to be 7</failure>',
            '</testcase>',
            '<testcase classname="tests/shop.test.ts" name="CASE-301:gamma" time="0.001">',
            '<skipped/>',
            '</testcase>',
            '</testsuite>',
            '</testsuites>',
        ].join("\n");
        const { code, stdout } = withTmp((dir) => runReport(dir, [xml]));
        assert.match(stdout, /✓ alpha/);
        assert.match(stdout, /✗ beta/);
        assert.match(stdout, /AssertionError: expected 2 to be 7/, "failure 正文应作为详情呈现");
        assert.match(stdout, /○ gamma/);
        assert.equal(code, 1);
    });
    it("全量全绿退出 0；部分缺失 fail-closed 不再算绿；--only 圈子集后只对声明负责", () => {
        const full = [
            " ✓ CASE-301:alpha", " ✓ CASE-301:beta", " ✓ CASE-301:gamma",
            " ✓ CASE-302:delta", " ✓ CASE-302:epsilon",
        ].join("\n");
        const { code } = withTmp((dir) => runReport(dir, [full]));
        assert.equal(code, 0, "全量全绿 = 0");
        // fail-closed：301 只跑出 alpha，缺的两个观察点是未判定，不得计入通过
        const partial = " ✓ CASE-301:alpha\n";
        const { code: code2, stdout: stdout2 } = withTmp((dir) => runReport(dir, [partial]));
        assert.equal(code2, 1, "部分缺失必须非零——未判定 ≠ 通过");
        assert.match(stdout2, /未在输出中发现/);
        // 故意子集：--only 声明后只对 301 负责，302 不进统计也不被当无源锚
        const onlyOut = " ✓ CASE-301:alpha\n ✓ CASE-301:beta\n ✓ CASE-301:gamma\n ✓ CASE-302:delta\n";
        const { status: code3, stdout: stdout3 } = withTmp((dir) => {
            const casesPath = join(dir, "cases.yaml");
            writeFileSync(casesPath, CASES);
            const p = join(dir, "out.txt");
            writeFileSync(p, onlyOut);
            return runScript("report.mjs", ["--cases", casesPath, "--only", "CASE-301", p]);
        });
        assert.equal(code3, 0, "声明范围内全绿 = 0");
        assert.doesNotMatch(stdout3, /CASE-302/);
        // 声明了不存在的 case id：直接报错而非静默忽略（拼写错误否则变回假绿）
        const bad = withTmp((dir) => {
            const casesPath = join(dir, "cases.yaml");
            writeFileSync(casesPath, CASES);
            const p = join(dir, "out.txt");
            writeFileSync(p, full);
            return runScript("report.mjs", ["--cases", casesPath, "--only", "CASE-999", p]);
        });
        assert.equal(bad.status, 2);
        assert.match(bad.stderr, /CASE-999/);
    });
});
// ── v3 durable provenance：case 业务依据 + v3 结构化快照 ──
const V3_CASES = `cases:
  - id: CASE-005
    version: 1
    name: 支付重放
    observe: [charge_count_P5, total_charged]
    expect:
      charge_count_P5: 1
      total_charged: 74.8
    business_basis:
      - id: BASIS-001
        kind: USER_CONFIRMATION
        statement: 同一支付单最多成功一次
        reference: conversation:msg-17
        excerpt: 同一个 payment_id 重试不能再次扣款
        confirmed_by: 需求方
        confirmed_on: 2026-09-27
      - id: BASIS-002
        kind: DERIVATION
        statement: 总扣款等于单价乘成功次数
        based_on: [BASIS-001]
        expression: 74.8 * charge_count_P5
        confirmed_by: 需求方
        confirmed_on: 2026-09-27
    expect_basis:
      charge_count_P5: [BASIS-001]
      total_charged: [BASIS-002]
`;
const v3Frozen = (basis1 = "statement: 同一支付单最多成功一次") => `frozen:
  CASE-005:
    version: 1
    expect:
      charge_count_P5: 1
      total_charged: 74.8
    expect_basis:
      charge_count_P5: [BASIS-001]
      total_charged: [BASIS-002]
    business_basis:
      - {id: BASIS-001, kind: USER_CONFIRMATION, ${basis1}, reference: conversation:msg-17, excerpt: 同一个 payment_id 重试不能再次扣款, confirmed_by: 需求方, confirmed_on: 2026-09-27}
      - {id: BASIS-002, kind: DERIVATION, statement: 总扣款等于单价乘成功次数, based_on: [BASIS-001], expression: 74.8 * charge_count_P5, confirmed_by: 需求方, confirmed_on: 2026-09-27}
`;
function runFreeze(dir, casesYaml, frozenYaml) {
    const casesPath = join(dir, "cases.yaml");
    const frozenPath = join(dir, "frozen.md");
    writeFileSync(casesPath, casesYaml);
    writeFileSync(frozenPath, frozenYaml);
    return runScript("freeze-check.mjs", ["--cases", casesPath, "--frozen", frozenPath]);
}
describe("golden-case · v3 durable provenance（freeze-check）", () => {
    it("完整 v3 case + v3 快照全绿 exit 0", () => {
        const r = withTmp((dir) => runFreeze(dir, V3_CASES, v3Frozen()));
        assert.equal(r.status, 0, `应全绿：${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /全绿/);
    });
    it("依据 statement 被改 → BASIS-CHANGED exit 1", () => {
        const r = withTmp((dir) => runFreeze(dir, V3_CASES.replace("同一支付单最多成功一次", "同一支付单最多成功两次"), v3Frozen()));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /CASE-005:BASIS-001 \[BASIS-CHANGED\]/);
    });
    it("expect 被改绑到别的依据 → BASIS-REBIND exit 1", () => {
        const r = withTmp((dir) => runFreeze(dir, V3_CASES.replace("total_charged: [BASIS-002]", "total_charged: [BASIS-001]"), v3Frozen()));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /CASE-005:total_charged \[BASIS-REBIND\]/);
    });
    it("依据被删 → BASIS-REMOVED exit 1", () => {
        const r = withTmp((dir) => runFreeze(dir, V3_CASES.replace(/\n {6}- id: BASIS-002[\s\S]*?confirmed_on: 2026-09-27/, "")
            .replace("total_charged: [BASIS-002]", "total_charged: [BASIS-001]"), v3Frozen()));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /CASE-005:BASIS-002 \[BASIS-REMOVED\]/);
    });
    it("v3 case 用旧式快照 → BASIS-NOT-FROZEN（不许报全绿）", () => {
        const r = withTmp((dir) => runFreeze(dir, V3_CASES, "frozen:\n  CASE-005:\n    charge_count_P5: 1\n    total_charged: 74.8\n"));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /CASE-005:— \[BASIS-NOT-FROZEN\]/);
    });
    it("provenance 不完整（期望未绑依据）→ BASIS-INCOMPLETE exit 1", () => {
        const r = withTmp((dir) => runFreeze(dir, V3_CASES.replace("      total_charged: [BASIS-002]\n", ""), v3Frozen()));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /CASE-005:total_charged \[BASIS-INCOMPLETE\]/);
    });
    it("derivation 引用不存在的 basis 与循环依赖 → BASIS-INVALID exit 1", () => {
        const unknown = withTmp((dir) => runFreeze(dir, V3_CASES.replace("based_on: [BASIS-001]", "based_on: [BASIS-999]"), v3Frozen()));
        assert.equal(unknown.status, 1);
        assert.match(unknown.stdout, /BASIS-INVALID/);
        assert.match(unknown.stdout, /BASIS-999/);
        const cyc = V3_CASES
            .replace("based_on: [BASIS-001]", "based_on: [BASIS-000]")
            .replace("    expect_basis:", `      - id: BASIS-000
        kind: DERIVATION
        statement: 环
        based_on: [BASIS-002]
        expression: x
        confirmed_by: 需求方
        confirmed_on: 2026-09-27
    expect_basis:`);
        const cyclic = withTmp((dir) => runFreeze(dir, cyc, v3Frozen() + "      - {id: BASIS-000, kind: DERIVATION, statement: 环, based_on: [BASIS-002], expression: x, confirmed_by: 需求方, confirmed_on: 2026-09-27}\n"));
        assert.equal(cyclic.status, 1);
        assert.match(cyclic.stdout, /依赖成环/);
    });
    it("旧式 case + 旧式快照仍按原语义红牌/全绿（v3 不改变 v1/v2 行为）", () => {
        const CASES = "cases:\n  - id: CASE-003\n    name: 含税总价\n    observe: [t]\n    expect:\n      t: 76.8\n";
        const ok = withTmp((dir) => runFreeze(dir, CASES, "frozen:\n  CASE-003:\n    t: 76.8\n"));
        assert.equal(ok.status, 0);
        const drift = withTmp((dir) => runFreeze(dir, CASES, "frozen:\n  CASE-003:\n    t: 74.8\n"));
        assert.equal(drift.status, 1);
        assert.match(drift.stdout, /\[CHANGED\]/);
    });
    it("legacy 快照里恰好有个叫 version 的期望键：仍按 legacy 比较，不误判 v3", () => {
        const CASES = "cases:\n  - id: CASE-003\n    name: 含税总价\n    observe: [version, t]\n    expect:\n      version: 3\n      t: 76.8\n";
        const ok = withTmp((dir) => runFreeze(dir, CASES, "frozen:\n  CASE-003:\n    version: 3\n    t: 76.8\n"));
        assert.equal(ok.status, 0, `不该误报 BASIS-VERSION：${ok.stdout}${ok.stderr}`);
        const drift = withTmp((dir) => runFreeze(dir, CASES, "frozen:\n  CASE-003:\n    version: 3\n    t: 74.8\n"));
        assert.equal(drift.status, 1);
        assert.match(drift.stdout, /CASE-003:t \[CHANGED\]/);
    });
    it("case 只有完整 business_basis、缺 expect_basis：受控 BASIS-INCOMPLETE，无 TypeError", () => {
        const r = withTmp((dir) => {
            const casesYaml = V3_CASES.replace(/    expect_basis:[\s\S]*$/, "");
            return runFreeze(dir, casesYaml, "frozen:\n  CASE-005:\n    version: 1\n    expect:\n      charge_count_P5: 1\n      total_charged: 74.8\n    business_basis:\n      - {id: BASIS-001, kind: USER_CONFIRMATION, statement: 同一支付单最多成功一次, reference: conversation:msg-17, excerpt: 原文, confirmed_by: 需求方, confirmed_on: 2026-09-27}\n");
        });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.doesNotMatch(r.stdout + r.stderr, /TypeError/);
        assert.match(r.stdout, /BASIS-(INCOMPLETE|INVALID)/);
    });
    it("容器坏形（business_basis 非列表 / 空列表 / expect_basis 非映射 / 只声明一边）：受控红牌", () => {
        const head = "cases:\n  - id: CASE-005\n    version: 1\n    name: 支付重放\n    observe: [charge_count_P5]\n    expect:\n      charge_count_P5: 1\n";
        const bb = "    business_basis:\n      - {id: BASIS-001, kind: USER_CONFIRMATION, statement: 同一支付单最多成功一次, excerpt: 原文, confirmed_by: 需求方, confirmed_on: 2026-09-27}\n";
        const eb = "    expect_basis:\n      charge_count_P5: [BASIS-001]\n";
        const frozen = "frozen:\n  CASE-005:\n    version: 1\n    expect:\n      charge_count_P5: 1\n";
        for (const [casesYaml, tag] of [
            [head + "    business_basis:\n      not_a_list: true\n" + eb, /business_basis 不是列表/],
            [head + "    business_basis: []\n" + eb, /business_basis 是空列表/],
            [head + bb + "    expect_basis: [BASIS-001]\n", /expect_basis 不是映射/],
            [head + bb + frozen + "    business_basis:\n      - {id: BASIS-001, kind: USER_CONFIRMATION, statement: 同一支付单最多成功一次, excerpt: 原文, confirmed_by: 需求方, confirmed_on: 2026-09-27}\n", /只声明了一边/],
        ]) {
            const r = withTmp((dir) => runFreeze(dir, casesYaml, frozen));
            assert.equal(r.status, 1, `应红牌：${tag}`);
            assert.match(r.stdout, tag);
            assert.doesNotMatch(r.stdout + r.stderr, /TypeError/);
        }
    });
    it("v3 快照缺 version：BASIS-VERSION，不把 expect/expect_basis/business_basis 当期望键报 KEY-REMOVED", () => {
        const r = withTmp((dir) => runFreeze(dir, V3_CASES, v3Frozen().replace("    version: 1\n", "")));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /BASIS-VERSION/);
        for (const key of ["expect", "expect_basis", "business_basis"]) {
            assert.doesNotMatch(r.stdout, new RegExp(`${key} \\[(KEY-REMOVED|CHANGED)\\]`), key);
        }
    });
    it("DERIVATION based_on 为空数组或标量：exit 1，Explorer 同步报问题", () => {
        const empty = withTmp((dir) => runFreeze(dir, V3_CASES.replace("based_on: [BASIS-001]", "based_on: []"), v3Frozen().replace("based_on: [BASIS-001]", "based_on: []")));
        assert.equal(empty.status, 1);
        assert.match(empty.stdout, /based_on 必须是非空数组/);
        const scalar = withTmp((dir) => runFreeze(dir, V3_CASES.replace("based_on: [BASIS-001]", "based_on: BASIS-001"), v3Frozen().replace("based_on: [BASIS-001]", "based_on: BASIS-001")));
        assert.equal(scalar.status, 1);
        assert.match(scalar.stdout, /based_on 必须是非空数组/);
        const cases = withTmp((dir) => explorerModel(dir, V3_CASES.replace("based_on: [BASIS-001]", "based_on: []")));
        assert.match(cases[0].prov_issues.join("\n"), /based_on 必须是非空数组/);
        assert.equal(cases[0].business_basis.find((b) => b.id === "BASIS-002").incomplete, true);
    });
    it("basis id 不符合 BASIS-数字 格式：exit 1，Explorer 同步报问题", () => {
        const r = withTmp((dir) => runFreeze(dir, V3_CASES.replace(/BASIS-002/g, "DEP-2"), v3Frozen().replace(/BASIS-002/g, "DEP-2")));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /basis id 非法/);
        const cases = withTmp((dir) => explorerModel(dir, V3_CASES.replace(/BASIS-002/g, "DEP-2")));
        assert.match(cases[0].prov_issues.join("\n"), /basis id 非法/);
    });
    it("Explorer 对坏形容器报显式问题（不只靠未绑定侧面提示）", () => {
        const head = "cases:\n  - id: CASE-005\n    version: 1\n    name: 支付重放\n    observe: [charge_count_P5]\n    expect:\n      charge_count_P5: 1\n";
        const emptyList = withTmp((dir) => explorerModel(dir, head + "    business_basis: []\n    expect_basis:\n      charge_count_P5: [BASIS-001]\n"));
        assert.match(emptyList[0].prov_issues.join("\n"), /business_basis 是空列表/);
        const notMap = withTmp((dir) => explorerModel(dir, head + "    expect_basis: [BASIS-001]\n"));
        assert.match(notMap[0].prov_issues.join("\n"), /expect_basis 不是映射/);
        const oneSided = withTmp((dir) => explorerModel(dir, head +
            "    business_basis:\n      - {id: BASIS-001, kind: USER_CONFIRMATION, statement: 同一支付单最多成功一次, excerpt: 原文, confirmed_by: 需求方, confirmed_on: 2026-09-27}\n"));
        assert.match(oneSided[0].prov_issues.join("\n"), /只声明了一边/);
    });
    // 不再保留手写 frozen 副本——直接从 format.md 提取 **v3 structured snapshot** 后的真实块，
    // 文档改了测试就跟着变，文档示例与门禁漂移在这里显眼地红。
    it("format.md 的 v3 快照样例（真实文档块）可被 yaml-lite 解析且覆盖主示例", async () => {
        const { parseYaml } = (await import(pathToFileURL(join(SCRIPTS, "yaml-lite.mjs")).href));
        const parsed = parseYaml(docFrozenYaml());
        const sn = parsed.frozen["CASE-005"];
        assert.ok(sn, "快照样例应是 CASE-005");
        assert.equal(sn.version, 1);
        const c = await docCase();
        assert.deepEqual(sn.expect, c.expect, "快照 expect 与主 case 示例一致");
        assert.deepEqual(sn.expect_basis, c.expect_basis, "快照 expect_basis 与主 case 示例一致");
        assert.deepEqual(sn.business_basis, c.business_basis, "快照 business_basis 与主 case 示例一致");
    });
});
describe("golden-case · explorer 的 provenance 展示", () => {
    // 一个 case 绑定完整，一个 case 的 expect 没绑依据、还引了一个不存在的 basis id
    const CASES = V3_CASES + `
  - id: CASE-006
    version: 1
    name: 绑定缺口
    observe: [x]
    expect:
      x: 1
      y_missing_basis: 2
    business_basis:
      - id: BASIS-001
        kind: USER_CONFIRMATION
        statement: <b>加粗</b>确认
        excerpt: 原文
        confirmed_by: 需求方
        confirmed_on: 2026-09-27
    expect_basis:
      y_missing_basis: [BASIS-404]
`;
    it("模型把 basis 关联到 VP，并暴露未绑定/未知 id 的缺口", () => {
        const cases = withTmp((dir) => explorerModel(dir, CASES));
        const full = cases.find((c) => c.id === "CASE-005");
        assert.ok(full);
        assert.equal(full.vps[0].basis[0].id, "BASIS-001");
        assert.equal(full.vps[0].basis[0].kind_cn, "用户确认");
        assert.deepEqual(full.prov_issues, [], "完整 case 不应有 provenance 问题");
        const gap = cases.find((c) => c.id === "CASE-006");
        assert.ok(gap);
        assert.equal(gap.vps.find((v) => v.source === "x").basis.length, 0, "未绑定的 VP basis 为空列表");
        assert.match(gap.prov_issues.join("\n"), /x：未绑定业务依据/);
        assert.match(gap.prov_issues.join("\n"), /BASIS-404/);
        assert.match(gap.business_basis[0].statement, /加粗/, "basis statement 保留原文供 UI 转义");
    });
    it("搜索可命中 basis 的 statement / excerpt / reference", () => {
        const cases = withTmp((dir) => explorerModel(dir, CASES));
        const full = cases.find((c) => c.id === "CASE-005");
        for (const q of ["同一支付单最多成功一次", "payment_id 重试", "conversation:msg-17"]) {
            assert.ok(full.search.includes(q.toLowerCase()), `搜索应命中：${q}`);
        }
    });
    it("产物 HTML 含可读依据且用户文本被转义", () => {
        const html = withTmp((dir) => {
            const casesPath = join(dir, "cases.yaml");
            const outPath = join(dir, "out.html");
            writeFileSync(casesPath, CASES);
            const r = runScript("explorer.mjs", ["--cases", casesPath, "--title", "回归", "--out", outPath]);
            assert.equal(r.status, 0, r.stderr);
            return readFileSync(outPath, "utf8");
        });
        assert.match(html, /用户确认/, "类型中文标签进 HTML");
        assert.ok(!html.includes("<b>加粗</b>"), "用户文本不得以原始 HTML 出现");
        assert.match(html, /\\u003cb>/, "内联 DATA 里 < 被转义");
    });
});
// ── round 2 修复回归：合法 DERIVATION 不误报；坏条目/缺字段进 prov_issues；完整 4-expect fixture 封金 ──
describe("golden-case · explorer provenance 语义与 freeze-check 对齐（round 2）", () => {
    it("合法 DERIVATION（based_on 数组 + expression）不误标 incomplete，prov_issues 为空", () => {
        const cases = withTmp((dir) => explorerModel(dir, V3_CASES));
        const c = cases[0];
        assert.deepEqual(c.prov_issues, [], "合法 v3 case 不应有 provenance 问题");
        const der = c.business_basis.find((b) => b.id === "BASIS-002");
        assert.ok(der);
        assert.equal(der.incomplete, false, "based_on 是数组字段，不得按 string 必填规则误判");
    });
    it("非对象 basis 条目进 prov_issues，不被静默过滤；字段级缺失也给出具体字段名", () => {
        const dirty = V3_CASES.replace("    business_basis:\n", "    business_basis:\n      - garbage\n");
        const cases = withTmp((dir) => explorerModel(dir, dirty));
        const c = cases[0];
        assert.match(c.prov_issues.join("\n"), /business_basis 含非对象条目/, "非对象条目必须显式报出");
        assert.equal(c.business_basis.find((b) => b.id === "BASIS-001").incomplete, false);
        const noExcerpt = V3_CASES.replace("        excerpt: 同一个 payment_id 重试不能再次扣款\n", "");
        const cases2 = withTmp((dir) => explorerModel(dir, noExcerpt));
        assert.match(cases2[0].prov_issues.join("\n"), /BASIS-001.*缺必填字段 excerpt/, "缺字段要点名 basis 与字段");
        assert.equal(cases2[0].business_basis.find((b) => b.id === "BASIS-001").incomplete, true);
    });
    // 不再保留手写“同形”副本——case 块与 frozen 块都直接从 format.md 提取（模块级 docCaseYaml / docFrozenYaml）。
    // yaml-lite 子集的反向发射：字符串用 JSON.stringify（本文件数据无转义字符，与 YAML 双引号兼容），
    // 小数等文本标量原样回写，解析结果与原文一致。
    function emitYaml(v, indent) {
        if (Array.isArray(v)) {
            return v.map((item) => {
                if (item !== null && typeof item === "object" && !Array.isArray(item)) {
                    const body = Object.entries(item)
                        .map(([k, val], i) => `${indent}${i === 0 ? "- " : "  "}${k}: ${emitScalarOrNested(val, indent + "  ")}`)
                        .join("\n");
                    return body;
                }
                return `${indent}- ${emitScalarOrNested(item, indent)}`;
            }).join("\n");
        }
        if (v !== null && typeof v === "object") {
            return Object.entries(v)
                .map(([k, val]) => `${indent}${k}: ${emitScalarOrNested(val, indent)}`)
                .join("\n");
        }
        return `${indent}${emitScalarOrNested(v, indent)}`;
    }
    function emitScalarOrNested(v, indent) {
        if (v !== null && typeof v === "object") {
            if (Array.isArray(v))
                return "\n" + emitYaml(v, indent + "  ");
            return "\n" + emitYaml(v, indent + "  ");
        }
        if (typeof v === "string")
            return JSON.stringify(v);
        return String(v);
    }
    it("format.md 主示例：3 条 basis，BASIS-001 的 excerpt 与 confirmed_by 是独立字段", async () => {
        const c = await docCase();
        const basis = c.business_basis;
        assert.equal(basis.length, 3);
        const b1 = basis.find((b) => b.id === "BASIS-001");
        assert.ok(b1);
        assert.equal(b1.excerpt, "同一个 payment_id 重试不能再次扣款，也不能重复发事件");
        assert.equal(b1.confirmed_by, "需求方");
        assert.ok(!String(b1.excerpt).includes("需求方"), "confirmed_by 不得被拼进 excerpt");
    });
    it("format.md 主示例：4 个 expect 都绑有效依据，DERIVATION 完整，Explorer 无 provenance 问题", async () => {
        const c = await docCase();
        const expectKeys = Object.keys(c.expect);
        const basisIds = new Set(c.business_basis.map((b) => b.id));
        assert.equal(expectKeys.length, 4);
        for (const key of expectKeys) {
            const bound = c.expect_basis[key];
            assert.ok(Array.isArray(bound) && bound.length >= 1 && bound.every((id) => basisIds.has(id)), `expect key ${key} 应绑到存在的依据`);
        }
        const der = c.business_basis.find((b) => b.kind === "DERIVATION");
        assert.ok(Array.isArray(der?.based_on) && der.based_on.every((id) => basisIds.has(id)));
        assert.ok(der.expression, "DERIVATION 应有 expression");
        const casesYaml = `cases:\n${emitYaml([c], "  ")}\n`;
        // 该示例声明 lifecycle: FROZEN，配真实 frozen 块才是不带警示的完整状态
        const cases = withTmp((dir) => explorerModel(dir, casesYaml, undefined, docFrozenYaml()));
        assert.deepEqual(cases[0].prov_issues, [], "文档真实 case 配真实快照不应有 provenance 问题");
        assert.ok(cases[0].business_basis.every((b) => b.incomplete === false), "三条依据都应完整");
    });
    it("format.md 真实 frozen 块 + 真实 case 块组合：freeze-check exit 0", async () => {
        const c = await docCase();
        const casesYaml = `cases:\n${emitYaml([c], "  ")}\n`;
        const frozen = withTmp((dir) => runFreeze(dir, casesYaml, docFrozenYaml()));
        assert.equal(frozen.status, 0, `文档真实 case + 真实 frozen 示例必须封金全绿：${frozen.stdout}${frozen.stderr}`);
    });
    it("format.md 真实 frozen 块单独解析：与 case 块同 id、同 version", async () => {
        const c = await docCase();
        assert.equal(c.id, "CASE-005");
        assert.equal(c.version, 1);
    });
});
// ── round 4 修复回归：FROZEN 反查、legacy 快照警示、legacy 标量保留键不误判 ──
describe("golden-case · round 4：lifecycle 反查与快照形态一致性", () => {
    // case 显式 FROZEN 但 frozen.md 无快照：门禁红牌 + Explorer 警示
    const FROZEN_NO_SNAP = `cases:
  - id: CASE-005
    name: 自称已封金
    lifecycle: FROZEN
    observe: [a]
    expect:
      a: 1
`;
    it("case 显式 lifecycle: FROZEN 而无快照：freeze-check exit 1 LIFECYCLE-UNBACKED", () => {
        const r = withTmp((dir) => runFreeze(dir, FROZEN_NO_SNAP, "frozen: {}\n"));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /LIFECYCLE-UNBACKED/);
        assert.match(r.stdout, /恢复 frozen 条目/);
    });
    it("Explorer 对显式 FROZEN 无快照的 case 报 prov_issues 警示", () => {
        const cases = withTmp((dir) => explorerModel(dir, FROZEN_NO_SNAP, undefined, "frozen: {}\n"));
        assert.match(cases[0].prov_issues.join("\n"), /frozen\.md 里没有它的快照/);
    });
    it("case 有 provenance、快照仍是旧式：freeze-check BASIS-NOT-FROZEN + Explorer 同口径警示", () => {
        const legacySnap = "frozen:\n  CASE-005:\n    charge_count_P5: 1\n    total_charged: 74.8\n";
        const r = withTmp((dir) => runFreeze(dir, V3_CASES, legacySnap));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /BASIS-NOT-FROZEN/);
        const cases = withTmp((dir) => explorerModel(dir, V3_CASES, undefined, legacySnap));
        const c = cases.find((x) => x.id === "CASE-005");
        assert.match(c.prov_issues.join("\n"), /旧式 expect 映射/);
        assert.match(c.prov_issues.join("\n"), /重新冻结/);
        assert.equal(c.frozen, true);
        // v3 快照配 v3 case：不产生该警示
        const ok = withTmp((dir) => explorerModel(dir, V3_CASES, undefined, v3Frozen()));
        assert.deepEqual(ok.find((x) => x.id === "CASE-005").prov_issues, []);
    });
    it("legacy 快照的标量期望键恰好叫 business_basis / expect_basis：不误判 v3，按 legacy 全绿", () => {
        const legacy = `cases:
  - id: CASE-201
    name: legacy 保留键名
    observe: [a, business_basis, expect_basis]
    expect:
      a: 1
      business_basis: 2
      expect_basis: 3
`;
        const snap = "frozen:\n  CASE-201:\n    a: 1\n    business_basis: 2\n    expect_basis: 3\n";
        const r = withTmp((dir) => runFreeze(dir, legacy, snap));
        assert.equal(r.status, 0, `legacy 保留键名不应被判型为 v3：${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /全绿/);
        // 篡改其中一个值仍按 legacy 红牌 CHANGED
        const r2 = withTmp((dir) => runFreeze(dir, legacy, snap.replace("business_basis: 2", "business_basis: 9")));
        assert.equal(r2.status, 1);
        assert.match(r2.stdout, /\[CHANGED\]/);
    });
    it("malformed v3 快照（expect_basis 为 null）不因判型收窄而漏报", () => {
        const badSnap = "frozen:\n  CASE-005:\n    version: 1\n    expect:\n      charge_count_P5: 1\n      total_charged: 74.8\n    expect_basis: ~\n    business_basis: ~\n";
        const r = withTmp((dir) => runFreeze(dir, V3_CASES, badSnap));
        assert.equal(r.status, 1);
        assert.match(r.stdout, /BASIS-INVALID|BASIS-INCOMPLETE|BASIS-NOT-FROZEN/);
    });
});
// ── round 5 修复回归：frozen 快照条目本身 malformed（null/标量/列表）必须受控红牌 ──
describe("golden-case · round 5：malformed frozen 快照条目 fail-closed", () => {
    const LEGACY_CASES = "cases:\n  - id: CASE-001\n    name: 含税总价\n    observe: [t]\n    expect:\n      t: 76.8\n";
    const entries = [
        ["null", "frozen:\n  CASE-001:\n", "null"],
        ["标量", "frozen:\n  CASE-001: 42\n", "42"],
        ["列表", "frozen:\n  CASE-001:\n    - a\n    - b\n", "a,b"],
    ];
    for (const [label, snap, needle] of entries) {
        it(`快照条目为 ${label}：freeze-check exit 1 SNAPSHOT-INVALID，不抛 TypeError`, () => {
            const r = withTmp((dir) => runFreeze(dir, LEGACY_CASES, snap));
            assert.equal(r.status, 1, `应红牌：${r.stdout}${r.stderr}`);
            assert.match(r.stdout, /\[SNAPSHOT-INVALID\]/);
            assert.match(r.stdout, new RegExp(needle === "a,b" ? "a,b" : needle));
            assert.doesNotMatch(r.stdout + r.stderr, /TypeError/);
        });
    }
    it("Explorer 对 null 快照条目在 prov_issues 报警示，不当正常已冻结依据", () => {
        const cases = withTmp((dir) => explorerModel(dir, LEGACY_CASES, undefined, "frozen:\n  CASE-001:\n"));
        assert.match(cases[0].prov_issues.join("\n"), /快照条目形状非法/);
        assert.equal(cases[0].frozen, true);
    });
});
