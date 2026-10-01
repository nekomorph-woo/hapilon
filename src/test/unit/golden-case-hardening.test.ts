// golden-case 执行链可信性硬化的活体验收矩阵：GREEN means verified, not merely non-failed。
// 被测对象是 resources/skills/golden-case/scripts/ 下的 CLI（不参与 tsc 编译），按真实
// 调用方式起子进程，断言落在退出码与产物上。覆盖：fail-closed 状态聚合（只有显式 PASSED
// 贡献通过）、假绿回归（SKIPPED/缺结果/未知状态/多出锚/同锚冲突全 NON-GREEN）、重复身份
// 硬失败（case id / VP id）、解析器 lossless-or-fail 负夹具、档位/依赖降级门、--json
// 归一化输出、explorer INCOMPLETE。固定数据全部本文件内联。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL("../../../resources/skills/golden-case/scripts", import.meta.url));

type Spawn = { status: number | null; stdout: string; stderr: string };

function runScript(script: string, args: string[]): Spawn {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "gce-harden-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 基准 case 集：三个观察点，供状态矩阵逐项注入
const CASES = `cases:
  - id: CASE-601
    name: 状态矩阵
    observe: [alpha, beta, gamma]
    expect:
      alpha: 1
      beta: 2
      gamma: 3
`;

// 跑 report：给定输出文本（数组 = 多份输出文件），返回退出码与 stdout
function runReport(dir: string, outputs: string[], extra: string[] = []): Spawn {
  const casesPath = join(dir, "cases.yaml");
  writeFileSync(casesPath, CASES);
  const outs = outputs.map((text, i) => {
    const p = join(dir, `out${i}.txt`);
    writeFileSync(p, text);
    return p;
  });
  return runScript("report.mjs", ["--cases", casesPath, ...extra, ...outs]);
}

describe("golden-case 硬化 · 状态聚合矩阵（fail-closed）", () => {
  // 每项：把 beta 行替换成对应状态的输出行，期望退出码非零
  const matrix: Array<[string, string, RegExp]> = [
    ["SKIPPED（符号行）", " ○ CASE-601:beta", /○ beta（SKIPPED/],
    ["ABORTED（Gradle 行）", "com.shop.GoldenTest > CASE-601:beta ABORTED", /○ beta（ABORTED/],
    ["ERROR（pytest 短摘要）", "ERROR tests/t.py::test_b[CASE-601:beta] - RuntimeError: boom", /! beta（ERROR/],
    ["XFAIL（pytest verbose）", "tests/t.py::test_b[CASE-601:beta] XFAIL", /○ beta（XFAIL/],
    ["XPASS", "tests/t.py::test_b[CASE-601:beta] XPASS", /! beta（XPASS/],
    ["未知状态 CUSTOM_SKIP（符号行尾随）", " ✓ CASE-601:beta CUSTOM_SKIP", /! beta（UNKNOWN ← CUSTOM_SKIP/],
    ["未知状态 PENDING（行首）", "PENDING CASE-601:beta - waiting on env", /! beta（UNKNOWN ← PENDING/],
  ];
  for (const [label, betaLine, rowPattern] of matrix) {
    it(`一个 VP ${label} → case 非零退出，绝不计入通过`, () => {
      const out = ` ✓ CASE-601:alpha\n${betaLine}\n ✓ CASE-601:gamma\n`;
      const r = withTmp((dir) => runReport(dir, [out]));
      assert.notEqual(r.status, 0, `${label} 必须 exit != 0`);
      assert.equal(r.status, 1);
      assert.match(r.stdout, rowPattern);
      assert.match(r.stdout, /Suite: NON-GREEN/);
      assert.doesNotMatch(r.stdout, /全绿|all passed|verified/);
    });
  }

  it("FAILED 仍然 FAIL 且非零；首个失败标记保留", () => {
    const out = " ✓ CASE-601:alpha\n ✗ CASE-601:beta\n ✓ CASE-601:gamma\n";
    const r = withTmp((dir) => runReport(dir, [out]));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /✗ beta {2}← 首个失败/);
    assert.match(r.stdout, /❌ CASE-601/);
  });

  it("E2E-A：全部 required VP 显式 PASSED → Suite GREEN、exit 0", () => {
    const out = " ✓ CASE-601:alpha\n ✓ CASE-601:beta\n ✓ CASE-601:gamma\n";
    const r = withTmp((dir) => runReport(dir, [out]));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Suite: GREEN/);
    assert.match(r.stdout, /Cases: 1 PASS · 0 FAIL · 0 UNVERIFIED · 0 INVALID/);
    assert.match(r.stdout, /Verification points: 3 PASSED/);
  });

  it("混排状态优先级：FAIL 压过 INVALID/UNVERIFIED（case = FAIL，不是 INVALID）", () => {
    const out = " ✗ CASE-601:alpha\n ERROR CASE-601:beta - x\n ○ CASE-601:gamma\n";
    const r = withTmp((dir) => runReport(dir, [out]));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /❌ CASE-601/);
    assert.match(r.stdout, /Cases: 0 PASS · 1 FAIL · 0 UNVERIFIED · 0 INVALID/);
  });
});

