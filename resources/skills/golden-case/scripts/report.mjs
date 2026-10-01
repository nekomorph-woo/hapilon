#!/usr/bin/env node
// report —— 测试输出 → 按 CASE 聚合报告（首个失败观察点优先）。
// 用法：node report.mjs --cases <yaml|目录> [--only CASE-001,...] [--meta run-meta.json] [--json] <输出文件>...
// 语义是 fail-closed：只有显式 PASSED 才贡献通过；SKIPPED/ABORTED/ERROR/XFAIL/XPASS/UNKNOWN、
// 缺失的观察点（MISSING）、输出里多出的锚（UNEXPECTED）、同锚冲突状态（AMBIGUOUS）、
// 档位/依赖无法证明或降级（LEVEL/MODE-UNPROVEN|MISMATCH）全部 NON-GREEN，exit 1。
// 「不是 FAILED」永远推不出「通过」；required VP 集合以 case 源的 expect 键为准，
// 而不是 runner 恰好报了什么。源错误 exit 3，缺参 exit 2。
import { readFileSync } from 'node:fs';
import { loadCasesOrExit } from './cases-source.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const asJson = process.argv.includes('--json');
const script = 'report';
const casesPath = arg('cases');
if (!casesPath) {
  console.error('report: 缺少 --cases');
  process.exit(2);
}
// 本次预期集合：不声明 = 全量验收；子集跑必须 --only 显式声明（对账只对声明范围负责）。
// 声明了不存在的 case id 直接报错——拼写错误若被静默忽略会变回假绿。
const onlyRaw = arg('only');
const onlySet = onlyRaw ? new Set(onlyRaw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
if (onlyRaw && onlySet.size === 0) {
  console.error('report: --only 需要至少一个 case id');
  process.exit(2);
}
const allCases = loadCasesOrExit(casesPath, script);
if (onlySet) {
  const unknown = [...onlySet].filter((id) => !allCases.some((c) => c.id === id));
  if (unknown.length) {
    console.error(`report: --only 里有 case 集中不存在的：${unknown.join(', ')}`);
    process.exit(2);
  }
}
const caseList = onlySet ? allCases.filter((c) => onlySet.has(c.id)) : allCases;
const allIds = new Set(allCases.map((c) => c.id));

// ── 运行身份（--meta）：档位/依赖模式的证明通道。L2+ 或 REAL 依赖的 case 没有证明不判绿 ──
const metaPath = arg('meta');
let meta = null;
if (metaPath) {
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (e) {
    console.error(`report: --meta 文件无法解析：${e.message}`);
    process.exit(2);
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    console.error('report: --meta 文件须是 JSON 对象');
    process.exit(2);
  }
  if (meta.verification_level !== undefined && !/^L[1-4]$/.test(String(meta.verification_level))) {
    console.error('report: --meta 的 verification_level 须为 L1-L4');
    process.exit(2);
  }
  for (const k of ['dependency_mode', 'verification_level']) {
    if (meta[k] !== undefined && typeof meta[k] !== 'string') {
      console.error(`report: --meta 的 ${k} 须是字符串`);
      process.exit(2);
    }
  }
  if (meta.dependency_modes !== undefined && (typeof meta.dependency_modes !== 'object' || Array.isArray(meta.dependency_modes))) {
    console.error('report: --meta 的 dependency_modes 须是映射（依赖名 → 模式）');
    process.exit(2);
  }
}

// ── 状态归一化：runner 原始状态 → 有限闭集。未识别的一律 UNKNOWN，保留 raw 供排查 ──
const KNOWN_STATES = new Set(['PASSED', 'FAILED', 'SKIPPED', 'ABORTED', 'ERROR', 'XFAIL', 'XPASS']);
const normalizeState = (raw) => (KNOWN_STATES.has(raw) ? raw : 'UNKNOWN');
// 执行状态 → 业务判定：只有 PASSED 能贡献通过
const VERDICT_OF = {
  PASSED: 'PASS',
  FAILED: 'FAIL',
  SKIPPED: 'UNVERIFIED', ABORTED: 'UNVERIFIED', MISSING: 'UNVERIFIED', XFAIL: 'UNVERIFIED',
  ERROR: 'INVALID', XPASS: 'INVALID', UNKNOWN: 'INVALID', MALFORMED: 'INVALID', AMBIGUOUS: 'INVALID', UNEXPECTED: 'INVALID',
};
const ICON = { PASSED: '✓', FAILED: '✗', SKIPPED: '○', ABORTED: '○', MISSING: '○', XFAIL: '○', ERROR: '!', XPASS: '!', UNKNOWN: '!', MALFORMED: '!', AMBIGUOUS: '!', UNEXPECTED: '!' };

// vitest/jest verbose：`✓ name 3ms` / `× name (5 ms)`，符号即状态；只认含锚的行，不怕误伤
const SYMBOL = /^\s*([✓✔]|×|✗|✘|❌|○|◯)\s+(.+?)\s*(?:\(\d+\s*ms\)|\d+ms)?\s*$/;
const SYMBOL_STATE = { '✓': 'PASSED', '✔': 'PASSED', '×': 'FAILED', '✗': 'FAILED', '✘': 'FAILED', '❌': 'FAILED', '○': 'SKIPPED', '◯': 'SKIPPED' };
const ANCHOR = /CASE-\d{3}(?::[A-Za-z0-9_.-]+)?/;
// 行尾大写状态词（Gradle「Class > name STATE」、pytest -v「nodeid STATE [ 12%]」、符号行尾限随状态如 CUSTOM_SKIP）。
// 末尾允许 [..%] / (N ms) 装饰；状态必须是独立的大写词，不匹配普通散文。
const TAIL = /^(.+?)\s+([A-Z][A-Z_]{2,})(?:\s+[\[(][^\])]*[\])])*\s*$/;
// 行首大写状态词（pytest 短摘要「FAILED nodeid - detail」、ERROR/CUSTOM_SKIP 等）
const LEAD = /^\s*([A-Z][A-Z_]{2,})\s+(\S+?)(?:\s+-\s*(.*))?$/;

