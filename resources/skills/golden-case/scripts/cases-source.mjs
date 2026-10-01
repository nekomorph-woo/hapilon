// cases-source —— --cases 取值的来源解析（audit / explorer / freeze-check / gen-view / report 共用）。
// 接受三种形态：单个 .yaml 文件、目录（glob 目录内全部 *.yaml，按文件名序）、逗号分隔的多项。
// 目录按文件名升序归并；重复 case id 一律硬失败（DUPLICATE_CASE_ID）——
// Case ID 是金标资产的身份，不是可被加载顺序决定赢家的普通 map key。
// 只解析来源与身份；YAML 子集解析归 yaml-lite.mjs，语义校验归各消费方（零依赖边界不破）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml-lite.mjs';

// 源错误：case 源无效时抛出，所有 CLI 捕获后受控退出（exit 3），不进入执行阶段
export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

// CLI 装载口：源/解析错误统一受控退出（exit 3，区别于红牌 1 与缺参 2），不进执行阶段
export function loadCasesOrExit(spec, script) {
  try {
    return loadCases(spec);
  } catch (e) {
    if (e?.name === 'SourceError' || e?.name === 'YamlLiteError') {
      console.error(`${script}: 源错误[${e.code ?? 'PARSE'}] ${e.message}`);
      process.exit(3);
    }
    throw e;
  }
}

export function parseYamlOrExit(text, script) {
  try {
    return parseYaml(text);
  } catch (e) {
    if (e?.name === 'YamlLiteError') {
      console.error(`${script}: 源错误[PARSE] ${e.message}`);
      process.exit(3);
    }
    throw e;
  }
}

export function casesSources(spec) {
  const out = [];
  for (const raw of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (statSync(raw).isDirectory()) {
      out.push(...readdirSync(raw).filter((f) => f.endsWith('.yaml')).sort().map((f) => join(raw, f)));
    } else {
      out.push(raw);
    }
  }
  return out;
}

const CASE_ID_RE = /^CASE-\d{3}$/;
const VP_ID_RE = /^VP-\d{3}$/;
const LEVEL_RE = /^L[1-4]$/;
const DEP_MODES = new Set(['MOCK', 'FAKE', 'LOCAL', 'REAL']);

// 身份与形状校验：fail-closed，坏源在加载期死掉，绝不带着歧义进入执行/冻结/渲染
function validateCase(c, path) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    throw new SourceError('INVALID_CASE', `${path}：case 条目不是映射（得到 ${Array.isArray(c) ? '列表' : typeof c}）`);
  }
  if (typeof c.id !== 'string' || !CASE_ID_RE.test(c.id)) {
    throw new SourceError('INVALID_CASE', `${path}：case id 非法「${String(c.id)}」（应为 CASE-\\d{3}）`);
  }
  if (c.observe !== undefined) {
    if (!Array.isArray(c.observe) || c.observe.some((p) => typeof p !== 'string' || !p)) {
      throw new SourceError('INVALID_CASE', `${path}：${c.id} 的 observe 必须是字符串列表`);
    }
    const dup = c.observe.find((p, i) => c.observe.indexOf(p) !== i);
    if (dup) throw new SourceError('INVALID_CASE', `${path}：${c.id} 的观察点重复「${dup}」——同一 case 内观察点身份必须唯一`);
  }
  if (c.expect !== undefined && (typeof c.expect !== 'object' || Array.isArray(c.expect))) {
    throw new SourceError('INVALID_CASE', `${path}：${c.id} 的 expect 必须是映射`);
  }
  if (c.verification_points !== undefined) {
    if (!Array.isArray(c.verification_points) || c.verification_points.some((v) => !v || typeof v !== 'object')) {
      throw new SourceError('INVALID_CASE', `${path}：${c.id} 的 verification_points 必须是映射列表`);
    }
    const seen = new Map();
    for (const v of c.verification_points) {
      const id = v.id;
      if (typeof id !== 'string' || !VP_ID_RE.test(id)) {
        throw new SourceError('INVALID_CASE', `${path}：${c.id} 的 VP id 非法「${String(id)}」（应为 VP-\\d{3}）`);
      }
      if (seen.has(id)) {
        throw new SourceError('INVALID_CASE', `${path}：${c.id} 的 verification_points 重复「${id}」（首次在第 ${seen.get(id)} 项）——重复 VP 只会执行其一，不许静默共存`);
      }
      seen.set(id, seen.size + 1);
    }
  }
  if (c.verification_level !== undefined && (typeof c.verification_level !== 'string' || !LEVEL_RE.test(c.verification_level))) {
    throw new SourceError('INVALID_CASE', `${path}：${c.id} 的 verification_level 非法「${String(c.verification_level)}」（应为 L1-L4）`);
  }
  if (c.dependencies !== undefined) {
    if (!Array.isArray(c.dependencies) || c.dependencies.some((d) => !d || typeof d !== 'object')) {
      throw new SourceError('INVALID_CASE', `${path}：${c.id} 的 dependencies 必须是映射列表`);
    }
    c.dependencies.forEach((d, i) => {
      if (d.mode !== undefined && !DEP_MODES.has(d.mode)) {
        throw new SourceError('INVALID_CASE', `${path}：${c.id} 的 dependencies[${i}].mode 非法「${String(d.mode)}」（应为 MOCK/FAKE/LOCAL/REAL）`);
      }
    });
  }
}

export function loadCases(spec) {
  const merged = new Map();
  for (const path of casesSources(spec)) {
    const doc = parseYaml(readFileSync(path, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new SourceError('INVALID_CASE', `${path}：文件根节点不是映射`);
    }
    if (doc.cases === undefined || doc.cases === null) continue;
    if (!Array.isArray(doc.cases)) {
      throw new SourceError('INVALID_CASE', `${path}：cases 不是列表（得到 ${typeof doc.cases}）`);
    }
    for (const c of doc.cases) {
      validateCase(c, path);
      if (merged.has(c.id)) {
        throw new SourceError('DUPLICATE_CASE_ID',
          `Duplicate case id "${c.id}"\nFirst defined:\n  ${merged.get(c.id)._source}\nAlso defined:\n  ${path}`);
      }
      merged.set(c.id, { ...c, _source: path });
    }
  }
  return [...merged.values()];
}
