#!/usr/bin/env node
// gen-view —— cases.yaml → 白话审阅 HTML（视图是生成物，永不手编）。
// 四个 style 是四种信息架构，回答审阅者的四个不同问题，不只是排版：
//   workbench 审阅工作台 —— 「全不全/哪条可疑」：左栏选案+五类覆盖，右栏完整档案
//   ledger    审计对照稿 —— 「最近跑得怎样」：期望 vs 实际逐行判卷，红格即不符
//   dossier   卷宗式     —— 仪式型：立案卡+封金印章，冻结/在办/可疑一目了然
//   narrative 叙事流式   —— demo 已验收布局（保留兼容旧用法）
//   index     审计索引   —— v3 定稿（审计文档美学）：聚合面竖向索引一行一案，
//                          详情面沿用 dossier 立案卡；宽屏点行右侧展开，窄屏锚点跳转
//   manager   案管工作台 —— v4（默认推荐）：按场景分组一行一案紧凑管理台，彩色状态 label
//                          + 版本徽标 + 末次改动摘要 + 最近判定，点行展开案卷与变更时间线；
//                          排序 = changes 末条 when 倒序（case 改动，运行结果不触碰排序）
// 用法：
//   node gen-view.mjs --cases <cases.yaml|目录> [--frozen frozen.md] [--title <h1>]
//        [--out <file>] [--style workbench|ledger|dossier|narrative|index|manager]
//        [--runs runs.json]    # 最近一次运行的实际值（锚点→实际），ledger/dossier/workbench/manager 消费
//        [--variants <dir>]    # 一次产出三个当前变体到目录（manager/index/dossier）
//   --layout 仍接受，作为 --style 的旧别名；缺省 style = manager。
// 机器名只出现在锚点里（CASE-003:checkpoint_c_total），正文零机器痕迹。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseYaml, numEq, isUndecidable, isDecimal } from './yaml-lite.mjs';
import { loadCases } from './cases-source.mjs';

// ── CLI ──
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function loadYaml(path, what) {
  if (!path) fail(`缺少 --${what}`);
  return parseYaml(readFileSync(path, 'utf8'));
}

function fail(msg) {
  console.error(`gen-view: ${msg}`);
  process.exit(2);
}

// ── 共享工具 ──
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// {v:g} 等价：1000.0 → "1000"、74.8 → "74.8"
function fmtNum(v) {
  return String(Number(v));
}

function anchorBtn(id, key) {
  return `<button class="anchor" onclick="copyAnchor('${id}:${key}')" title="复制锚点后，对 hapi 说出你的纠正">⚓</button>`;
}

// 五类观察点：方法论固有的覆盖面（见四眼自检「观察点五类覆盖」）
const FIVE = ['返回与状态', '副作用', '检查点路径', '不变量', '边界与异常'];

function loadRuns(path) {
  if (!path) return null;
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) fail('--runs 文件须是 JSON 对象');
  return obj;
}

// ── 数据模型：四个 style 共用 ──
function buildModel(cases, frozenMap) {
  return cases.map((c) => {
    const n = c.narrative ?? {};
    const changes = Array.isArray(c.changes) ? c.changes : [];
    const rows = Object.entries(c.expect ?? {}).map(([key, value]) => ({
      key,
      value,
      label: n.where?.[key] ?? key,
      unitRaw: n.units?.[key] ?? null,
      bad: isUndecidable(value),
      frozen: frozenMap ? frozenMap[c.id]?.[key] !== undefined : false,
    }));
    return {
      id: c.id,
      name: esc(c.name ?? ''),
      group: n.group ?? '未分类',
      scene: n.scene ?? null,
      whenProse: n.when ?? null,
      givenProse: buildGivenProse(c.given ?? {}, n.units ?? {}),
      rows,
      bad: rows.some((r) => r.bad),
      frozenCase: frozenMap ? frozenMap[c.id] !== undefined : false,
      version: c.version ?? changes.at(-1)?.v ?? null,
      changes,
      created: c.created ?? null,
    };
  });
}

// given 白话生成规则：<user> 账上有 N 元。库存：<ITEM> 还剩 N <单位>。
// 库存单位来自 units 的 stock_<ITEM> 键，缺省「个」。
function buildGivenProse(given, units) {
  const bal = Object.entries(given.balances ?? {})
    .map(([u, v]) => `${u} 账上有 ${fmtNum(v)} 元`).join('；');
  const stock = Object.entries(given.stock ?? {})
    .map(([k, v]) => `${k} 还剩 ${fmtNum(v)} ${units[`stock_${k}`] ?? '个'}`).join('，');
  return `${bal}。库存：${stock}。`;
}

// 期望值显示：<值> <单位>；单位缺省规则：小数→元，其余→无
function unitOf(r) {
  return r.unitRaw ?? (isDecimal(r.value) ? '元' : null);
}

function shownValue(r) {
  if (r.bad) return `<span class="val bad">${esc(r.value)}</span>`;
  const unit = unitOf(r);
  return `<span class="val">${esc(r.value)}${unit ? ' ' + unit : ''}</span>`;
}

// 实际值显示：与期望列同单位同对齐，方便逐行对照
function shownActual(r, actual) {
  if (actual === undefined || actual === null) return '<span class="val">—</span>';
  const unit = unitOf(r);
  const withUnit = unit && (typeof actual !== 'string' || r.unitRaw) ? ' ' + unit : '';
  return `<span class="val">${esc(String(actual))}${withUnit}</span>`;
}

// 单观察点判定：runs 缺失 → null；锚未跑 → 未跑；numEq 兼容 "74.8" 与 74.8
function judge(m, r, runs) {
  if (!runs) return null;
  const actual = runs[`${m.id}:${r.key}`];
  if (actual === undefined) return { chip: '未跑', actual: null };
  return { chip: numEq(r.value, actual) ? '✓' : '✗', actual };
}

