#!/usr/bin/env node
// explorer —— cases.yaml → Case Explorer（本地只读审阅面：浏览 / 筛选 / 审阅 / 便签 / 生成指令）。
// 与 gen-view.mjs 的分工：gen-view 是「案卷审阅」的单向渲染（六种 style，叙事/索引/工作台…）；
// explorer 是一个客户端有状态应用（Card/List 双视图 + Filter + Drawer + IndexedDB 便签 + Prompt Composer），
// 因此独立成脚本，gen-view 一字不动（narrative 布局与 demo 已验收视图保持字节一致）。
//
// 数据来源与复用：
//   yaml-lite.mjs      —— YAML 子集解析（parseYaml / numEq / isUndecidable），与其它脚本同源
//   frozen 快照        —— 有快照的 case 视作 FROZEN（v1 数据唯一可推断的生命周期事实）
//   runs.json          —— 最近一次运行的实际值，按锚点 CASE-003:checkpoint_c_total 取值判定
//   铁律 2/5 的判定内核与 gen-view 同构（judge 语义），见 judge-run 段落
//
// 用法：
//   node explorer.mjs --cases cases.yaml [--frozen frozen.md] [--runs runs.json]
//        [--title <品牌名>] --out case-explorer.html
//
// 存储边界：生出的 HTML 只读 Case 源；UI 偏好进 localStorage，便签进 IndexedDB。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, numEq, isUndecidable, isDecimal } from './yaml-lite.mjs';

// ── CLI ──
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
function fail(msg) {
  console.error(`explorer: ${msg}`);
  process.exit(2);
}
function loadYaml(path, what) {
  if (!path) fail(`缺少 --${what}`);
  return parseYaml(readFileSync(path, 'utf8'));
}

const casesPath = arg('cases');
const frozenPath = arg('frozen');
const runsPath = arg('runs');
const title = arg('title', 'Case 库');
const outPath = arg('out');
if (!casesPath) fail('缺少 --cases');
if (!outPath) fail('缺少 --out');

const cases = loadYaml(casesPath, 'cases').cases;
if (!Array.isArray(cases) || cases.length === 0) fail('cases 文件中没有 case');
const frozenMap = frozenPath ? (loadYaml(frozenPath, 'frozen').frozen ?? {}) : null;
const runs = runsPath ? JSON.parse(readFileSync(runsPath, 'utf8')) : null;
if (runs && (typeof runs !== 'object' || Array.isArray(runs))) fail('--runs 文件须是 JSON 对象');

// ── 枚举（v2 的受控词表；v1 缺字段时留空或按事实推断，不编造）──
const LC = ['DRAFT', 'REVIEW', 'CONFIRMED', 'FROZEN'];
const HL = ['ACTIVE', 'STALE', 'BROKEN', 'DEPRECATED'];
const TYPES = ['HAPPY_PATH', 'BOUNDARY', 'STATE', 'ERROR', 'CONCURRENCY', 'REGRESSION'];
const LEVELS = ['L1', 'L2', 'L3', 'L4'];
const PRIOS = ['P0', 'P1', 'P2', 'P3'];
const MODES = ['MOCK', 'FAKE', 'LOCAL', 'REAL'];
const picked = (list, v) => (typeof v === 'string' && list.includes(v) ? v : '');

const s = (v, fallback = '') => (v === null || v === undefined ? fallback : String(v));

// given 白话（与 gen-view 同一规则，v1 数据的降级展示）
function givenProse(given, units) {
  const bal = Object.entries(given.balances ?? {})
    .map(([u, v]) => `${u} 账上有 ${Number(v)} 元`).join('；');
  const stock = Object.entries(given.stock ?? {})
    .map(([k, v]) => `${k} 还剩 ${Number(v)} ${units[`stock_${k}`] ?? '个'}`).join('，');
  // 只有余额或只有库存时不能拼出前导「。」（v2 里无余额的 case 会暴露这一点）
  return [bal ? `${bal}。` : '', stock ? `库存：${stock}。` : ''].join('');
}

// when 的结构化摘要：单动作 flow map / 动作序列都压成一行可读参数
function whenStruct(when) {
  const acts = Array.isArray(when) ? when : when ? [when] : [];
  return acts.map((a, i) =>
    (acts.length > 1 ? `[${i + 1}] ` : '') +
    Object.entries(a).map(([k, v]) => `${k}=${v}`).join(' ')).join('\n');
}

// expected 的显示单位：显式 units 优先，其次小数默认「元」
function unitOf(key, value, units) {
  return units[key] ?? (isDecimal(value) ? '元' : null);
}

