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
function explorerModel(dir, cases, runs) {
    const casesPath = join(dir, "cases.yaml");
    const outPath = join(dir, "case-explorer.html");
    writeFileSync(casesPath, cases);
    const args = ["--cases", casesPath, "--title", "回归", "--out", outPath];
    if (runs) {
        const runsPath = join(dir, "runs.json");
        writeFileSync(runsPath, JSON.stringify(runs));
        args.push("--runs", runsPath);
    }
    const r = runScript("explorer.mjs", args);
    assert.equal(r.status, 0, `explorer 应正常退出：${r.stderr}`);
    const html = readFileSync(outPath, "utf8");
    const m = html.match(/<script>const DATA = ([\s\S]*?)<\/script>/);
    assert.ok(m, "产物 HTML 里应有内联的 DATA");
    return JSON.parse(m[1].replace(/;\s*$/, "")).cases;
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
    it("不可判定的期望被标 bad 并拒判，同 case 里可判定的照常判", () => {
        const CASES = `cases:
  - id: CASE-201
    name: 期望里混了一句感受
    observe: [mood, stock_after]
    expect:
      mood: 余额扣得正确，用户体验良好
      stock_after: 2

  - id: CASE-202
    name: 期望全是描述
    observe: [mood]
    expect:
      mood: 余额扣得正确，用户体验良好
`;
        const cases = withTmp((dir) => explorerModel(dir, CASES, {
            "CASE-201:mood": "余额扣得正确，用户体验良好",
            "CASE-201:stock_after": 2,
            "CASE-202:mood": "余额扣得正确，用户体验良好",
        }));
        const c = cases[0];
        assert.equal(c.vps[0].bad, true, "描述性期望必须标 bad");
        assert.equal(c.vps[1].bad, false);
        assert.equal(c.health, "BROKEN", "含不可判定期望的 case 健康度应为 BROKEN");
        assert.ok(c.run);
        assert.deepEqual(c.run.results.map((r) => r.vp_id), ["VP-002"], "被拒判的 VP 不得进入判定结果");
        assert.equal(c.run.status, "PASS", "只由可判定 VP 聚合判定");
        const all = cases[1];
        assert.equal(all.vps[0].bad, true);
        assert.equal(all.run?.status, "NOT_RUN", "全不可判定 = 拒判，不得给 PASS/FAIL");
    });
});