// 整案判定（不可判定期望不进统计）：{ok, fail[点], ran}
function caseRun(m, runs) {
  if (!runs) return null;
  const out = { ok: 0, fail: [], ran: false };
  for (const r of m.rows) {
    if (r.bad) continue;
    const j = judge(m, r, runs);
    if (!j) continue;
    out.ran = true;
    if (j.chip === '✓') out.ok++;
    else out.fail.push(r.key);
  }
  return out;
}

function frozenBadge(m) {
  return m.frozenCase ? '<span class="frozen">已冻结</span>' : '';
}

function badCallout(r) {
  return r.bad
    ? '<div class="callout">这条期望是坏的：写成了「描述」，机器无法判对错。点锚点告诉我怎么改。</div>'
    : '';
}

const COPY_JS = `<script>function copyAnchor(a){navigator.clipboard.writeText(a);
const b=event.target;b.textContent="✓已复制";setTimeout(()=>b.textContent="⚓",900)}</script>`;

// 主题与公共样式（深浅色自适应）；extra 为布局私有样式
function pageCss(extra) {
  return `:root{--bg:#f7f6f3;--surface:#fff;--ink:#1a1d1c;--soft:#6b7370;--rule:#e3e1da;
--accent:#2c6350;--accent-soft:#e2efe9;--bad:#a13c2f;--bad-soft:#f8ebe8}
@media(prefers-color-scheme:dark){:root{--bg:#12100d;--surface:#1b1916;--ink:#e8e5de;
--soft:#9ba19c;--rule:#2c2a25;--accent:#7cc7ab;--accent-soft:#1b2a25;--bad:#e08a7d;--bad-soft:#33201c}}
body{margin:0;padding:2.5rem 1.5rem 5rem;background:var(--bg);color:var(--ink);
font:17px/1.85 ui-sans-serif,system-ui,"PingFang SC",sans-serif}
.page{max-width:58ch;margin:0 auto}
h1{font:600 1.6rem/1.3 ui-serif,Georgia,serif}
.hint{background:var(--accent-soft);border-left:3px solid var(--accent);padding:.7rem 1rem;margin-top:1rem;font-size:.95rem}
.case{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:1.2rem 1.5rem;margin-top:1.6rem}
.case.bad{border-color:var(--bad);border-width:2px}
h2{font-size:1.1rem;margin:0 0 .3rem}
.scene{color:var(--soft);margin:.1rem 0 .8rem}
p{margin:.5rem 0}
.lead{color:var(--soft);font-size:.9rem}
table{width:100%;border-collapse:collapse;margin-top:.3rem}
td{padding:.55rem .3rem;border-bottom:1px solid var(--rule);vertical-align:top}
tr:last-child td{border-bottom:none}
td:first-child{color:var(--soft);width:62%}
.val{font-variant-numeric:tabular-nums;font-weight:600;font-size:1.05rem}
.val.bad{color:var(--bad);font-weight:400;font-size:.95rem;text-decoration:line-through}
.callout{background:var(--bad-soft);color:var(--bad);border-radius:4px;padding:.4rem .7rem;margin:.3rem 0 .6rem;font-size:.88rem}
.anchor{border:none;background:transparent;color:var(--accent);opacity:.55;cursor:pointer;
font-size:.95rem;padding:.05rem .3rem;margin-left:.4rem}
.anchor:hover{opacity:1}
${extra}`;
}