describe("golden-case 硬化 · 假绿回归（SKIPPED ≠ 通过）", () => {
  // 发现的原始 bug：report 把「不是 FAILED」聚合为绿，1/1 case 全绿 + exit 0
  const SINGLE = `cases:
  - id: CASE-001
    name: 单观察点
    observe: [api_return]
    expect:
      api_return: success
`;

  it("唯一的 required VP = SKIPPED → UNVERIFIED / NON-GREEN / exit != 0，无全绿字样", () => {
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, SINGLE);
      const p = join(dir, "out.txt");
      writeFileSync(p, " ○ CASE-001:api_return\n");
      return runScript("report.mjs", ["--cases", casesPath, p]);
    });
    assert.notEqual(r.status, 0, "SKIPPED 绝不允许 exit 0——这是本次整改的核心回归");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /○ api_return（SKIPPED — 未验证，不算通过）/);
    assert.match(r.stdout, /Suite: NON-GREEN/);
    assert.match(r.stdout, /Cases: 0 PASS · 0 FAIL · 1 UNVERIFIED · 0 INVALID/);
    assert.doesNotMatch(r.stdout, /全绿|all passed|verified/);
  });

  it("JUnit XML 路径同样 fail-closed：全 skipped 的 case 非零", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites><testsuite name="t">',
      '<testcase classname="t" name="CASE-001:api_return"><skipped/></testcase>',
      '</testsuite></testsuites>',
    ].join("\n");
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, SINGLE);
      const p = join(dir, "out.xml");
      writeFileSync(p, xml);
      return runScript("report.mjs", ["--cases", casesPath, p]);
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /○ api_return（SKIPPED/);
  });

  it("空输出文件与空壳 XML：MALFORMED 输入，非零且点名文件", () => {
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, SINGLE);
      const empty = join(dir, "empty.txt");
      writeFileSync(empty, "");
      const shell = join(dir, "shell.xml");
      writeFileSync(shell, '<?xml version="1.0"?><testsuites></testsuites>');
      return runScript("report.mjs", ["--cases", casesPath, empty, shell]);
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /MALFORMED 输入：.*empty\.txt（空输出文件/);
    assert.match(r.stdout, /MALFORMED 输入：.*shell\.xml（声明为 JUnit XML/);
  });
});