// ── VP：v2 结构化 verification_points 优先；v1 由 observe/expect 逐点等价映射 ──
function buildVPs(c, narrative, units) {
  const explicit = Array.isArray(c.verification_points) && c.verification_points.length
    ? c.verification_points : null;
  if (explicit) {
    return explicit.map((vp, i) => {
      const source = s(vp.source);
      const expected = vp.expected !== undefined ? vp.expected : (c.expect ?? {})[source];
      return {
        id: s(vp.id, `VP-${String(i + 1).padStart(3, '0')}`),
        name: s(vp.name, narrative.where?.[source] ?? source),
        target: s(vp.target),
        source,
        operator: s(vp.operator, '=='),
        expected: expected === undefined || expected === null ? '—' : expected,
        unit: unitOf(source, expected, units),
        severity: s(vp.severity),
        example: s(vp.example_query),
        derived: false,
        bad: isUndecidable(expected),
      };
    });
  }
  return Object.entries(c.expect ?? {}).map(([key, value], i) => ({
    id: `VP-${String(i + 1).padStart(3, '0')}`,
    name: s(narrative.where?.[key], key),
    target: s(narrative.where?.[key], key),
    source: key,
    operator: '==',
    expected: value,
    unit: unitOf(key, value, units),
    severity: '',
    example: '',
    derived: true,
    bad: isUndecidable(value),
  }));
}

// ── 运行结果：case 内嵌 latest_run 优先，否则由 runs.json 现算一次（铁律 2/5 的判定内核）──
function buildRun(c, vps, id) {
  const explicit = c.latest_run;
  if (explicit && typeof explicit === 'object') {
    const results = (Array.isArray(explicit.results) ? explicit.results : []).map((r) => ({
      vp_id: s(r.vp_id),
      source: s(r.source),
      expected: r.expected === undefined ? '—' : r.expected,
      actual: r.actual === undefined ? null : r.actual,
      status: s(r.status),
      message: s(r.message),
    }));
    return {
      status: s(explicit.status, 'NOT_RUN'),
      started_at: s(explicit.started_at),
      duration_ms: explicit.duration_ms ?? null,
      environment: s(explicit.environment),
      failure_stage: s(explicit.failure_stage),
      logs: s(explicit.logs),
      results,
      source_note: '',
    };
  }
  if (!runs) return null;
  const results = vps.filter((v) => v.source && !v.bad).map((v) => {
    const actual = runs[`${id}:${v.source}`];
    if (actual === undefined) {
      return { vp_id: v.id, source: v.source, expected: v.expected, actual: null, status: 'NOT_RUN', message: '' };
    }
    return {
      vp_id: v.id, source: v.source, expected: v.expected, actual, status: numEq(v.expected, actual) ? 'PASS' : 'FAIL', message: '',
    };
  });
  const ran = results.filter((r) => r.status === 'PASS' || r.status === 'FAIL').length;
  const fail = results.filter((r) => r.status === 'FAIL');
  return {
    status: !ran ? 'NOT_RUN' : fail.length ? 'FAIL' : 'PASS',
    started_at: s(runs._meta?.captured),
    duration_ms: null,
    environment: s(runs._meta?.source),
    failure_stage: fail.length ? 'ASSERTION' : '',
    logs: '',
    results,
    source_note: `来源：${runsPath ?? 'runs.json'}（按锚点取值，expected vs actual 由 numEq 判定）`,
  };
}

function applyRun(vps, run) {
  if (!run) return;
  for (const v of vps) {
    const r = run.results.find((x) => (x.vp_id && x.vp_id === v.id) || (x.source && x.source === v.source));
    if (!r) { v.status = run.status === 'NOT_RUN' ? 'NOT_RUN' : 'NOT_RUN'; v.actual = null; v.message = ''; continue; }
    v.status = r.status || 'NOT_RUN';
    v.actual = r.actual === undefined ? null : r.actual;
    v.message = r.message;
  }
}