function page(title, css, body, hint, extraJs = '') {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Case 审阅</title>
<style>
${css}</style></head><body><div class="page">
<h1>${esc(title)}</h1>
<div class="hint">${hint ?? '像读故事一样读。任何一行不对：点那行末尾的 ⚓，然后对 hapi 说「CASE-003:含税总价 应该是 xx」。'}</div>
${body}
${COPY_JS}
${extraJs ? extraJs + '\n' : ''}</div></body></html>`;
}

// ── 布局 1：narrative 叙事流式（demo 已验收布局，逐字节等价）──
function renderNarrative(model, title, withFrozen) {
  const badge = withFrozen
    ? '.frozen{display:inline-block;font-size:.75rem;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent);border-radius:4px;padding:.05rem .4rem;margin-left:.5rem;vertical-align:middle}\n'
    : '';
  const sections = model.map((m) => {
    const rows = m.rows.map((r) =>
      `<tr><td>${esc(r.label)}</td><td>${shownValue(r)}${anchorBtn(m.id, r.key)}</td></tr>${badCallout(r)}`).join('');
    const badgeHtml = withFrozen ? frozenBadge(m) : '';
    return `<section class="${m.bad ? 'case bad' : 'case'}">
<h2>${m.id} · ${m.name}${badgeHtml}</h2>
<p class="scene">${m.scene ?? ''}</p>
<p><b>一开始：</b>${m.givenProse}</p>
<p><b>然后：</b>${m.whenProse ?? ''}</p>
<p class="lead">做完之后，下面这些都应该成立：</p>
<table><tbody>${rows}</tbody></table>
</section>`;
  }).join('');
  return page(title, pageCss(badge), sections);
}

// ── style 2：workbench 审阅工作台 —— 回答「全不全/哪条可疑」──
// 左栏固定：案件按场景分类分组 + 状态徽章；底部覆盖面板：五类分布条/不变量数/可疑数。
// 右主区：点选 case 看完整档案。纯 JS 切换，无框架。
function renderWorkbench(model, title, runs) {
  const groups = new Map(FIVE.map((g) => [g, []]));
  for (const m of model) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  const badge = (m) => {
    const run = caseRun(m, runs);
    const b = [];
    if (m.bad) b.push('<span class="st bad">⚠坏期望</span>');
    else if (run?.fail.length) b.push('<span class="st bad">✗不符</span>');
    b.push(m.frozenCase ? '<span class="st frozen">已冻结</span>' : '<span class="st">未冻结</span>');
    return b.join('');
  };
  const items = [...groups.entries()].filter(([, ms]) => ms.length > 0).map(([g, ms]) =>
    `<div class="gname">${esc(g)}</div>` + ms.map((m) =>
      `<button class="item${m === model[0] ? ' on' : ''}" data-c="${m.id}" onclick="showCase('${m.id}')"><span class="cid">${m.id}</span><span class="nm">${m.name}</span>${badge(m)}</button>`).join('')).join('');
  const max = Math.max(1, ...[...groups.values()].map((ms) => ms.length));
  const covRows = [...groups.entries()].map(([g, ms]) =>
    `<div class="covrow${ms.length === 0 ? ' zero' : ''}"><span class="cn">${esc(g)}</span><span class="bar"><i style="width:${Math.round((ms.length / max) * 100)}%"></i></span><span class="cv">${ms.length}</span></div>`).join('');
  const suspicious = model.filter((m) => m.bad || caseRun(m, runs)?.fail.length).length;
  const panels = model.map((m) => {
    const rows = m.rows.map((r) =>
      `<tr><td>${esc(r.label)}</td><td>${shownValue(r)}${anchorBtn(m.id, r.key)}</td></tr>${badCallout(r)}`).join('');
    const run = caseRun(m, runs);
    const verdict = !run ? '' : !run.ran
      ? '<p class="verdict"><span class="chip na">未跑</span>最近一次运行没有这个 case 的记录</p>'
      : run.fail.length
        ? `<p class="verdict"><span class="chip no">✗ ${run.fail.length} 项不符</span>与期望不符：${run.fail.map(esc).join('、')}</p>`
        : `<p class="verdict"><span class="chip ok">✓ ${run.ok} 项全过</span>最近一次运行全部符合期望</p>`;
    return `<section class="case dpanel${m === model[0] ? ' on' : ''}${m.bad ? ' bad' : ''}" id="p-${m.id}">
<h2>${m.id} · ${m.name}${frozenBadge(m)}</h2>
<p class="scene">${m.scene ?? ''}</p>
${verdict}
<p><b>一开始：</b>${m.givenProse}</p>
<p><b>然后：</b>${m.whenProse ?? ''}</p>
<p class="lead">做完之后，下面这些都应该成立：</p>
<table><tbody>${rows}</tbody></table>
</section>`;
  }).join('');
  const extra = `.frozen{display:inline-block;font-size:.75rem;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent);border-radius:4px;padding:.05rem .4rem;margin-left:.5rem}
body{padding:0}
.page{max-width:none;margin:0;padding:0}
.wb{display:grid;grid-template-columns:19rem 1fr;min-height:100vh}
aside{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--surface);border-right:1px solid var(--rule)}
.caselist{flex:1;overflow-y:auto;padding:.8rem .7rem}
.gname{font-size:.75rem;color:var(--soft);letter-spacing:.08em;margin:.8rem .3rem .25rem}
.item{display:flex;width:100%;align-items:baseline;gap:.45rem;text-align:left;background:none;border:none;border-radius:6px;padding:.4rem .5rem;cursor:pointer;font:inherit;font-size:.9rem;color:var(--ink)}
.item:hover{background:var(--accent-soft)}
.item.on{background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent)}
.item .cid{font-weight:600;white-space:nowrap}
.item .nm{flex:1;color:var(--soft);font-size:.84rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{flex:none;font-size:.68rem;line-height:1.5;border:1px solid var(--rule);border-radius:4px;padding:0 .3rem;color:var(--soft);white-space:nowrap}
.st.frozen{color:var(--accent);border-color:var(--accent)}
.st.bad{color:var(--bad);border-color:var(--bad)}
.cover{flex:none;border-top:1px solid var(--rule);padding:.75rem .9rem .9rem;font-size:.82rem}
.cover h3{margin:0 0 .45rem;font-size:.75rem;font-weight:600;color:var(--soft);letter-spacing:.08em}
.covrow{display:flex;align-items:center;gap:.45rem;margin:.22rem 0}
.covrow .cn{width:5.2em;color:var(--soft);white-space:nowrap}
.covrow .bar{flex:1;height:.45rem;border-radius:3px;background:var(--bg);overflow:hidden}
.covrow .bar i{display:block;height:100%;background:var(--accent)}
.covrow.zero .cn{color:var(--bad)}
.covrow.zero .bar i{background:var(--bad-soft)}
.covrow .cv{width:1.1em;text-align:right;font-variant-numeric:tabular-nums}
.covsum{display:flex;gap:1.1rem;margin-top:.55rem;padding-top:.55rem;border-top:1px dashed var(--rule);color:var(--soft)}
.covsum b{color:var(--ink)}
.covsum b.hot{color:var(--bad)}
main{padding:1.6rem 2.2rem 4rem;min-width:0}
.dpanel{display:none;max-width:44rem}
.dpanel.on{display:block}
.chip{display:inline-block;border-radius:4px;border:1px solid;padding:0 .4rem;margin-right:.45rem;font-size:.85rem}
.chip.ok{color:var(--accent);border-color:var(--accent)}
.chip.no{color:var(--bad);border-color:var(--bad)}
.chip.na{color:var(--soft);border-color:var(--rule)}
.verdict{margin:.4rem 0 .2rem;font-size:.92rem}
@media(max-width:900px){.wb{grid-template-columns:1fr}aside{position:static;height:auto}.caselist{max-height:38vh}}`;
  const js = `<script>function showCase(id){
document.querySelectorAll('.dpanel').forEach(p=>p.classList.toggle('on',p.id==='p-'+id));
document.querySelectorAll('.item').forEach(b=>b.classList.toggle('on',b.dataset.c===id));}</script>`;
  const body = `<div class="wb"><aside>
<div class="caselist">${items}</div>
<div class="cover"><h3>覆盖面板</h3>${covRows}
<div class="covsum"><span>不变量 case <b>${groups.get('不变量').length}</b></span><span>可疑 case <b class="${suspicious ? 'hot' : ''}">${suspicious}</b></span></div>
</div></aside>
<main>${panels}</main></div>`;
  return page(title, pageCss(extra), body,
    '左栏选案，右栏读完整档案；左下覆盖面板回答「全不全」。哪行不对：点 ⚓ 复制锚点，对 hapi 说「CASE-003:含税总价 应该是 xx」。', js);
}

// ── style 3：ledger 审计对照稿 —— 回答「最近跑得怎样」──
// 全 case 平铺：每行 = 观察点|期望|实际|判定。期望/实际列右对齐 tabular-nums，红格即不符。
// 无 --runs 时实际列显「—」，退化为纯期望对照表。
function renderLedger(model, title, runs) {
  const CHIP = { '✓': '<span class="chip ok">✓</span>', '✗': '<span class="chip no">✗</span>', '⚠': '<span class="chip no">⚠</span>', '未跑': '<span class="chip na">未跑</span>' };
  const tally = { '✓': 0, '✗': 0, '未跑': 0, '⚠': 0 };
  const trs = model.map((m) => {
    const sep = `<tr class="sep"><td colspan="4">${m.id} · <b>${m.name}</b>${frozenBadge(m)}${m.bad ? ' <span class="st bad">⚠坏期望</span>' : ''}</td></tr>`;
    const rows = m.rows.map((r) => {
      const j = r.bad ? { chip: '⚠' } : judge(m, r, runs);
      if (j) tally[j.chip] = (tally[j.chip] ?? 0) + 1;
      const chip = j ? (CHIP[j.chip] ?? '') : '<span class="chip na">—</span>';
      return `<tr${j?.chip === '✗' ? ' class="fail"' : ''}><td>${esc(r.label)}${anchorBtn(m.id, r.key)}</td><td class="num">${shownValue(r)}</td><td class="num act">${shownActual(r, j?.actual)}</td><td>${chip}</td></tr>${r.bad ? `<tr class="cal"><td colspan="4">${badCallout(r)}</td></tr>` : ''}`;
    }).join('');
    return sep + rows;
  }).join('');
  const when = runs?._meta?.captured ? `<span class="when">最近一次运行：${esc(String(runs._meta.captured))}</span>` : '';
  const summary = runs
    ? `<p class="sum"><span class="chip ok">✓ ${tally['✓']}</span><span class="chip no">✗ ${tally['✗']}</span><span class="chip na">未跑 ${tally['未跑']}</span>${tally['⚠'] ? `<span class="chip no">⚠ ${tally['⚠']}</span>` : ''}${when}</p>`
    : '<p class="sum"><span class="chip na">尚无运行记录</span><span class="when">用 --runs 传入最近一次运行的实际值，实际列与判定列才会点亮</span></p>';
  const extra = `.frozen{display:inline-block;font-size:.72rem;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent);border-radius:4px;padding:0 .35rem;margin-left:.3rem}
