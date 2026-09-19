#!/usr/bin/env node
// freeze-check —— case expect vs frozen 快照 diff，红牌报告（铁律 4：冻结后只有用户能改期望）。
// 用法：node freeze-check.mjs --cases a.yaml,b.yaml --frozen frozen.md
// 红牌三类：case 缺失（含「为转绿偷改后删 case」）、期望键被删、期望值被改。命中即 exit 1。
import { readFileSync } from 'node:fs';
import { parseYaml, numEq } from './yaml-lite.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function loadYaml(path, what) {
  if (!path) {
    console.error(`freeze-check: 缺少 --${what}`);
    process.exit(2);
  }
  return parseYaml(readFileSync(path, 'utf8'));
}

const casesPaths = arg('cases')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
const frozenPath = arg('frozen');
const frozen = loadYaml(frozenPath, 'frozen').frozen ?? {};

// 多个 case 文件合并；重复 id 视为后者覆盖（拆文件管理的场景）
const cases = new Map();
for (const p of casesPaths) {
  for (const c of loadYaml(p, 'cases').cases ?? []) cases.set(c.id, c);
}

const cards = [];
for (const [id, snaps] of Object.entries(frozen)) {
  const c = cases.get(id);
  if (!c) {
    cards.push({ id, point: '—', kind: 'CASE-MISSING', msg: '冻结的 case 在 case 集里找不到了（被删或被改名）', frozenV: '(整个 case)', caseV: '不存在' });
    continue;
  }
  for (const [point, want] of Object.entries(snaps)) {
    if (!(point in (c.expect ?? {}))) {
      cards.push({ id, point, kind: 'KEY-REMOVED', msg: '冻结的期望键被删除', frozenV: String(want), caseV: '(键不存在)' });
    } else if (!numEq(c.expect[point], want)) {
      cards.push({ id, point, kind: 'CHANGED', msg: '冻结的期望值被改动 —— 先问：是实现错了，还是有人想让测试转绿？', frozenV: String(want), caseV: String(c.expect[point]) });
    }
  }
}

if (cards.length === 0) {
  console.log(`🟢 全绿：${Object.keys(frozen).length} 个冻结 case 与 case 集完全一致（${cases.size} 个 case）`);
  process.exit(0);
}

console.log(`🟥 红牌 ${cards.length} 张 —— 冻结快照与 case 集不一致：\n`);
for (const k of cards) {
  console.log(`  ${k.id}:${k.point} [${k.kind}] ${k.msg}`);
  console.log(`    frozen: ${k.frozenV}`);
  console.log(`    case:   ${k.caseV}\n`);
}
console.log('冻结后的期望只有需求方能改：恢复 frozen 值，或让需求方重新确认并更新 frozen 文件。');
process.exit(1);
