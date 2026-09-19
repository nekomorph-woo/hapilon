#!/usr/bin/env node
// audit —— 覆盖审计：测试代码里的 CASE 锚 ↔ case 集对账。
// 用法：node audit.mjs --cases cases.yaml --tests <dir|file>...
// 三类异常：
//   UNOWNED  无主 case：case 集里有，但没有任何测试代码引用
//   ORPHAN   无源 test：测试代码引用了 case 集里不存在的 CASE-XXX
//   LITERAL  期望字面量嫌疑：断言行写死了金标值（铁律 2：断言值必须从 case 文件加载）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml-lite.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const casesPath = arg('cases');
if (!casesPath) {
  console.error('audit: 缺少 --cases');
  process.exit(2);
}
const caseIds = new Map(
  (parseYaml(readFileSync(casesPath, 'utf8')).cases ?? []).map((c) => [c.id, c]),
);

// 收集待扫文本（.java/.py/.kt/.ts/.js/.mjs）
const TEXT_EXT = /\.(java|py|kt|ts|js|mjs)$/;
function collect(path, out) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === '__pycache__' || name === 'node_modules') continue;
      collect(join(path, name), out);
    }
  } else if (TEXT_EXT.test(path)) {
    out.push({ path, text: readFileSync(path, 'utf8') });
  }
}
const files = [];
for (const t of (arg('tests') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) collect(t, files);

const ANCHOR = /CASE-\d{3}/g;
const isAssertLine = (l) => /assert|Assert/.test(l);

// 特征值规则：数值取 |v|>=10 或含小数点的（10 以下整数是测试代码常见噪音，不报）；
// 字符串值全查。ponytail: 启发式有漏报/误报天花板，嫌疑值最终由人眼裁决。
function literalPattern(v) {
  const s = String(v);
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!(Math.abs(n) >= 10 || s.includes('.'))) return null;
    return new RegExp(s.replace(/[.]/g, '\\.'));
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    return new RegExp(`["']${s}["']`);
  }
  return null;
}

const unowned = [];
const orphan = [];
const literal = [];
const seen = new Map(); // id → [file:line]

for (const f of files) {
  f.text.split('\n').forEach((line, idx) => {
    for (const m of line.matchAll(ANCHOR)) {
      const id = m[0];
      if (!seen.has(id)) seen.set(id, []);
      seen.get(id).push(`${f.path}:${idx + 1}`);
      if (!caseIds.has(id)) orphan.push({ id, at: `${f.path}:${idx + 1}` });
    }
  });
}

for (const [id, c] of caseIds) {
  if (!seen.has(id)) {
    unowned.push({ id, name: c.name ?? '' });
    continue;
  }
  // 期望字面量：只在引用了该 case 的文件里查，避免跨域误报
  const suspectFiles = new Set(seen.get(id).map((a) => a.split(':')[0] + ':' + a.split(':')[1]).map((p) => p.replace(/:\d+$/, '')));
  for (const [point, v] of Object.entries(c.expect ?? {})) {
    const pat = literalPattern(v);
    if (!pat) continue;
    for (const f of files) {
      if (!seen.get(id).some((a) => a.startsWith(f.path + ':'))) continue;
      f.text.split('\n').forEach((line, idx) => {
        if (isAssertLine(line) && pat.test(line)) {
          literal.push({ ref: `${id}:${point}`, value: String(v), at: `${f.path}:${idx + 1}` });
        }
      });
    }
  }
}

let bad = false;
if (unowned.length) {
  bad = true;
  console.log(`🟡 无主 case（case 集里有，但没有任何测试代码引用）×${unowned.length}`);
  for (const u of unowned) console.log(`   ${u.id}  ${u.name}`);
  console.log('');
}
if (orphan.length) {
  bad = true;
  console.log(`🔴 无源 test（引用了 case 集里不存在的 CASE）×${orphan.length}`);
  for (const o of orphan) console.log(`   ${o.id}  ${o.at}`);
  console.log('');
}
if (literal.length) {
  bad = true;
  console.log(`🟡 期望字面量嫌疑（断言行疑似写死金标，铁律 2）×${literal.length}`);
  for (const l of literal) console.log(`   ${l.ref} = ${l.value}  ${l.at}`);
  console.log('');
}
if (!bad) {
  console.log(`🟢 审计通过：${caseIds.size} 个 case 全部有主，无无源锚，无字面量嫌疑（扫了 ${files.length} 个文件）`);
}
process.exit(bad ? 1 : 0);