.st.bad{font-size:.72rem;color:var(--bad);border:1px solid var(--bad);border-radius:4px;padding:0 .35rem;margin-left:.3rem}
.page{max-width:66rem}
.sum{display:flex;align-items:center;gap:.5rem;margin:1.1rem 0 0;font-size:.92rem}
.sum .when{color:var(--soft);font-size:.85rem}
.grid{margin-top:.6rem;font-size:.95rem}
.grid th{position:sticky;top:0;z-index:1;background:var(--bg);text-align:left;font-size:.8rem;color:var(--soft);font-weight:600;border-bottom:2px solid var(--rule);padding:.4rem .35rem}
.grid td{padding:.5rem .35rem;border-bottom:1px solid var(--rule);vertical-align:top}
.grid td:first-child{width:auto}
tr.sep td{border-bottom:none;padding:1rem .35rem .2rem;color:var(--soft)}
tr.sep td b{color:var(--ink)}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
th.num{width:8.5em}
tr.fail td.act{background:var(--bad-soft)}
tr.fail td.act .val{color:var(--bad)}
tr.cal td{border-bottom:none;padding-top:0}
.chip{display:inline-block;border-radius:4px;border:1px solid;padding:0 .4rem;font-size:.85rem}
.chip.ok{color:var(--accent);border-color:var(--accent)}
.chip.no{color:var(--bad);border-color:var(--bad)}
.chip.na{color:var(--soft);border-color:var(--rule)}`;
  const body = `${summary}<table class="grid"><thead><tr><th>观察点</th><th class="num">期望（金标）</th><th class="num">实际</th><th>判定</th></tr></thead><tbody>${trs}</tbody></table>`;
  return page(title, pageCss(extra), body,
    '每行 = 一个观察点的期望 vs 实际。红格 = 与金标不符；灰「未跑」= 最近一次运行没跑到。点 ⚓ 复制锚点，对 hapi 说出纠正。');
}

// ── 立案卡（dossier/index 共用）──
// 已冻结案卡盖「封金 🔒 已盖章」印章；被实现违背的封金案卡红框 + 「违背封金」。
const DOSSIER_CSS = `.frozen{display:inline-block;font-size:.75rem;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent);border-radius:4px;padding:.05rem .4rem;margin-left:.5rem}
.dossier{position:relative;background:var(--surface);border:1px solid var(--rule);border-top:3px solid var(--accent);border-radius:6px;padding:1.3rem 1.5rem 1.1rem;margin-top:1.6rem}
.dossier.bad{border:2px solid var(--bad);border-top-width:3px}
.caseid{font-size:.8rem;letter-spacing:.22em;color:var(--soft)}
.dossier h2{font:600 1.25rem/1.35 ui-serif,Georgia,serif;padding-right:6.5rem}
.kw b{margin-right:.45rem}
.seal{position:absolute;top:1.1rem;right:1.2rem;transform:rotate(7deg);border:2px solid var(--accent);border-radius:8px;padding:.28rem .6rem;color:var(--accent);font-weight:700;font-size:.8rem;letter-spacing:.14em;opacity:.9;box-shadow:inset 0 0 0 2px var(--surface),inset 0 0 0 3.5px var(--accent);pointer-events:none}
.seal.draft{border-color:var(--rule);color:var(--soft);font-weight:400;transform:rotate(-4deg);box-shadow:inset 0 0 0 2px var(--surface),inset 0 0 0 3.5px var(--rule)}
.verdict{margin-top:.9rem;border-top:1px dashed var(--rule);padding-top:.7rem;font-size:.95rem}
.verdict b{margin-right:.5rem}
.vio{color:var(--bad);font-style:normal}
.chip{display:inline-block;border-radius:4px;border:1px solid;padding:0 .4rem;margin-right:.45rem;font-size:.85rem}
.chip.ok{color:var(--accent);border-color:var(--accent)}
.chip.no{color:var(--bad);border-color:var(--bad)}
.chip.na{color:var(--soft);border-color:var(--rule)}
.changelog{margin-top:.85rem;border-top:1px dashed var(--rule);padding-top:.55rem;font-size:.82rem;color:var(--soft)}
.clt{display:block;font-size:.72rem;letter-spacing:.08em;margin-bottom:.25rem}
.clrow{display:flex;gap:.8rem;align-items:baseline;margin:.18rem 0}
.clv{font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink);font-size:.75rem;flex:none;width:1.8em}
.clw{font-variant-numeric:tabular-nums;white-space:nowrap}`;

function dossierCard(m, runs) {
  const run = caseRun(m, runs);
  const rows = m.rows.map((r) =>
    `<tr><td>${esc(r.label)}</td><td>${shownValue(r)}${anchorBtn(m.id, r.key)}</td></tr>${badCallout(r)}`).join('');
  const seal = m.frozenCase
    ? '<div class="seal">封金 🔒 已盖章</div>'
    : '<div class="seal draft">在办 · 未封金</div>';
  const verdict = !run
    ? '<span class="chip na">待审</span>尚无最近一次运行记录。'
    : run.fail.length
      ? `<span class="chip no">✗ ${run.fail.length} 项不符</span>${m.frozenCase ? '<em class="vio">违背封金！期望值被实现打破——要么修实现，要么由需求方重开冻结。</em>' : `不符点：${run.fail.map(esc).join('、')}`}`
      : run.ran
        ? `<span class="chip ok">✓ ${run.ok} 项全过</span>本轮运行全部符合证据清单。`
        : '<span class="chip na">未跑</span>最近一次运行没有这个案号的记录。';
  const timeline = m.changes.length
    ? `<div class="changelog"><span class="clt">变更记录</span>${m.changes.map((ch) =>
      `<div class="clrow"><span class="clv">v${esc(ch.v ?? '')}</span><span class="clw">${esc(ch.when ?? '')}</span><span class="cla">${esc(ch.what ?? '')}</span></div>`).join('')}</div>`
    : '';
  return `<section class="dossier${m.bad || run?.fail.length ? ' bad' : ''}">