const results = new Map(); // "CASE-001:api_return" → { states:Map<state,[where]>, raws:Set, details:[] }
const seenUnknown = new Map(); // case 集外的锚 → [位置]
const inputIssues = []; // MALFORMED 级输入问题（空输出、空 XML）
const inputFiles = [];

function record(anchor, rawState, detail, where) {
  const caseId = anchor.split(':')[0];
  if (!allIds.has(caseId)) {
    if (!seenUnknown.has(anchor)) seenUnknown.set(anchor, []);
    seenUnknown.get(anchor).push(where);
    return;
  }
  if (onlySet && !onlySet.has(caseId)) return; // --only 圈外的 case：不属于本次对账
  const r = results.get(anchor) ?? { states: new Map(), raws: new Set(), details: [] };
  if (rawState) {
    const norm = normalizeState(rawState);
    if (!r.states.has(norm)) r.states.set(norm, []);
    r.states.get(norm).push(where);
    r.raws.add(rawState);
  }
  if (detail) r.details.push(detail);
  results.set(anchor, r);
}

// JUnit XML（各栈通用出口：vitest/jest --reporter=junit、pytest --junitxml、gotestsum、cargo2junit）。
// 只认 xUnit 固定骨架 <testcase name classname> + <failure|error|skipped>，不做通用 XML 解析、不引依赖。
function parseJUnitXml(text, path) {
  const unesc = (s) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (e) =>
    ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[e]);
  let testcases = 0;
  for (const [, attrs, body = ''] of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    testcases++;
    const attr = (n) => attrs.match(new RegExp(`(?:^|\\s)${n}="([^"]*)"`))?.[1] ?? '';
    const name = `${attr('name')} ${attr('classname')}`;
    const a = name.match(ANCHOR)?.[0];
    if (!a) continue;
    const state = /<(?:failure|error)[\s/>]/.test(body) ? 'FAILED' : /<skipped[\s/>]/.test(body) ? 'SKIPPED' : 'PASSED';
    let detail = null;
    if (state === 'FAILED') {
      const raw = unesc(body.match(/<(?:failure|error)[^>]*>([\s\S]*?)<\/(?:failure|error)>/)?.[1] ?? '');
      detail = raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' | ') || null;
    }
    record(a, state, detail, `${path}:${name.trim().slice(0, 60)}`);
  }
  if (testcases === 0) inputIssues.push(`MALFORMED 输入：${path}（声明为 JUnit XML，但没有任何 <testcase>）`);
}

