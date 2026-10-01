#!/usr/bin/env node
// freeze-check —— case expect vs frozen 快照 diff，红牌报告（铁律 4：冻结后只有用户能改期望）。
// 用法：node freeze-check.mjs --cases <yaml|目录>[,<yaml|目录>...] --frozen frozen.md
// 红牌两类：快照 drift（case 缺失、期望键被删、期望值被改）与 provenance drift
// （v3 快照的依据内容/绑定被改、依据未随 case 冻结、provenance 结构非法）。
// 命中即 exit 1。恢复办法只有一种：恢复快照原值；确需改动则新版本 + 用户重新确认 + 再冻结。
import { readFileSync } from 'node:fs';
import { parseYaml, numEq } from './yaml-lite.mjs';
import { loadCasesOrExit, parseYamlOrExit } from './cases-source.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function loadYaml(path, what) {
  if (!path) {
    console.error(`freeze-check: 缺少 --${what}`);
    process.exit(2);
  }
  return parseYamlOrExit(readFileSync(path, 'utf8'), 'freeze-check');
}

// ── provenance（business_basis / expect_basis）的共享语义 ──
// basis 的内容字段：任一变化都算被篡改。based_on 只表达依赖集合，顺序不参与语义。
const BASIS_FIELDS = ['kind', 'statement', 'reference', 'excerpt', 'confirmed_by', 'confirmed_on', 'based_on', 'expression'];
const BASIS_KINDS = ['USER_CONFIRMATION', 'SOURCE', 'DERIVATION'];
// 各 kind 冻结时的必填字段（format.md 的 provenance 规则）
const BASIS_REQUIRED = {
  USER_CONFIRMATION: ['statement', 'excerpt', 'confirmed_by', 'confirmed_on'],
  SOURCE: ['statement', 'reference', 'excerpt', 'confirmed_by', 'confirmed_on'],
  DERIVATION: ['statement', 'based_on', 'expression', 'confirmed_by', 'confirmed_on'],
};
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const BASIS_ID_RE = /^BASIS-\d+$/;
// 必填字段是非空字符串；可选 reference 若存在也必须是字符串（可以是空串，但类型不能错）
function fieldErrs(id, b) {
  const errs = [];
  for (const f of BASIS_REQUIRED[b.kind]) {
    if (f === 'based_on') continue; // 数组字段，由 based_on 专项检查负责
    const v = b[f];
    if (typeof v !== 'string' || v === '') errs.push(`${id}：${b.kind} 缺必填字段 ${f}（须为非空字符串）`);
  }
  if (b.reference !== undefined && b.reference !== null && typeof b.reference !== 'string') {
    errs.push(`${id}：reference 若存在必须是字符串`);
  }
  return errs;
}

// basis 内容的规范化视图：对象字段顺序与 based_on 顺序不影响相等性
function basisFingerprint(b) {
  return JSON.stringify({
    ...Object.fromEntries(BASIS_FIELDS.filter((f) => f !== 'based_on').map((f) => [f, b[f] ?? null])),
    based_on: Array.isArray(b.based_on) ? b.based_on.map(String).sort() : null,
  });
}