${seal}
<div class="caseid">案号 ${m.id}${m.version ? ` · v${esc(m.version)}` : ''}</div>
<h2>${m.name}${frozenBadge(m)}</h2>
<p class="kw"><b>指控</b>${m.scene ?? ''}</p>
<p class="kw"><b>前情</b>${m.givenProse}</p>
<p class="kw"><b>涉案动作</b>${m.whenProse ?? ''}</p>
<p class="lead">证据清单 —— 做完之后，下面这些都必须成立：</p>
<table><tbody>${rows}</tbody></table>
<p class="verdict"><b>最近判定</b>${verdict}</p>
${timeline}
</section>`;
}

// ── style 4：dossier 卷宗式 —— 仪式型，呼应金标/封金的司法隐喻 ──
// 每 case 一张立案卡平铺；顶部小结栏：在办/已封/可疑。
function renderDossier(model, title, runs) {
  const frozen = model.filter((m) => m.frozenCase).length;
  const suspicious = model.filter((m) => m.bad || caseRun(m, runs)?.fail.length).length;
  const cards = model.map((m) => dossierCard(m, runs)).join('');
  const when = runs?._meta?.captured ? `<span class="when">最近运行 ${esc(String(runs._meta.captured))}</span>` : '';
  const summary = `<div class="sumbar"><span>在办 <b>${model.length - frozen}</b></span><span>已封 <b>${frozen}</b></span><span>可疑 <b class="${suspicious ? 'hot' : ''}">${suspicious}</b></span>${when}</div>`;
  const extra = `.sumbar{position:sticky;top:0;z-index:5;display:flex;gap:1.5rem;align-items:baseline;background:var(--bg);border-bottom:1px solid var(--rule);padding:.55rem .2rem;font-size:.95rem}