const inputs = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--cases' && arr[i - 1] !== '--only' && arr[i - 1] !== '--meta');
for (const path of inputs) {
  const text = readFileSync(path, 'utf8');
  inputFiles.push(path);
  if (text.trim() === '') {
    inputIssues.push(`MALFORMED 输入：${path}（空输出文件——runner 没有产出任何结果）`);
    continue;
  }
  if (/^\s*(<\?xml|<testsuites?[>\s])/.test(text)) { parseJUnitXml(text, path); continue; }
  const lines = text.split('\n');
  let lastFailAnchor = null;
  lines.forEach((line, idx) => {
    const where = `${path}:${idx + 1}`;
    // 顺序：TAIL 先于 SYMBOL——否则「✓ name CUSTOM_SKIP」会被符号行吞掉尾随状态词而误判 PASSED
    let m = line.match(TAIL);
    if (m) {
      const a = m[1].match(ANCHOR)?.[0];
      if (a) {
        record(a, m[2], null, where);
        lastFailAnchor = m[2] === 'FAILED' ? a : null;
        return;
      }
    }
    m = line.match(LEAD);
    if (m) {
      const a = m[2].match(ANCHOR)?.[0];
      if (a) {
        record(a, m[1], m[3] ?? null, where);
        lastFailAnchor = a;
        return;
      }
    }
    m = line.match(SYMBOL);
    if (m && SYMBOL_STATE[m[1]]) {
      const a = m[2].match(ANCHOR)?.[0];
      if (a) {
        record(a, SYMBOL_STATE[m[1]], null, where);
        lastFailAnchor = SYMBOL_STATE[m[1]] === 'FAILED' ? a : null;
        return;
      }
    }
    // FAILED 后的缩进行 = 失败详情，挂到最近失败的锚上
    if (lastFailAnchor && /^\s+\S/.test(line)) {
      const r = results.get(lastFailAnchor);
      if (r && !r.details.includes(line.trim())) r.details.push(line.trim());
    } else if (line.trim() !== '') {
      lastFailAnchor = null;
    }
  });
}

// ── 归并：同锚多状态 = AMBIGUOUS（重复身份不容赢家）──
const anchorStatus = new Map(); // anchor → { status, raw, wheres, details }
for (const [anchor, r] of results) {
  if (r.states.size === 0) continue;
  if (r.states.size > 1) {
    const mix = [...r.states.entries()].map(([st, ws]) => `${st}@${ws[0]}`).join('、');
    anchorStatus.set(anchor, { status: 'AMBIGUOUS', raw: mix, wheres: [...r.states.values()].flat(), details: r.details });
  } else {
    const [[st, ws]] = [...r.states.entries()];
    const raw = [...r.raws].join('/');
    anchorStatus.set(anchor, { status: st, raw, wheres: ws, details: r.details });
  }
}

// ── 档位/依赖门：L2+ 或 REAL 依赖必须有 --meta 证明，降级即红 ──
const LEVEL_RANK = { L1: 1, L2: 2, L3: 3, L4: 4 };
function levelGate(c) {
  const cards = [];
  const requiredLevel = c.verification_level;
  const realDeps = (Array.isArray(c.dependencies) ? c.dependencies : []).filter((d) => d.mode === 'REAL');
  if (!requiredLevel && realDeps.length === 0) return cards;
  if (!meta) {
    if (requiredLevel) cards.push({ code: 'LEVEL-UNPROVEN', note: `要求 ${requiredLevel}，但本次运行没有 --meta 证明执行档位` });
    if (realDeps.length) cards.push({ code: 'MODE-UNPROVEN', note: `要求 REAL 依赖（${realDeps.map((d) => d.name).join('、')}），但没有 --meta 证明依赖模式` });
    return cards;
  }
  if (requiredLevel && LEVEL_RANK[String(meta.verification_level)] < LEVEL_RANK[requiredLevel]) {
    cards.push({ code: 'VERIFICATION_LEVEL_MISMATCH', note: `要求 ${requiredLevel}，实际执行 ${meta.verification_level ?? '未声明'}` });
  }
  for (const d of realDeps) {
    const mode = meta.dependency_modes?.[d.name] ?? meta.dependency_mode;
    if (mode === 'MOCK' || mode === 'FAKE') {
      cards.push({ code: 'DEPENDENCY_MODE_MISMATCH', note: `依赖「${d.name}」要求 REAL，实际按 ${mode} 执行——mock 通过只说明满足 mock 契约，不构成真实业务验收` });
    } else if (mode !== 'REAL' && mode !== 'LOCAL') {
      cards.push({ code: 'MODE-UNPROVEN', note: `依赖「${d.name}」要求 REAL，--meta 未证明其模式` });
    }
  }
  return cards;
}