// 校验一串 basis：返回结构错误列表（id 重复、未知 kind、derivation 依赖非法/循环）。
// requireComplete=true 时（冻结语境）再补「必填字段缺失」。
function validateBasis(list, { requireComplete = false } = {}) {
  const errors = [];
  if (!Array.isArray(list)) return ['business_basis 不是列表'];
  const byId = new Map();
  for (const b of list) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) { errors.push('business_basis 含非对象条目'); continue; }
    const id = b.id;
    if (typeof id !== 'string' || !BASIS_ID_RE.test(id)) { errors.push(`basis id 非法「${id ?? ''}」（应为 BASIS-数字）`); continue; }
    if (byId.has(id)) errors.push(`basis id 重复：${id}`);
    byId.set(id, b);
    if (!BASIS_KINDS.includes(b.kind)) { errors.push(`${id}：未知 kind「${b.kind ?? ''}」`); continue; }
    if (requireComplete) errors.push(...fieldErrs(id, b));
    // based_on 在任何 kind 上都参与指纹与依赖遍历（格式在依赖遍历里查）；仅 DERIVATION 要求它非空
    if (b.kind === 'DERIVATION' && (!Array.isArray(b.based_on) || !b.based_on.length)) {
      errors.push(`${id}：DERIVATION 的 based_on 必须是非空数组`);
    }
  }
  // derivation 依赖：只能引用本 case 已存在的 basis id，且不得成环
  const state = new Map(); // id -> 0 visiting | 1 done
  const visit = (id, chain) => {
    const st = state.get(id);
    if (st === 1) return;
    if (st === 0) {
      errors.push(`derivation 依赖成环：${[...chain, id].join(' → ')}`);
      return;
    }
    state.set(id, 0);
    const b = byId.get(id);
    for (const dep of (Array.isArray(b?.based_on) ? b.based_on : [])) {
      if (typeof dep !== 'string' || !BASIS_ID_RE.test(dep)) {
        errors.push(`${id}：based_on 里的「${dep ?? ''}」不是合法 basis id（BASIS-数字）`);
        continue;
      }
      if (!byId.has(dep)) errors.push(`${id}：based_on 引用不存在的 basis「${dep}」`);
      else if (dep === id) errors.push(`${id}：based_on 自引用`);
      else visit(dep, [...chain, id]);
    }
    state.set(id, 1);
  };
  for (const id of byId.keys()) visit(id, []);
  return errors;
}

// 校验 expect_basis：每个映射的 id 都存在；返回错误列表
function validateExpectBasis(expectBasis, basisIds, caseId) {
  const errors = [];
  if (!expectBasis || typeof expectBasis !== 'object' || Array.isArray(expectBasis)) {
    return ['expect_basis 不是映射'];
  }
  for (const [point, ids] of Object.entries(expectBasis)) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) errors.push(`${caseId}:${point} 的 expect_basis 是空列表`);
    for (const bid of list) {
      if (!basisIds.has(bid)) errors.push(`${caseId}:${point} 引用不存在的 basis「${bid}」`);
    }
  }
  return errors;
}

const frozenPath = arg('frozen');
const frozen = loadYaml(frozenPath, 'frozen').frozen ?? {};

// 多个 case 来源合并；重复 id 后者覆盖（拆文件管理的场景）
const cases = new Map(loadCasesOrExit(arg('cases'), 'freeze-check').map((c) => [c.id, c]));

const cards = [];
const push = (id, point, kind, msg, frozenV, caseV) => cards.push({ id, point, kind, msg, frozenV, caseV });