.sumbar .when{margin-left:auto;color:var(--soft);font-size:.85rem}
${DOSSIER_CSS}`;
  return page(title, pageCss(extra), summary + cards,
    '像翻卷宗一样逐案过：已封案卷带印章，证据不符即「违背封金」。点 ⚓ 复制锚点，对 hapi 说出纠正。');
}

// ── style 5：index 审计索引 —— v3 定稿（审计文档美学，像对账单/案号索引那样靠秩序建立信任）──
// 聚合面 = 竖向索引：一行一案（案号/案件名/状态/最近判定），宽松行盒 + 1px 细线，禁止卡片墙。
// 详情面 = 单案 dossier 立案卡：宽屏点索引行在右侧 focus 面板切换；窄屏全部平铺，索引退化为锚点跳转。
// 视觉纪律：三档字号（1.45 标题 / 1 正文 / .8 标注）、唯一强调色、两侧留白 8vw、区块间 4rem。
function renderIndex(model, title, runs) {
  const frozen = model.filter((m) => m.frozenCase).length;
  const suspicious = model.filter((m) => m.bad || caseRun(m, runs)?.fail.length).length;
  // 状态 chip 按严重度取一（⚠坏期望 > 已封金 > 未冻结）；违规同时由「最近判定」列承担，不叠双章
  const statusChip = (m) =>
    m.bad ? '<span class="st bad">⚠坏期望</span>'
      : m.frozenCase ? '<span class="st frozen">🔒 已封金</span>'
        : '<span class="st">未冻结</span>';
  const verdictCell = (m) => {
    const run = caseRun(m, runs);
    if (!run) return '<span class="vd">—</span>';
    if (!run.ran) return '<span class="vd na">未跑</span>';
    return run.fail.length
      ? `<span class="vd no">✗ ${run.fail.length}</span>`
      : `<span class="vd ok">✓ ${run.ok}</span>`;
  };
  const ihead = '<div class="ihead"><span>案号</span><span>案件</span><span>状态</span><span class="r">最近判定</span></div>';
  const rows = model.map((m) =>
    `<a class="row${m === model[0] ? ' on' : ''}" data-c="${m.id}" href="#case-${m.id}" onclick="showCase('${m.id}',event)" title="${m.id} ${m.name}"><span class="no">${m.id}</span><span class="nm">${m.name}</span>${statusChip(m)}${verdictCell(m)}</a>`).join('');
  const when = runs?._meta?.captured ? `<span class="when">最近运行 ${esc(String(runs._meta.captured))}</span>` : '';
  const overview = `<div class="overview"><span class="kv"><b>${model.length - frozen}</b>在办</span><span class="kv"><b>${frozen}</b>已封</span><span class="kv"><b class="${suspicious ? 'hot' : ''}">${suspicious}</b>可疑</span>${when}</div>`;
  const details = model.map((m) =>
    `<div class="detail${m === model[0] ? ' on' : ''}" id="case-${m.id}">${dossierCard(m, runs)}</div>`).join('');
  const extra = `:root{--serif:ui-serif,Georgia,'Songti SC','SimSun',serif}