// ── 聚合：required VP 集合 = expect 键（权威期望面），observe 只管展示顺序 ──
const caseVerdicts = [];
const caseReports = [];
for (const c of caseList) {
  const expectKeys = Object.keys(c.expect ?? {});
  const observe = Array.isArray(c.observe) ? c.observe : [];
  const gate = levelGate(c);
  const rows = [];
  const seenPoints = new Set();

  const pointRow = (point) => {
    const anchor = `${c.id}:${point}`;
    seenPoints.add(point);
    const r = anchorStatus.get(anchor);
    if (!r) {
      return { point, anchor, status: 'MISSING', raw: null, verdict: VERDICT_OF.MISSING, details: [], where: null,
        note: '未在输出中发现' };
    }
    return { point, anchor, status: r.status, raw: r.raw, verdict: VERDICT_OF[r.status] ?? 'INVALID', details: r.details, where: r.wheres[0] };
  };

  for (const point of observe) {
    if (!expectKeys.includes(point)) {
      seenPoints.add(point);
      rows.push({ point, anchor: `${c.id}:${point}`, status: 'UNEXPECTED', raw: null, verdict: 'INVALID', details: [], where: null,
        note: '声明了观察点但 expect 缺此键——case 源不完整，无法验证' });
      continue;
    }
    rows.push(pointRow(point));
  }
  for (const key of expectKeys) {
    if (!seenPoints.has(key)) rows.push({ ...pointRow(key), note: 'expect 键未列入 observe（仍按 required 验证）' });
  }

  // 输出里有、但 case 没声明的锚（adapter drift / 结果映射错的信号）
  for (const [anchor, info] of anchorStatus) {
    if (!anchor.startsWith(`${c.id}:`)) continue;
    const point = anchor.slice(c.id.length + 1);
    if (!seenPoints.has(point)) {
      rows.push({ point, anchor, status: 'UNEXPECTED', raw: info.raw, verdict: 'INVALID', details: [], where: info.wheres[0],
        note: 'case 未声明此观察点，输出里多出的结果' });
      seenPoints.add(point);
    }
  }

  if (expectKeys.length === 0) {
    rows.push({ point: '—', anchor: `${c.id}:`, status: 'MALFORMED', raw: null, verdict: 'INVALID', details: [], where: null,
      note: 'case 没有任何 expect 键——无可验证的观察点，谈不上通过' });
  }
  for (const g of gate) {
    rows.push({ point: g.code, anchor: `${c.id}:${g.code}`, status: 'INVALID', raw: null, verdict: 'INVALID', details: [], where: null,
      note: g.note });
  }

  const verdicts = rows.map((r) => r.verdict);
  const verdict = verdicts.includes('FAIL') ? 'FAIL'
    : verdicts.includes('INVALID') ? 'INVALID'
      : verdicts.includes('UNVERIFIED') ? 'UNVERIFIED'
        : 'PASS';
  caseVerdicts.push(verdict);
  caseReports.push({ case: c, rows, verdict, gate });
}

const suitePass = caseVerdicts.every((v) => v === 'PASS') && seenUnknown.size === 0 && inputIssues.length === 0;
const exitCode = suitePass ? 0 : 1;

// ── 输出 ──
const firstFailOf = (rows) => rows.find((r) => r.status === 'FAILED') ?? null;
const firstNonPassOf = (rows) => rows.find((r) => r.status !== 'PASSED') ?? null;

// 非通过行的补充说明；状态词本身由格式器拼，note 只写业务含义
const NOTE_OF = { SKIPPED: '未验证，不算通过', ABORTED: '中止，不算通过', ERROR: '执行出错', XFAIL: '预期失败，未验证', XPASS: '意外通过，可疑', UNKNOWN: '未识别状态' };
function rowText(r, caseRows) {
  const icon = ICON[r.status] ?? '!';
  let suffix = '';
  if (r.status === 'FAILED') {
    if (firstFailOf(caseRows) === r) suffix = '  ← 首个失败';
  } else if (r.status === 'MISSING') {
    suffix = `（${r.note}）`;
  } else if (r.status !== 'PASSED') {
    const raw = r.raw && r.raw !== r.status ? ` ← ${r.raw}` : '';
    const note = r.note ? ` — ${r.note}` : NOTE_OF[r.status] ? ` — ${NOTE_OF[r.status]}` : '';
    suffix = `（${r.status}${raw}${note}）`;
  }
  const line = `  ${icon} ${r.point}${suffix}`;
  const details = r.status === 'FAILED' ? r.details.map((d) => `      ${d}`) : [];
  return [line, ...details].join('\n');
}