describe("golden-case 硬化 · required VP 集以 case 源为准", () => {
  it("缺 VP 回归：定义 VP-A/VP-B，输出只有 VP-A → VP-B MISSING，case != PASS，exit != 0", () => {
    const cases = `cases:
  - id: CASE-001
    name: 双观察点
    observe: [vp_a, vp_b]
    expect:
      vp_a: 1
      vp_b: 2
`;
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, cases);
      const p = join(dir, "out.txt");
      writeFileSync(p, " ✓ CASE-001:vp_a\n");
      return runScript("report.mjs", ["--cases", casesPath, p]);
    });
    assert.notEqual(r.status, 0);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /✓ vp_a/);
    assert.match(r.stdout, /○ vp_b（未在输出中发现）/);
    assert.match(r.stdout, /Cases: 0 PASS · 0 FAIL · 1 UNVERIFIED/);
  });

  it("多出的 VP999 → UNEXPECTED，非零（adapter drift / 映射错的信号）", () => {
    const out = " ✓ CASE-601:alpha\n ✓ CASE-601:beta\n ✓ CASE-601:gamma\n ✓ CASE-601:vp999\n";
    const r = withTmp((dir) => runReport(dir, [out]));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /! vp999（UNEXPECTED ← PASSED — case 未声明此观察点/);
    assert.match(r.stdout, /Cases: 0 PASS · 0 FAIL · 0 UNVERIFIED · 1 INVALID/);
  });

  it("同锚冲突状态 → AMBIGUOUS，不容「FAILED 赢家」也不容「后者覆盖」", () => {
    const r = withTmp((dir) => runReport(dir, [" ✓ CASE-601:alpha\n ✓ CASE-601:beta\n ✓ CASE-601:gamma\n", " ✗ CASE-601:gamma\n"]));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /! gamma（AMBIGUOUS ← PASSED@.*out0\.txt:\d+、FAILED@.*out1\.txt:\d+/);
  });

  it("无源锚（case 集里没有的 CASE-XXX）仍然非零", () => {
    const out = " ✓ CASE-601:alpha\n ✓ CASE-601:beta\n ✓ CASE-601:gamma\n ✓ CASE-999:x\n";
    const r = withTmp((dir) => runReport(dir, [out]));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /无源锚/);
    assert.match(r.stdout, /CASE-999:x/);
  });
});

describe("golden-case 硬化 · 重复身份硬失败", () => {
  it("重复 case id（a.yaml/b.yaml 各有 CASE-001）→ DUPLICATE_CASE_ID，错误含双源，exit 3", () => {
    const r = withTmp((dir) => {
      const casesDir = join(dir, "cases");
      mkdirSync(casesDir);
      writeFileSync(join(casesDir, "a.yaml"), "cases:\n  - id: CASE-001\n    name: a\n    expect:\n      total: 1\n");
      writeFileSync(join(casesDir, "b.yaml"), "cases:\n  - id: CASE-001\n    name: b\n    expect:\n      total: 2\n");
      const p = join(dir, "out.txt");
      writeFileSync(p, "");
      return runScript("report.mjs", ["--cases", casesDir, p]);
    });
    assert.equal(r.status, 3, "重复 case id 是源错误，必须 exit 3（不是 1 也不是 0）");
    assert.match(r.stderr, /DUPLICATE_CASE_ID/);
    assert.match(r.stderr, /CASE-001/);
    assert.match(r.stderr, /a\.yaml/);
    assert.match(r.stderr, /b\.yaml/);
    assert.match(r.stderr, /First defined:/);
    assert.doesNotMatch(r.stdout, /Suite:|✓|✗/, "源无效时不得产出任何判定");
  });

  it("同一文件内重复 id 同样硬失败（不按出现序取赢家）", () => {
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, "cases:\n  - id: CASE-001\n    expect:\n      a: 1\n  - id: CASE-001\n    expect:\n      a: 2\n");
      return runScript("audit.mjs", ["--cases", casesPath, "--tests", dir]);
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /DUPLICATE_CASE_ID/);
  });

  it("重复 VP id（同 case 两个 VP-001）→ INVALID_CASE，exit 3", () => {
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, `cases:
  - id: CASE-002
    name: 重复 VP
    verification_points:
      - {id: VP-001, source: x}
      - {id: VP-001, source: y}
    expect:
      x: 1
      y: 2
`);
      return runScript("report.mjs", ["--cases", casesPath, join(dir, "no.txt")]);
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /INVALID_CASE/);
    assert.match(r.stderr, /VP-001/);
  });

  it("observe 重复观察点 → INVALID_CASE，exit 3", () => {
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, "cases:\n  - id: CASE-003\n    observe: [a, a]\n    expect:\n      a: 1\n");
      return runScript("report.mjs", ["--cases", casesPath, join(dir, "no.txt")]);
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /观察点重复/);
  });
});