function buildModel(list) {
  return list.map((c) => {
    const id = s(c.id);
    const narrative = c.narrative ?? {};
    const units = c.units ?? narrative.units ?? {};
    const changes = (Array.isArray(c.changes) ? c.changes : []).map((ch) => ({
      v: ch.v ?? 1, when: s(ch.when), what: s(ch.what), scope: s(ch.scope), by: s(ch.by),
    }));
    const frozen = frozenMap ? Object.prototype.hasOwnProperty.call(frozenMap, id) : false;
    const given = c.given ?? {};
    const vps = buildVPs(c, narrative, units);
    const run = buildRun(c, vps, id);
    applyRun(vps, run);
    const bad = vps.some((v) => v.bad);
    const version = c.version ?? (changes.length ? changes[changes.length - 1].v : 1);
    const updated = (changes.length ? changes[changes.length - 1].when : null) ?? s(c.created);
    const description = s(c.description, narrative.scene ?? '');
    const then = Array.isArray(c.then) ? c.then.map((t) => s(t)) : [];
    const tests = (Array.isArray(c.tests) ? c.tests : []).map((t) => ({
      id: s(t.id), type: s(t.type), framework: s(t.framework), file: s(t.file),
      status: s(t.status, 'PENDING'), last_run: s(t.last_run), failure_reason: s(t.failure_reason),
    }));
    const runObj = run && {
      ...run,
      ok: run.results.filter((r) => r.status === 'PASS').length,
      fail: run.results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR').map((r) => r.vp_id || r.source),
      expected_red: run.failure_stage === 'EXPECTED_RED' || s(c.latest_run?.failure_stage) === 'EXPECTED_RED' ||
        tests.some((t) => t.status === 'EXPECTED_RED'),
    };
    const tags = (Array.isArray(c.tags) ? c.tags : []).map((t) => s(t)).filter(Boolean);
    const business = s(c.business, narrative.group ?? '未分类');
    const model = {
      id,
      name: s(c.name),
      description,
      business,
      tags,
      type: picked(TYPES, c.type),
      lifecycle: picked(LC, c.lifecycle) || (frozen ? 'FROZEN' : 'DRAFT'),
      health: picked(HL, c.health) || (bad ? 'BROKEN' : 'ACTIVE'),
      priority: picked(PRIOS, c.priority),
      level: picked(LEVELS, c.verification_level),
      version,
      created: s(c.created),
      createdBy: s(c.created_by),
      updatedBy: s(c.updated_by),
      updated,
      changes,
      given: {
        balances: given.balances ?? {},
        stock: given.stock ?? {},
        stockUnits: Object.fromEntries(Object.entries(units)
          .filter(([k]) => k.startsWith('stock_')).map(([k, v]) => [k.slice(6), v])),
        inputs: Array.isArray(given.inputs) ? given.inputs.map((x) => s(x)) : [],
        preconditions: Array.isArray(given.preconditions) ? given.preconditions.map((x) => s(x)) : [],
        environment: s(given.environment, s(c.environment)),
      },
      given_prose: s(c.given_prose, givenProse(given, units)),
      units,
      when_prose: s(narrative.when, s(c.when_prose)),
      when_struct: whenStruct(c.when),
      then,
      invariants: (Array.isArray(c.invariants) ? c.invariants : []).map((iv) => ({
        id: s(iv.id), description: s(iv.description), expression: s(iv.expression),
        severity: s(iv.severity), verification_status: s(iv.verification_status),
      })),
      vps,
      dependencies: (Array.isArray(c.dependencies) ? c.dependencies : []).map((d) => ({
        name: s(d.name, s(d.type)), type: s(d.type), mode: picked(MODES, d.mode),
        configuration: s(d.configuration), mock_behavior: s(d.mock_behavior),
      })),
      tests,
      run: runObj,
      frozen,
    };
    model.search = [model.id, model.name, model.description, tags.join(' '), model.type, model.lifecycle,
      model.health, model.priority, model.level? `L${model.level.slice(1)}` : '', model.level].join(' ').toLowerCase();
    return model;
  });
}

const model = buildModel(cases);
const suspicious = model.filter((m) => m.health === 'BROKEN' || (m.run && m.run.fail.length)).length;
const data = {
  title,
  generated_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
  source: { cases: casesPath, frozen: frozenPath ?? null, runs: runsPath ?? null },
  counts: { total: model.length, frozen: model.filter((m) => m.frozen).length, suspicious },
  cases: model,
};

// ── 生成：数据 + 客户端代码全部内联（零外链、零依赖、零构建）──
const clientPath = fileURLToPath(new URL('./explorer-client.js', import.meta.url));
const client = readFileSync(clientPath, 'utf8');
const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028');

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Case Explorer · ${title.replace(/[<&]/g, (m) => (m === '<' ? '&lt;' : '&amp;'))}</title>
</head><body>
<script>const DATA = ${json};</script>
<script>${client}</script>
</body></html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);
console.log(`OK → ${outPath}（${model.length} case · 已封金 ${data.counts.frozen} · 可疑 ${suspicious} · ` +
  `VP ${model.reduce((a, m) => a + m.vps.length, 0)} · ${(html.length / 1024).toFixed(0)} KB）`);