for (const [id, sn] of Object.entries(frozen)) {
  // 快照条目本身必须是映射：null / 标量 / 列表都无法承载冻结语义，报受控红牌而不是拿去遍历
  if (!sn || typeof sn !== 'object' || Array.isArray(sn)) {
    const shape = sn === null || sn === undefined ? 'null' : Array.isArray(sn) ? '列表' : typeof sn;
    push(id, '—', 'SNAPSHOT-INVALID', `frozen 快照条目形状非法（${shape}）——不构成有效冻结依据；按 v3 结构化快照重新冻结`, String(sn), '—');
    continue;
  }
  const c = cases.get(id);
  if (!c) {
    push(id, '—', 'CASE-MISSING', '冻结的 case 在 case 集里找不到了（被删或被改名）', '(整个 case)', '不存在');
    continue;
  }
  // 字段存在性（hasOwnProperty）与字段内容分开判断：空列表 / 类型错误是「声明了但坏」，不是「没声明」
  const hasBB = c != null && typeof c === 'object' && Object.prototype.hasOwnProperty.call(c, 'business_basis');
  const hasEB = c != null && typeof c === 'object' && Object.prototype.hasOwnProperty.call(c, 'expect_basis');
  const hasProvenance = hasBB || hasEB;
  const caseBasis = hasBB && Array.isArray(c.business_basis) ? c.business_basis : [];
  const caseExpectBasis = hasEB && c.expect_basis && typeof c.expect_basis === 'object' && !Array.isArray(c.expect_basis) ? c.expect_basis : null;

  // 容器层错误：缺一边、类型错、空列表——先收集成受控红牌，后面代码不再拿坏容器当 map 用
  const containerErrs = [];
  if (hasBB !== hasEB) containerErrs.push('business_basis / expect_basis 只声明了一边——两字段必须成对登记');
  if (hasBB && !Array.isArray(c.business_basis)) containerErrs.push('business_basis 不是列表');
  else if (hasBB && !caseBasis.length) containerErrs.push('business_basis 是空列表');
  if (hasEB && !caseExpectBasis) containerErrs.push('expect_basis 不是映射');

  // 结构校验不管冻结与否都跑（id 重复 / 未知 kind / 依赖非法在 case 文件里就是坏的）
  const structErrs = [...containerErrs];
  if (hasBB && Array.isArray(caseBasis) && caseBasis.length) structErrs.push(...validateBasis(caseBasis, { requireComplete: true }));
  const basisIds = new Map(caseBasis.filter((b) => b && typeof b === 'object' && b.id).map((b) => [String(b.id), b]));
  if (caseExpectBasis) structErrs.push(...validateExpectBasis(caseExpectBasis, new Set(basisIds.keys()), id));

  // v3 按结构字段识别（expect 映射 / expect_basis / business_basis）；旧式快照里恰好有个叫
  // version 的期望键不算 v3——仅凭标量 version 判型会把 legacy 快照误判
  const snapIsV3 = !!sn && typeof sn === 'object' && !Array.isArray(sn) && (
    (sn.expect && typeof sn.expect === 'object' && !Array.isArray(sn.expect)) ||
    (sn.expect_basis && typeof sn.expect_basis === 'object' && !Array.isArray(sn.expect_basis)) ||
    Array.isArray(sn.business_basis)
  );
  if (!snapIsV3) {
    if (hasProvenance) {
      push(id, '—', 'BASIS-NOT-FROZEN', 'case 已登记业务依据（business_basis / expect_basis），但快照还是旧式 expect 映射——依据不受保护；按 v3 结构化快照重新冻结', '(旧式快照)', `${caseBasis.length} 条依据 · ${caseExpectBasis ? Object.keys(caseExpectBasis).length : 0} 个绑定`);
    }
    for (const [point, want] of Object.entries(sn)) {
      if (!(point in (c.expect ?? {}))) {
        push(id, point, 'KEY-REMOVED', '冻结的期望键被删除', String(want), '(键不存在)');
      } else if (!numEq(c.expect[point], want)) {
        push(id, point, 'CHANGED', '冻结的期望值被改动 —— 先问：是实现错了，还是有人想让测试转绿？', String(want), String(c.expect[point]));
      }
    }
    continue;
  }

  // ── v3 结构化快照 ──
  const snapExpect = sn.expect && typeof sn.expect === 'object' && !Array.isArray(sn.expect) ? sn.expect : null;
  if (!isPosInt(sn.version)) {
    push(id, '—', 'BASIS-VERSION', 'v3 快照缺少正整数 version', String(sn.version), '—');
  }
  const caseVersion = c.version ?? null;
  if (!isPosInt(caseVersion)) {
    push(id, '—', 'BASIS-VERSION', 'v3 case 冻结时必须声明正整数 version', String(sn.version ?? '—'), String(caseVersion ?? '(未声明)'));
  } else if (isPosInt(sn.version) && sn.version !== caseVersion) {
    push(id, '—', 'BASIS-VERSION', '快照 version 与 case version 不一致——改动必须走新版本 + 重新确认 + 再冻结', String(sn.version), String(caseVersion));
  }

  if (!snapExpect) {
    push(id, '—', 'BASIS-INVALID', 'v3 快照缺少 expect 映射', '(无)', '—');
  } else {
    for (const [point, want] of Object.entries(snapExpect)) {
      if (!(point in (c.expect ?? {}))) {
        push(id, point, 'KEY-REMOVED', '冻结的期望键被删除', String(want), '(键不存在)');
      } else if (!numEq(c.expect[point], want)) {
        push(id, point, 'CHANGED', '冻结的期望值被改动 —— 先问：是实现错了，还是有人想让测试转绿？', String(want), String(c.expect[point]));
      }
    }
  }

  if (!hasProvenance) {
    push(id, '—', 'BASIS-INCOMPLETE', 'v3 快照要求 case 带 business_basis / expect_basis，case 里没有', '(快照为 v3)', '(case 无 provenance)');
    continue;
  }
  if (structErrs.length) {
    for (const e of structErrs) {
      // 容器层问题（缺一边 / 类型错 / 空列表）报 BASIS-INCOMPLETE，其余结构问题报 BASIS-INVALID
      const isContainer = containerErrs.includes(e);
      push(id, '—', isContainer ? 'BASIS-INCOMPLETE' : 'BASIS-INVALID', `provenance ${isContainer ? '不完整' : '结构非法'}：${e}`, '—', '—');
    }
    continue; // 结构都不可信，内容比对没有意义
  }

  // expect_basis 绑定：键的增删与绑定的 id 集合变化都红牌（id 列表顺序不影响语义）
  const snapBasis = sn.expect_basis && typeof sn.expect_basis === 'object' && !Array.isArray(sn.expect_basis) ? sn.expect_basis : null;
  if (!snapBasis) {
    push(id, '—', 'BASIS-INVALID', 'v3 快照缺少 expect_basis 绑定表', '(无)', `${Object.keys(caseExpectBasis).length} 个绑定`);
  } else {
    const asSet = (v) => new Set((Array.isArray(v) ? v : [v]).map(String));
    const points = new Set([...Object.keys(snapBasis), ...Object.keys(caseExpectBasis)]);
    for (const point of points) {
      const inSnap = point in snapBasis;
      const inCase = point in caseExpectBasis;
      if (!inCase) { push(id, point, 'BASIS-REBIND', '快照里的依据绑定在 case 中被删除', `[${(Array.isArray(snapBasis[point]) ? snapBasis[point] : [snapBasis[point]]).join(', ')}]`, '(无绑定)'); continue; }
      if (!inSnap) { push(id, point, 'BASIS-REBIND', 'case 给冻结的期望新绑了依据（或原快照缺该绑定）——冻结后的绑定只有用户能改', '(无绑定)', `[${(Array.isArray(caseExpectBasis[point]) ? caseExpectBasis[point] : [caseExpectBasis[point]]).join(', ')}]`); continue; }
      const a = asSet(snapBasis[point]);
      const b = asSet(caseExpectBasis[point]);
      const added = [...b].filter((x) => !a.has(x));
      const removed = [...a].filter((x) => !b.has(x));
      if (added.length || removed.length) {
        push(id, point, 'BASIS-REBIND', `依据绑定被改（${removed.length ? `移除 ${removed.join('/')}` : ''}${removed.length && added.length ? '；' : ''}${added.length ? `新增 ${added.join('/')}` : ''}）`, `[${[...a].sort().join(', ')}]`, `[${[...b].sort().join(', ')}]`);
      }
    }
  }

  // business_basis 内容：按 id 对齐，字段内容任一变化红牌
  const snapBasisList = Array.isArray(sn.business_basis) ? sn.business_basis : null;
  if (!snapBasisList) {
    push(id, '—', 'BASIS-INVALID', 'v3 快照缺少 business_basis 登记表', '(无)', `${caseBasis.length} 条依据`);
  } else {
    const snapErrs = validateBasis(snapBasisList, { requireComplete: true });
    if (snapErrs.length) {
      for (const e of snapErrs) push(id, '—', 'BASIS-INVALID', `快照 provenance 结构非法：${e}`, '—', '—');
    } else {
      const snapById = new Map(snapBasisList.map((b) => [String(b.id), b]));
      for (const [bid, b] of basisIds) {
        const sb = snapById.get(bid);
        if (!sb) { push(id, bid, 'BASIS-ADDED', 'case 里出现了快照没有的依据（冻结后新增依据也要新版本 + 用户确认 + 再冻结）', '(不在快照)', `${b.kind}: ${b.statement ?? ''}`); continue; }
        if (basisFingerprint(sb) !== basisFingerprint(b)) {
          push(id, bid, 'BASIS-CHANGED', '依据内容被改动（statement / reference / excerpt / 确认信息 / 推导式等）——先问：是用户重新确认了，还是有人换了更容易通过的依据？', `${sb.kind}: ${sb.statement ?? ''}`, `${b.kind}: ${b.statement ?? ''}`);
        }
      }
      for (const bid of snapById.keys()) {
        if (!basisIds.has(bid)) push(id, bid, 'BASIS-REMOVED', 'case 登记的依据被删了，快照里还有——依据是金值的一部分，不能删了了事', `${snapById.get(bid).kind}: ${snapById.get(bid).statement ?? ''}`, '(case 中不存在)');
      }
    }
  }

  // 完整性：冻结的 v3 case 每个 expect 键都要有 ≥1 个已存在的依据
  for (const point of Object.keys(c.expect ?? {})) {
    const raw = caseExpectBasis[point];
    const bound = (Array.isArray(raw) ? raw : [raw]).filter((x) => x != null).map(String).filter((x) => basisIds.has(x));
    if (!bound.length) push(id, point, 'BASIS-INCOMPLETE', '冻结 case 的期望没有绑定任何已存在的业务依据', '(至少 1 条)', '(无有效绑定)');
  }
}