describe("golden-case 硬化 · 解析器 lossless-or-fail（负夹具六件套）", () => {
  const fixtures: Array<[string, string]> = [
    ["invalid-indentation.yaml", "cases:\n  - id: CASE-001\n     bad: 1\n"],
    ["duplicate-key.yaml", "cases:\n  - id: CASE-001\n    expect:\n      a: 1\n      a: 2\n"],
    ["unsupported-construct.yaml", "cases:\n  - id: CASE-001\n    anchor: &x 1\n"],
    ["truncated-list.yaml", "cases:\n  - id: CASE-001\n    observe: [a, b\n"],
    ["invalid-type.yaml", "cases: 42\n"],
    ["trailing-unparsed-content.yaml", "cases:\n  - id: CASE-001\n    expect:\n      a: 1\nbadline\n"],
  ];
  for (const [name, text] of fixtures) {
    it(`${name} → 源错误 exit 3，执行未开始（无判定输出）`, () => {
      const r = withTmp((dir) => {
        const casesPath = join(dir, name);
        writeFileSync(casesPath, text);
        return runScript("report.mjs", ["--cases", casesPath, join(dir, "no.txt")]);
      });
      assert.equal(r.status, 3, `${name} 必须作为源错误退出：${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /源错误/);
      assert.doesNotMatch(r.stdout, /Suite:|✓|✗|○/, "parser 失败后不得继续跑测试或输出判定");
      assert.doesNotMatch(r.stderr, /TypeError|SyntaxError/, "受控报错，不是崩溃栈");
    });
  }

  it("freeze-check / audit / explorer 同口径：坏源 exit 3 而非崩溃", () => {
    const badYaml = "cases:\n  - id: CASE-001\n    expect:\n      a: 1\n      a: 2\n";
    for (const [script, args] of [
      ["freeze-check.mjs", ["--frozen", "frozen.md"]],
      ["audit.mjs", ["--tests", "tests"]],
      ["explorer.mjs", ["--out", "exp.html"]],
    ] as const) {
      const r = withTmp((dir) => {
        writeFileSync(join(dir, "cases.yaml"), badYaml);
        writeFileSync(join(dir, "frozen.md"), "frozen: {}\n");
        mkdirSync(join(dir, "tests"));
        return runScript(script, ["--cases", join(dir, "cases.yaml"), ...args.map((a) => (a.startsWith("--") ? a : join(dir, a)))]);
      });
      assert.equal(r.status, 3, `${script} 对坏源应 exit 3`);
      assert.match(r.stderr, /源错误/);
    }
  });
});

describe("golden-case 硬化 · 档位与依赖模式门（REAL 不得被 mock 满足）", () => {
  const LEVELED = `cases:
  - id: CASE-701
    name: 真实依赖验收
    verification_level: L3
    dependencies:
      - {name: 支付网关, mode: REAL}
    observe: [delta]
    expect:
      delta: 4
`;
  const OUT = " ✓ CASE-701:delta\n";

  function runLeveled(dir: string, meta: string | null): Spawn {
    const casesPath = join(dir, "cases.yaml");
    writeFileSync(casesPath, LEVELED);
    const p = join(dir, "out.txt");
    writeFileSync(p, OUT);
    const args = ["--cases", casesPath];
    if (meta !== null) {
      const mp = join(dir, "meta.json");
      writeFileSync(mp, meta);
      args.push("--meta", mp);
    }
    args.push(p);
    return runScript("report.mjs", args);
  }

  it("无 --meta：L3+REAL 无证明 → LEVEL/MODE-UNPROVEN，exit 1", () => {
    const r = withTmp((dir) => runLeveled(dir, null));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /LEVEL-UNPROVEN/);
    assert.match(r.stdout, /MODE-UNPROVEN/);
    assert.match(r.stdout, /Cases: 0 PASS · 0 FAIL · 0 UNVERIFIED · 1 INVALID/);
  });

  it("REAL required 但 MOCK executed；L3 required 但 L1 executed → 双 MISMATCH，exit 1（mock 过 ≠ 业务过）", () => {
    const r = withTmp((dir) => runLeveled(dir, JSON.stringify({ verification_level: "L1", dependency_mode: "MOCK" })));
    assert.equal(r.status, 1, "全 VP PASSED 也不许过：降级执行不是验收");
    assert.match(r.stdout, /VERIFICATION_LEVEL_MISMATCH（INVALID — 要求 L3，实际执行 L1）/);
    assert.match(r.stdout, /DEPENDENCY_MODE_MISMATCH（INVALID — 依赖「支付网关」要求 REAL，实际按 MOCK 执行/);
    assert.match(r.stdout, /✓ delta/);
  });

  it("档位匹配 + REAL 证明 → 全 PASSED 才 GREEN，exit 0", () => {
    const r = withTmp((dir) =>
      runLeveled(dir, JSON.stringify({ run_id: "r-42", when: "2026-10-01", commit_sha: "abc123def456", verification_level: "L3", dependency_modes: { 支付网关: "REAL" } })),
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Suite: GREEN/);
    assert.match(r.stdout, /Run: r-42 · 2026-10-01 · commit abc123def456/);
  });

  it("仅依赖名对不上 → MODE-UNPROVEN（依赖粒度校验）", () => {
    const r = withTmp((dir) =>
      runLeveled(dir, JSON.stringify({ verification_level: "L3", dependency_modes: { 短信网关: "REAL" } })),
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /MODE-UNPROVEN/);
  });

  it("坏 --meta（非法档位）→ 参数错误 exit 2", () => {
    const r = withTmp((dir) => runLeveled(dir, JSON.stringify({ verification_level: "L9" })));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /L1-L4/);
  });

  it("case 声明非法档位/依赖模式在加载期就被拒（不进执行）", () => {
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, `cases:\n  - id: CASE-702\n    verification_level: L9\n    expect:\n      a: 1\n`);
      return runScript("report.mjs", ["--cases", casesPath, join(dir, "no.txt")]);
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /verification_level 非法/);
  });
});

describe("golden-case 硬化 · --json 归一化结果模型", () => {
  it("未知状态保留 raw：normalized UNKNOWN / raw CUSTOM_SKIP，suite NON-GREEN，exit 1", () => {
    const r = withTmp((dir) => runReport(dir, [" ✓ CASE-601:alpha\n ✓ CASE-601:beta\n ✓ CASE-601:gamma CUSTOM_SKIP\n"], ["--json"]));
    assert.equal(r.status, 1);
    const d = JSON.parse(r.stdout) as {
      suite: { verdict: string; verification_points: Record<string, number> };
      cases: Array<{ verdict: string; verification_points: Array<{ id: string; normalized_status: string; raw_status: string; verdict: string; first_fail: boolean }> }>;
    };
    assert.equal(d.suite.verdict, "NON-GREEN");
    assert.equal(d.suite.verification_points.UNKNOWN, 1);
    const gamma = d.cases[0].verification_points.find((v) => v.id === "gamma");
    assert.ok(gamma);
    assert.equal(gamma.normalized_status, "UNKNOWN");
    assert.equal(gamma.raw_status, "CUSTOM_SKIP");
    assert.equal(gamma.verdict, "INVALID");
    assert.equal(gamma.first_fail, true, "首个非通过点要能当 debug 入口");
    assert.equal(d.cases[0].verdict, "INVALID");
  });

  it("SKIPPED 的 verdict 是 UNVERIFIED（没有验证 ≠ 验证通过），MISSING 同理", () => {
    const r = withTmp((dir) => runReport(dir, [" ✓ CASE-601:alpha\n ○ CASE-601:beta\n"], ["--json"]));
    assert.equal(r.status, 1);
    const d = JSON.parse(r.stdout) as {
      cases: Array<{ verdict: string; verification_points: Array<{ id: string; status: string; verdict: string }> }>;
    };
    const vps = Object.fromEntries(d.cases[0].verification_points.map((v) => [v.id, v]));
    assert.equal(vps.beta.status, "SKIPPED");
    assert.equal(vps.beta.verdict, "UNVERIFIED");
    assert.equal(vps.gamma.status, "MISSING");
    assert.equal(vps.gamma.verdict, "UNVERIFIED");
    assert.equal(d.cases[0].verdict, "UNVERIFIED");
  });

  it("run 身份入 JSON：meta 字段与输入文件可追溯", () => {
    const r = withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      writeFileSync(casesPath, `cases:\n  - id: CASE-001\n    observe: [a]\n    expect:\n      a: 1\n`);
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ run_id: "r-7", commit_sha: "deadbeef", runner: "pytest" }));
      const p = join(dir, "out.txt");
      writeFileSync(p, " ✓ CASE-001:a\n");
      return runScript("report.mjs", ["--cases", casesPath, "--meta", join(dir, "meta.json"), "--json", p]);
    });
    assert.equal(r.status, 0);
    const d = JSON.parse(r.stdout) as { run: { run_id: string; commit_sha: string; runner: string; inputs: string[] } };
    assert.equal(d.run.run_id, "r-7");
    assert.equal(d.run.commit_sha, "deadbeef");
    assert.equal(d.run.runner, "pytest");
    assert.ok(d.run.inputs.some((i) => i.endsWith("out.txt")));
  });
});

describe("golden-case 硬化 · E2E-B 与措辞", () => {
  it("不完整执行：SKIPPED 混在 PASSED 里 → UNVERIFIED 字样在场，全绿/verified 字样绝迹", () => {
    const out = " ✓ CASE-601:alpha\n ○ CASE-601:beta\n ✓ CASE-601:gamma\n";
    const r = withTmp((dir) => runReport(dir, [out]));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /⚠️ {2}CASE-601 状态矩阵 —— 未验证，不得计为通过/);
    assert.match(r.stdout, /Suite: NON-GREEN/);
    assert.match(r.stdout, /1 UNVERIFIED/);
    assert.doesNotMatch(r.stdout, /全绿|all passed|verified|全部通过/);
  });

  it("四类行图标与判定一一对应：✓ PASS / ✗ FAIL / ○ UNVERIFIED / ! INVALID", () => {
    const out = " ✓ CASE-601:alpha\n ✗ CASE-601:beta\n ○ CASE-601:gamma\n";
    const r = withTmp((dir) => runReport(dir, [out]));
    assert.match(r.stdout, /  ✓ alpha\n/);
    assert.match(r.stdout, /  ✗ beta {2}← 首个失败\n/);
    assert.match(r.stdout, /  ○ gamma（SKIPPED/);
    assert.match(r.stdout, /Suite: NON-GREEN/);
  });
});

describe("golden-case 硬化 · explorer 的 INCOMPLETE（部分判定不再是 PASS）", () => {
  const THREE = `cases:
  - id: CASE-801
    name: 三观察点
    observe: [a, b, c]
    expect:
      a: 1
      b: 2
      c: 3
`;
  function explorerRun(runsJson: string): Array<{ id: string; run: { status: string } | null }> {
    return withTmp((dir) => {
      const casesPath = join(dir, "cases.yaml");
      const runsPath = join(dir, "runs.json");
      const outPath = join(dir, "exp.html");
      writeFileSync(casesPath, THREE);
      writeFileSync(runsPath, runsJson);
      const r = runScript("explorer.mjs", ["--cases", casesPath, "--runs", runsPath, "--out", outPath]);
      assert.equal(r.status, 0, r.stderr);
      const html = readFileSync(outPath, "utf8");
      const m = html.match(/<script>const DATA = ([\s\S]*?)<\/script>/);
      assert.ok(m, "产物 HTML 里应有内联的 DATA");
      return (JSON.parse(m[1].replace(/;\s*$/, "")) as { cases: Array<{ id: string; run: { status: string } | null }> }).cases;
    });
  }

  it("2/3 有实际值且无 FAIL → INCOMPLETE（此前是 PASS——同类假绿）", () => {
    const cases = explorerRun(JSON.stringify({ "CASE-801:a": 1, "CASE-801:b": 2 }));
    assert.equal(cases[0].run?.status, "INCOMPLETE");
  });

  it("3/3 判定且全过 → PASS；0/3 → NOT_RUN", () => {
    assert.equal(explorerRun(JSON.stringify({ "CASE-801:a": 1, "CASE-801:b": 2, "CASE-801:c": 3 }))[0].run?.status, "PASS");
    assert.equal(explorerRun(JSON.stringify({}))[0].run?.status, "NOT_RUN");
  });

  it("部分过部分错 → FAIL 优先", () => {
    const cases = explorerRun(JSON.stringify({ "CASE-801:a": 1, "CASE-801:b": 9 }));
    assert.equal(cases[0].run?.status, "FAIL");
  });
});
