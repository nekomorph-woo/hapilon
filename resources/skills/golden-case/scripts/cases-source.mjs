// cases-source —— --cases 取值的来源解析（audit / explorer / freeze-check / gen-view / report 共用）。
// 接受三种形态：单个 .yaml 文件、目录（glob 目录内全部 *.yaml，按文件名序）、逗号分隔的多项。
// 目录归并按文件名升序=用户可控的稳定顺序；重复 id 后者覆盖，与 freeze-check 原语义一致。
// 只解析来源，YAML 子集解析仍归 yaml-lite.mjs（零依赖边界不破）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml-lite.mjs';

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

export function loadCases(spec) {
  const merged = new Map();
  for (const path of casesSources(spec)) {
    for (const c of parseYaml(readFileSync(path, 'utf8')).cases ?? []) merged.set(c.id, c);
  }
  return [...merged.values()];
}