// 反查：case 显式声明 FROZEN 但 frozen.md 里没有它的快照——自述与基线矛盾，不能报全绿。
// 边界：case 未显式声明 lifecycle、仅靠「有快照即缺省 FROZEN」的情况无法检测——快照条目被删后
// 没有第二份基线，脚本无从知道它曾经存在；SKILL 规定写 v3 快照时 lifecycle 同时置 FROZEN 来补这条缝。
for (const [id, c] of cases) {
  if (c?.lifecycle === 'FROZEN' && !Object.prototype.hasOwnProperty.call(frozen, id)) {
    push(id, '—', 'LIFECYCLE-UNBACKED', 'case 声明 lifecycle: FROZEN，但 frozen.md 里没有它的快照——恢复 frozen 条目；若确实尚未封金，请用户确认后把 lifecycle 改回真实状态（不得静默降级）', '(无快照)', 'lifecycle: FROZEN');
  }
}

if (cards.length === 0) {
  console.log(`🟢 全绿：${Object.keys(frozen).length} 个冻结 case 与 case 集完全一致，provenance 无 drift（${cases.size} 个 case）`);
  process.exit(0);
}

console.log(`🟥 红牌 ${cards.length} 张 —— 冻结快照与 case 集不一致：\n`);
for (const k of cards) {
  console.log(`  ${k.id}:${k.point} [${k.kind}] ${k.msg}`);
  console.log(`    frozen: ${k.frozenV}`);
  console.log(`    case:   ${k.caseV}\n`);
}
console.log('冻结后的期望与依据只有需求方能改：恢复 frozen 原值；确需改动则创建新版本、由用户重新确认、再重新冻结。');
process.exit(1);
