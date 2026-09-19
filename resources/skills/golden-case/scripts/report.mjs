#!/usr/bin/env node
// report —— 测试输出 → 按 CASE 聚合报告（首个失败观察点优先）。
// 用法：node report.mjs --cases <yaml|目录> <junit-or-pytest-output.txt>...
// 解析 v1：JUnit 控制台（Gradle 风格「Class > displayName STATE」+ 缩进失败详情）
// 与 pytest 文本（verbose 行 + 短摘要行）。测试名里含锚 CASE-XXX:point 即认。
import { readFileSync } from 'node:fs';
import { loadCases } from './cases-source.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const casesPath = arg('cases');
if (!casesPath) {
  console.error('report: 缺少 --cases');
  process.exit(2);
}
const caseList = loadCases(casesPath);
const order = new Map(caseList.map((c, i) => [c.id, i]));

// Gradle 风格：ClassName > displayName PASSED|FAILED|SKIPPED|ABORTED
const GRADLE = /^[\w.$-]+\s*>\s*(.+?)\s+(PASSED|FAILED|SKIPPED|ABORTED)\s*$/;
// pytest 短摘要：FAILED path::test[...] - assert ...
const PY_SHORT = /^(FAILED|ERROR)\s+(\S+?)(?:\s+-\s*(.*))?$/;
// pytest verbose：path::test[...] PASSED|FAILED|ERROR|SKIPPED|XFAIL
const PY_VERBOSE = /^(\S+::\S+?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL)\s*$/;
const ANCHOR = /CASE-\d{3}(?::[A-Za-z0-9_.-]+)?/;

const results = new Map(); // "CASE-001:api_return" → {state, detail}
const seenUnknown = new Map(); // case 集外的锚 → [位置]

function record(anchor, state, detail, where) {
  const caseId = anchor.split(':')[0];
  if (!order.has(caseId)) {
    if (!seenUnknown.has(anchor)) seenUnknown.set(anchor, []);
    seenUnknown.get(anchor).push(where);
    return;
  }
  const r = results.get(anchor) ?? { state: null, details: [] };
  if (detail) r.details.push(detail);
  // 多份输出里同锚重复：FAILED 优先呈现，其余以最后一次为准
  if (state === 'FAILED' || r.state !== 'FAILED') r.state = state;
  results.set(anchor, r);
}

const inputs = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--cases');
for (const path of inputs) {
  const lines = readFileSync(path, 'utf8').split('\n');
  let lastFailAnchor = null;
  lines.forEach((line, idx) => {
    const where = `${path}:${idx + 1}`;
    let m = line.match(GRADLE) ?? line.match(PY_VERBOSE);
    if (m) {
      const [, name, state] = m;
      const a = name.match(ANCHOR)?.[0];
      if (a) {
        record(a, state, null, where);
        lastFailAnchor = state === 'FAILED' ? a : null;
        return;
      }
    }
    m = line.match(PY_SHORT);
    if (m) {
      const a = m[2].match(ANCHOR)?.[0];
      if (a) {
        record(a, m[1], m[3] ?? null, where);
        lastFailAnchor = a;
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

// ── 聚合输出 ──
const ICON = { PASSED: '✓', FAILED: '✗', SKIPPED: '○', ABORTED: '!', ERROR: '✗', XFAIL: '×' };
let green = 0;
const blocks = [];
for (const c of caseList) {
  const rows = [];
  let failed = false;
  for (const point of c.observe ?? []) {
    const anchor = `${c.id}:${point}`;
    const r = results.get(anchor);
    if (!r) {
      rows.push(`  · ${point}（未在输出中发现）`);
      continue;
    }
    rows.push(`  ${ICON[r.state] ?? '?'} ${point}${r.state === 'FAILED' ? '  ← 首个失败' : ''}`);
    if (r.state === 'FAILED') {
      failed = true;
      for (const d of r.details) rows.push(`      ${d}`);
    }
  }
  const extra = (c.observe ?? []).filter((p) => !results.has(`${c.id}:${p}`)).length;
  if (failed) {
    blocks.push(`❌ ${c.id} ${c.name}\n${rows.join('\n')}`);
  } else if (extra === (c.observe ?? []).length && (c.observe ?? []).length > 0) {
    blocks.push(`⚠️  ${c.id} ${c.name} —— 未在测试输出中发现\n${rows.join('\n')}`);
  } else {
    green++;
    blocks.push(`✅ ${c.id} ${c.name}\n${rows.join('\n')}`);
  }
}

console.log(blocks.join('\n\n'));
if (seenUnknown.size) {
  console.log(`\n🔴 无源锚（case 集里没有）：`);
  for (const [a, ats] of seenUnknown) console.log(`   ${a}  ${ats[0]}`);
}
console.log(`\n汇总：${green}/${caseList.length} case 全绿，输出中锚点 ${results.size} 个。`);
process.exit(green === caseList.length && seenUnknown.size === 0 ? 0 : 1);