const blocks = [];
for (const { case: c, rows, verdict, gate } of caseReports) {
  const body = rows.map((r) => rowText(r, rows)).join('\n');
  if (verdict === 'PASS') blocks.push(`✅ ${c.id} ${c.name ?? ''}\n${body}`);
  else if (verdict === 'FAIL') blocks.push(`❌ ${c.id} ${c.name ?? ''}\n${body}`);
  else if (verdict === 'INVALID') blocks.push(`❗ ${c.id} ${c.name ?? ''} —— 存在无效结果（! 行）\n${body}`);
  else blocks.push(`⚠️  ${c.id} ${c.name ?? ''} —— 未验证，不得计为通过\n${body}`);
}

const statusCounts = {};
for (const { rows } of caseReports) {
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
}
const verdictCounts = { PASS: 0, FAIL: 0, UNVERIFIED: 0, INVALID: 0 };
for (const v of caseVerdicts) verdictCounts[v]++;

if (asJson) {
  const out = {
    run: {
      run_id: meta?.run_id ?? null,
      when: meta?.when ?? null,
      commit_sha: meta?.commit_sha ?? null,
      frozen_sha: meta?.frozen_sha ?? null,
      runner: meta?.runner ?? null,
      environment: meta?.environment ?? null,
      verification_level: meta?.verification_level ?? null,
      dependency_mode: meta?.dependency_mode ?? null,
      dependency_modes: meta?.dependency_modes ?? null,
      inputs: inputFiles,
      tool: 'report.mjs',
    },
    suite: {
      verdict: suitePass ? 'GREEN' : 'NON-GREEN',
      exit_code: exitCode,
      cases: verdictCounts,
      verification_points: statusCounts,
      malformed_inputs: inputIssues,
    },
    orphan_anchors: [...seenUnknown.entries()].map(([anchor, ats]) => ({ anchor, where: ats[0] })),
    cases: caseReports.map(({ case: c, rows, verdict, gate }) => ({
      case_id: c.id,
      case_name: c.name ?? '',
      source: c._source ?? null,
      verdict,
      gate: gate.map((g) => ({ code: g.code, note: g.note })),
      verification_points: rows.map((r) => ({
        id: r.point,
        status: r.status,
        normalized_status: r.status,
        raw_status: r.raw,
        verdict: r.verdict,
        note: r.note ?? '',
        details: r.details,
        where: r.where,
        first_fail: r.status !== 'PASSED' && (firstFailOf(rows)?.point ?? firstNonPassOf(rows)?.point) === r.point,
      })),
    })),
  };
  console.log(JSON.stringify(out, null, 2));
} else {
  if (meta && (meta.run_id || meta.when || meta.commit_sha)) {
    const bits = [meta.run_id, meta.when, meta.commit_sha ? `commit ${String(meta.commit_sha).slice(0, 12)}` : null].filter(Boolean);
    console.log(`Run: ${bits.join(' · ')}${meta.verification_level ? ` · 档位 ${meta.verification_level}` : ''}${meta.dependency_mode ? ` · 依赖 ${meta.dependency_mode}` : ''}`);
  }
  console.log(blocks.join('\n\n'));
  for (const issue of inputIssues) console.log(`❗ ${issue}`);
  if (seenUnknown.size) {
    console.log(`\n🔴 无源锚（case 集里没有）：`);
    for (const [a, ats] of seenUnknown) console.log(`   ${a}  ${ats[0]}`);
  }
  const vpParts = Object.entries(statusCounts).map(([st, n]) => `${n} ${st}`).join(' · ');
  console.log(`\nSuite: ${suitePass ? 'GREEN' : 'NON-GREEN'}`);
  console.log(`Cases: ${verdictCounts.PASS} PASS · ${verdictCounts.FAIL} FAIL · ${verdictCounts.UNVERIFIED} UNVERIFIED · ${verdictCounts.INVALID} INVALID（共 ${caseList.length}）`);
  console.log(`Verification points: ${vpParts || '0'}`);
  if (!suitePass && meta === null) {
    const needs = caseReports.some(({ case: c }) => c.verification_level || (Array.isArray(c.dependencies) && c.dependencies.some((d) => d.mode === 'REAL')));
    if (needs) console.log(`提示：case 集里有 L2+ 档位或 REAL 依赖要求，本次运行未提供 --meta，相关 case 按 UNPROVEN 处理。`);
  }
}
process.exit(exitCode);