body{padding:3.5rem 8vw 6rem}
.page{max-width:82rem}
h1{font:600 1.45rem/1.3 var(--serif);margin:0}
.hint{background:none;border:none;padding:1.1rem 0 0;margin:1.2rem 0 0;border-top:2px solid var(--ink);color:var(--soft);font-size:.8rem}
.overview{display:flex;flex-wrap:wrap;gap:3rem;row-gap:.4rem;align-items:baseline;margin-top:1.4rem;padding:.2rem 0 1rem;border-bottom:1px solid var(--rule);font-size:.8rem;color:var(--soft)}
.kv{white-space:nowrap}
.kv b{font-size:1rem;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;margin-right:.4rem}
.kv b.hot{color:var(--bad)}
.overview .when{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
.grid{display:grid;grid-template-columns:minmax(22rem,30rem) 1fr;gap:4rem;margin-top:4rem;align-items:start}
.ihead,.row{display:grid;grid-template-columns:auto 1fr auto auto;gap:.9rem;align-items:baseline}
.ihead{padding:.55rem .5rem;font-size:.8rem;letter-spacing:.12em;color:var(--soft)}
.ihead .r{text-align:right}
.row{padding:.95rem .5rem;border-bottom:1px solid var(--rule);color:inherit;text-decoration:none}
.row:hover .no,.row:hover .nm{color:var(--accent)}
.row.on{background:var(--accent-soft)}
.row.on .no{color:var(--accent)}
.no{font:600 .8rem/1.5 var(--serif);letter-spacing:.12em;font-variant-numeric:tabular-nums;white-space:nowrap}
.nm{font-family:var(--serif);font-size:1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{font-size:.8rem;border:1px solid var(--rule);border-radius:3px;padding:.06rem .45rem;color:var(--soft);white-space:nowrap}
.st.frozen{color:var(--accent);border-color:var(--accent)}
.st.bad{color:var(--bad);border-color:var(--bad)}
.vd{font-size:.8rem;font-variant-numeric:tabular-nums;text-align:right;min-width:2.4em;white-space:nowrap}
.vd.ok{color:var(--accent)}
.vd.no{color:var(--bad)}
.vd.na{color:var(--soft)}
.focus{position:sticky;top:3rem;min-width:0}
.focus .dossier{max-width:44rem}
.detail{display:none;scroll-margin-top:2rem}
.detail.on{display:block}
.detail .dossier{margin-top:0}
${DOSSIER_CSS}
/* 卡内字号归一到三档阶梯 */
.dossier h2{font:600 1.45rem/1.35 var(--serif);padding-right:6.5rem}
.val{font-size:1rem}
.lead{font-size:.8rem}
.verdict{font-size:1rem}
.frozen{font-size:.8rem;border-radius:3px}
.chip{font-size:.8rem;border-radius:3px}
@media(max-width:899px){
.grid{grid-template-columns:1fr;gap:3rem}
.focus{position:static}
.detail{display:block;margin-top:2.5rem}
.ihead{display:none}
/* 窄屏索引行改两行盒：案号+状态+判定一行，案名整行不截断 */
.row{grid-template-columns:auto 1fr auto;row-gap:.15rem}
.no{grid-column:1;grid-row:1}
.st{grid-column:2;grid-row:1;justify-self:end}
.vd{grid-column:3;grid-row:1}
.nm{grid-column:1/-1;grid-row:2;white-space:normal;overflow:visible}
}
@media print{:root{--bg:#f7f6f3;--surface:#fff;--ink:#1a1d1c;--soft:#6b7370;--rule:#e3e1da;--accent:#2c6350;--accent-soft:#e2efe9;--bad:#a13c2f;--bad-soft:#f8ebe8}}`;
  const js = `<script>function showCase(id,ev){
if(!matchMedia('(min-width:900px)').matches)return;
ev.preventDefault();
document.querySelectorAll('.detail').forEach(p=>p.classList.toggle('on',p.id==='case-'+id));
document.querySelectorAll('.row').forEach(r=>r.classList.toggle('on',r.dataset.c===id));}</script>`;
  const body = `${overview}<div class="grid"><nav class="index">${ihead}${rows}</nav><div class="focus">${details}</div></div>`;
  return page(title, pageCss(extra), body,
    '索引一行一案，点行在右侧展开案卷（窄屏自动改为跳到对应案卷）。哪行期望不对：点行内 ⚓ 复制锚点，对 hapi 说「CASE-003:含税总价 应该是 xx」。', js);
}

// ── style 6：manager 案管工作台 —— v4 默认推荐（紧凑管理工作台，「case 管理」的感觉）──
// 按场景分组，组头带组内统计；组内按末次改动时间倒序（case 改动，不是运行数据变动）。
// 一行一案紧凑行盒：彩色状态 label | 案号·案件名 | 版本徽标+末次改动摘要 | 最近判定 | ⚓。
// 点行展开 dossier 立案卡（含验证表与变更时间线）。label 色彩语义与品牌色分离：
// 已封金=琥珀、未冻结=灰蓝、坏期望=红；判定列 ✓ 绿 ✗ 红 未跑 灰。
function renderManager(model, title, runs) {
  const groups = new Map(FIVE.map((g) => [g, []]));
  for (const m of model) {
    if (!groups.has(m.group)) groups.set(m.group, []);
    groups.get(m.group).push(m);
  }
  // 排序键 = changes 末条 when（无 changes 回落 created，再回落空串沉底）；运行结果永不触碰排序
  const lastWhen = (m) => String(m.changes.at(-1)?.when ?? m.created ?? '');
  for (const ms of groups.values()) ms.sort((a, b) => lastWhen(b).localeCompare(lastWhen(a)));
  const shown = [...groups.entries()].filter(([, ms]) => ms.length > 0);
  const labelOf = (m) =>
    m.bad ? '<span class="lb bad">⚠坏期望</span>'
      : m.frozenCase ? '<span class="lb sealed">已封金</span>'
        : '<span class="lb open">未冻结</span>';
  const verdictCell = (m) => {
    const run = caseRun(m, runs);
    if (!run) return '<span class="vd na">—</span>';
    if (!run.ran) return '<span class="vd na">未跑</span>';
    return run.fail.length
      ? `<span class="vd no">✗ ${run.fail.length}</span>`
      : `<span class="vd ok">✓ ${run.ok}</span>`;
  };
  const changeCell = (m) => {
    const last = m.changes.at(-1);
    if (!last) return '<span class="cell-chg"><span class="chg">—</span></span>';
    return `<span class="cell-chg"><span class="vb">v${esc(m.version ?? last.v ?? '')}</span><span class="chg">${esc(last.what ?? '')}</span><span class="chgd">${esc(last.when ?? '')}</span></span>`;
  };
  const rowHtml = (m) =>
    `<div class="row" data-c="${m.id}" onclick="toggleCase('${m.id}')" title="${m.id} ${m.name}">
${labelOf(m)}
<span class="cell-id"><span class="cid">${m.id}</span><span class="nm">${m.name}</span></span>
${changeCell(m)}
${verdictCell(m)}
<button class="anchor" onclick="event.stopPropagation();copyAnchor('${m.id}')" title="复制案号，对 hapi 说出这个 case 的问题">⚓</button>
</div>
<div class="detail" id="d-${m.id}">${dossierCard(m, runs)}</div>`;
  const groupHtml = ([g, ms]) => {
    const fz = ms.filter((m) => m.frozenCase).length;
    const sus = ms.filter((m) => m.bad || caseRun(m, runs)?.fail.length).length;
    return `<section class="grp"><div class="ghead"><span class="gname">${esc(g)}</span><span class="gstat">${ms.length} 案 · 已封 ${fz} · <span class="${sus ? 'hot' : ''}">可疑 ${sus}</span></span></div>
${ms.map(rowHtml).join('')}</section>`;
  };
  const frozen = model.filter((m) => m.frozenCase).length;
  const suspicious = model.filter((m) => m.bad || caseRun(m, runs)?.fail.length).length;
  const newest = [...model].filter((m) => m.changes.length)
    .sort((a, b) => lastWhen(b).localeCompare(lastWhen(a)))[0];
  const recent = newest
    ? `<span class="recent">最近改动 <span class="vb">v${esc(newest.version ?? '')}</span> ${newest.id} ${esc(newest.changes.at(-1).what ?? '')} <span class="chgd">${esc(lastWhen(newest))}</span></span>`
    : '';
  const overview = `<div class="overview"><span class="kv"><b>${model.length - frozen}</b>在办</span><span class="kv"><b>${frozen}</b>已封</span><span class="kv"><b class="${suspicious ? 'hot' : ''}">${suspicious}</b>可疑</span>${recent}</div>`;
  const extra = `/* manager 语义色 label：与品牌强调色分离，深浅色各自成套 */
:root{--gold:#7e5c10;--gold-soft:#f0e7cf;--slate:#4f5f6e;--slate-soft:#e6ebef;--ok:#2e7c4d}
@media(prefers-color-scheme:dark){:root{--gold:#d2ad67;--gold-soft:#2b2312;--slate:#9db0c0;--slate-soft:#212932;--ok:#83c99e}}
body{padding:1.8rem 3vw 4rem}
.page{max-width:78rem}
h1{font:600 1.15rem/1.3 ui-serif,Georgia,serif;margin:0}
.hint{background:none;border:none;border-top:2px solid var(--ink);padding:.6rem 0 0;margin:.8rem 0 0;font-size:.78rem;color:var(--soft)}
.overview{display:flex;flex-wrap:wrap;gap:1.4rem;row-gap:.3rem;align-items:baseline;padding:.45rem 0;border-bottom:1px solid var(--rule);font-size:.78rem;color:var(--soft)}
.kv b{font-size:.95rem;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;margin-right:.3rem}
.kv b.hot{color:var(--bad)}
.recent{margin-left:auto}
.recent .chgd{margin-left:.2rem}
.vb{display:inline-block;border:1px solid var(--rule);border-radius:3px;padding:0 .32em;font-size:.68rem;color:var(--soft);font-variant-numeric:tabular-nums;line-height:1.5}
.chgd{font-size:.72rem;color:var(--soft);font-variant-numeric:tabular-nums;white-space:nowrap}
.grp{margin-top:1.7rem}
.ghead{display:flex;align-items:baseline;gap:.8rem;padding:.3rem .1rem;border-bottom:1px solid var(--ink)}
.gname{font-weight:600;font-size:.8rem;letter-spacing:.06em}
.gstat{font-size:.72rem;color:var(--soft)}
.gstat .hot{color:var(--bad)}
.row{display:grid;grid-template-columns:5.6em minmax(11rem,1.05fr) minmax(0,1.5fr) 3.4em 1.6em;gap:.15rem .85rem;align-items:center;padding:.36rem .4rem;border-bottom:1px solid var(--rule);cursor:pointer}
.row:hover,.row.on{background:var(--accent-soft)}
.row.on{box-shadow:inset 2px 0 0 var(--accent)}
.lb{justify-self:start;font-size:.7rem;font-weight:600;border-radius:3px;padding:.1rem .45rem;white-space:nowrap}
.lb.sealed{color:var(--gold);background:var(--gold-soft)}
.lb.open{color:var(--slate);background:var(--slate-soft)}
.lb.bad{color:var(--bad);background:var(--bad-soft)}
.cell-id{display:flex;align-items:baseline;gap:.5rem;min-width:0}
.cid{font-size:.76rem;font-weight:600;color:var(--soft);font-variant-numeric:tabular-nums;white-space:nowrap}
.nm{font-size:.84rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cell-chg{display:flex;align-items:baseline;gap:.5rem;min-width:0}
.chg{font-size:.78rem;color:var(--soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.vd{font-size:.8rem;font-variant-numeric:tabular-nums;justify-self:end;white-space:nowrap}
.vd.ok{color:var(--ok)}
.vd.no{color:var(--bad)}
.vd.na{color:var(--soft)}
.row .anchor{margin-left:0;opacity:.5;font-size:.85rem;justify-self:end}
.row .anchor:hover{opacity:1}
.detail{display:none}
.detail.on{display:block}
.detail .dossier{margin:.6rem 0 1.2rem}
@media(max-width:720px){
/* 窄屏两行盒：label+案号+判定+锚一行，末次改动整行不截断 */
.row{grid-template-columns:auto 1fr auto auto;row-gap:.3rem}
.lb{grid-column:1;grid-row:1}
.cell-id{grid-column:2;grid-row:1}
.vd{grid-column:3;grid-row:1}
.row .anchor{grid-column:4;grid-row:1}
.cell-chg{grid-column:1/-1;grid-row:2}
.chg{white-space:normal}
}`;
  const js = `<script>function toggleCase(id){
const det=document.getElementById('d-'+id),open=det.classList.contains('on');
document.querySelectorAll('.detail.on').forEach(d=>d.classList.remove('on'));
document.querySelectorAll('.row.on').forEach(r=>r.classList.remove('on'));
if(!open){det.classList.add('on');document.querySelector('.row[data-c="'+id+'"]').classList.add('on');}
}</script>`;
  const body = `<div class="mgr">${overview}${shown.map(groupHtml).join('')}</div>`;
  return page(title, pageCss(`${DOSSIER_CSS}
${extra}`), body,
    '一行一案，点行展开案卷与变更记录，再点收起。哪行期望不对：点 ⚓ 复制，对 hapi 说「CASE-003:含税总价 应该是 xx」。', js);
}

// ── main ──
const casesPath = arg('cases');
const frozenPath = arg('frozen');
const title = arg('title', 'Case 审阅');
const outPath = arg('out');
const style = arg('style') ?? arg('layout', 'manager');
const runsPath = arg('runs');
const variantsDir = arg('variants');

const cases = loadCases(casesPath);
if (!Array.isArray(cases) || cases.length === 0) fail('cases 文件中没有 case');
const frozenMap = frozenPath ? (loadYaml(frozenPath, 'frozen').frozen ?? {}) : null;
const model = buildModel(cases, frozenMap);
const runs = loadRuns(runsPath);

const RENDER = {
  narrative: (m, t) => renderNarrative(m, t, !!frozenPath),
  workbench: (m, t) => renderWorkbench(m, t, runs),
  ledger: (m, t) => renderLedger(m, t, runs),
  dossier: (m, t) => renderDossier(m, t, runs),
  index: (m, t) => renderIndex(m, t, runs),
  manager: (m, t) => renderManager(m, t, runs),
};
const VARIANTS = [
  ['manager', '01-manager.html'],
  ['index', '02-index.html'],
  ['dossier', '03-dossier.html'],
];

if (variantsDir) {
  mkdirSync(variantsDir, { recursive: true });
  for (const [name, file] of VARIANTS) {
    writeFileSync(`${variantsDir}/${file}`, RENDER[name](model, title));
    console.log(`variant ${name} → ${variantsDir}/${file}`);
  }
} else {
  const render = RENDER[style];
  if (!render) fail(`未知 style ${style}（可选：${Object.keys(RENDER).join('/')}）`);
  if (!outPath) fail('缺少 --out（或用 --variants 一次产出三变体）');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, render(model, title));
  console.log(`OK → ${outPath}`);
}
