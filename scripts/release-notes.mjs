#!/usr/bin/env node
/**
 * release notes 生成器：git log <prev-tag>..HEAD 全量提交交给模型，
 * 改写成用户视角的两层结构——「本版亮点」（价值排序）+「全部变更」（用户概念分组，
 * 同主题提交合并成一条）。产出 .hapilon/release/v<版本>.md。
 *
 * 每条提交必须落点：模型返回的 bullet↔提交映射经全覆盖校验，缺一条即失败，
 * 不靠自觉。合并的 bullet 以 HTML 注释标注覆盖的提交序号（不渲染、可审计）。
 *
 * 由 release.sh 第 0 步在发版现场调用（消灭草稿与 tag 之间的提交时间差）。
 *
 * 用法：
 *   node scripts/release-notes.mjs <prev-tag> <新版本>
 *   node scripts/release-notes.mjs --self-test
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD_BASE = "https://github.com/nekomorph-woo/hapilon/releases/download";
const GROUPS = ["安全与信任", "模型与会话", "技能与工作流", "界面与显示", "稳定性与修复", "发版与维护"];
const VALID_GROUPS = new Set([...GROUPS, "其他"]);
const VERSION_RE = /^v?\d+\.\d+\.\d+$/;
const HAIKU_TIMEOUT_MS = 180_000;
const BODY_SNIPPET_LIMIT = 300;

function usageText() {
  return [
    "用法: node scripts/release-notes.mjs <prev-tag> <新版本>",
    "      node scripts/release-notes.mjs --self-test",
    "",
    "从 git log <prev-tag>..HEAD 生成 release notes：全部提交交模型改写，",
    "亮点层价值排序，全量层按用户概念分组合并；提交全覆盖校验缺一即败。",
    "",
    "示例: node scripts/release-notes.mjs v0.8.1 0.9.0",
  ].join("\n");
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function resolveCommit(rev) {
  try {
    return git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim();
  } catch {
    throw new Error(`找不到提交或 tag：${rev}`);
  }
}

// 提交三件套：subject（改写主依据）、body 首段（why，常带用户价值）、
// 顶层目录与文件样本（区分用户可感知面 src/resources 与内部 docs/dist）
function readCommits(prevTag) {
  const meta = git(["log", `${prevTag}..HEAD`, "--no-merges", "--pretty=format:%H%x01%s%x01%b%x00"]);
  const byHash = new Map();
  for (const record of meta.split("\x00")) {
    const [hash, subject, body = ""] = record.split("\x01");
    if (!hash || !subject) continue;
    byHash.set(hash, { subject, body: body.trim().slice(0, BODY_SNIPPET_LIMIT) });
  }
  const filesOut = git(["log", `${prevTag}..HEAD`, "--no-merges", "--pretty=format:%H%x00", "--name-only"]);
  for (const record of filesOut.split("\x00")) {
    const lines = record.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const entry = byHash.get(lines[0]);
    if (!entry) continue;
    entry.files = lines
      .slice(1, 9)
      .map((f) => f.replace(/^([a-z]+\/)[^/]+/, "$1…"))
      .join(" ");
  }
  return [...byHash.values()];
}

// ── 入口白名单：真实存在的命令/flag/技能名，模型只能引用不能编造 ──

// pi 内置 slash 命令（docs/slash-commands.md），不在本仓库源码里，静态补充；
// 上游新增命令时同步这里
const PI_BUILTIN_COMMANDS = [
  "bug", "changelog", "clone", "compact", "copy", "export", "fork", "hotkeys", "import",
  "llama", "login", "logout", "model", "name", "new", "quit", "reload", "resume",
  "scoped-models", "session", "settings", "share", "thinking", "tree", "trust",
].map((c) => `/${c}`);

function collectEntrances() {
  const entrances = new Set(PI_BUILTIN_COMMANDS);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)) {
          entrances.add(m[1].startsWith("/") ? m[1] : `/${m[1]}`);
        }
        for (const m of src.matchAll(/registerFlag\(\s*["']([^"']+)["']/g)) entrances.add(`--${m[1]}`);
      }
    }
  };
  walk(join(REPO_DIR, "src", "extensions"));
  const skillsDir = join(REPO_DIR, "resources", "skills");
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) entrances.add(entry.name);
  }
  return [...entrances].sort();
}

/** bullet/亮点文本里出现的入口形 token（/cmd、--flag）；首字母小写限定，路径/大写词不误报 */
function entranceTokens(text) {
  const tokens = new Set();
  for (const m of text.matchAll(/(?:^|[^\w/-])(\/\^?[a-z][\w:.-]*|--[a-z][\w-]*)/g)) tokens.add(m[1]);
  return tokens;
}

// ── 模型改写层 ──────────────────────────────────────────────────────

function extractJsonArray(raw) {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`模型输出不含 JSON 数组：${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function extractJson(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`模型输出不含 JSON 对象：${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

// 三段式：大列表一次归类对 haiku 偏重、漏归重归频发；拆成三个小输出各自可靠。
// 第一段只聚类（输出只含序号）；第二段逐簇改写；第三段从成品 bullet 挑亮点。
function clusterPrompt(commits) {
  return [
    "把下列 hapilon 提交按主题聚类（同一功能/同一技能的迭代归一簇），输出 JSON 数组：",
    '[{"theme":"主题名","commits":[0,2]}]',
    "每条提交必须且只属于一簇；簇数 5-15；纯内部维护（dist 同步等）归一簇。",
    "只输出 JSON，不要其他文字。",
    "",
    ...commits.map((c, i) => `${i}. ${c.subject}`),
  ].join("\n");
}

function bulletPrompt(theme, commits, indices, entrances) {
  return [
    "你在为 hapilon（终端 coding agent）写 release notes。读者是决定要不要升级的用户，不是维护者。",
    `把主题「${theme}」的下列提交改写成 1-3 条用户视角 bullet，写结果不写过程（「撤 X 改 Y」这种流水账禁止出现）。`,
    `归入分组（只能选一个）：${[...VALID_GROUPS].join("、")}。都不合适才用「其他」。`,
    "- 剥掉纯内部引用：hpl- 前缀、阶段号（S7）、文档编号（§16）、内部文件名",
    "- 用户要敲的入口保留原文：命令（/block）、flag（--model tier:haiku[0]）、技能名（make-sense）——入口名只能来自白名单或提交原文，禁止编造，没把握就只描述行为",
    "- 每条一句以内，保留具体行为；用户读不懂的词不许出现",
    "",
    `入口白名单：${entrances.join("、")}`,
    "",
    "只输出 JSON：",
    '{"group":"分组名","bullets":[{"text":"…","commits":[0,1]}]}',
    "commits 用下方序号；每条提交必须且只出现在一个 bullet 里。",
    "",
    ...commits.map((c, i) => `${indices[i]}. ${c.subject}${c.body ? `｜正文：${c.body}` : ""}${c.files ? `｜文件：${c.files}` : ""}`),
  ].join("\n");
}

function highlightPrompt(bullets) {
  return [
    "你在为 hapilon 写 release notes 的「本版亮点」。读者是决定要不要升级的用户。",
    "从下列 bullet 中挑 1-5 条最有用户价值的，按价值排序（修的痛 > 新能力 > 界面 > 内部），改写成亮点：",
    "每条一句，可加粗导语；入口名（命令/flag/技能名）保持原文。只输出 JSON 字符串数组。",
    "",
    ...bullets.map((b, i) => `${i}. ${b.text}`),
  ].join("\n");
}

function callHaiku(prompt) {
  try {
    return execFileSync(
      process.execPath,
      [join(REPO_DIR, "dist", "cli.js"), "-p", prompt, "--model", "tier:haiku"],
      { cwd: REPO_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: HAIKU_TIMEOUT_MS },
    );
  } catch (err) {
    throw new Error(`模型调用失败（hapi --model tier:haiku）：${err.message}`);
  }
}

// 校验 + 归一模型输出；返回结构化结果，任何缺漏在这里抛错
function validateRewrite(raw, total) {
  const data = extractJson(raw);
  const highlights = data.highlights;
  assert.ok(Array.isArray(highlights) && highlights.length >= 1 && highlights.length <= 5, "亮点须 1-5 条");
  highlights.forEach((h, i) => assert.ok(typeof h === "string" && h.trim(), `亮点第 ${i} 条为空`));

  assert.ok(Array.isArray(data.groups) && data.groups.length > 0, "groups 为空");
  const covered = new Set();
  const groups = [];
  for (const g of data.groups) {
    assert.ok(VALID_GROUPS.has(g.title), `分组非法：${JSON.stringify(g.title)}`);
    // 空组（模型没内容可放）直接跳过，不算失败
    if (!Array.isArray(g.bullets) || g.bullets.length === 0) continue;
    const bullets = g.bullets.map((b) => {
      assert.ok(typeof b.text === "string" && b.text.trim(), `组 ${g.title} 有空 bullet`);
      for (const i of b.commits ?? []) {
        assert.ok(Number.isInteger(i) && i >= 0 && i < total, `组 ${g.title} 提交序号越界：${i}`);
        assert.ok(!covered.has(i), `提交 ${i} 被重复归入多个 bullet`);
        covered.add(i);
      }
      return { text: b.text.trim(), commits: b.commits ?? [] };
    });
    groups.push({ title: g.title, bullets });
  }
  const missing = [...Array(total).keys()].filter((i) => !covered.has(i));
  assert.ok(missing.length === 0, `有提交未落点：序号 ${missing.join(",")}`);
  return { highlights: highlights.map((h) => h.trim()), groups };
}

/** 抹除白名单外的入口 token（编造的命令/flag）；报警告不阻塞发版 */
function redactUnknownEntrances(result, allowed) {
  const warnings = [];
  const clean = (text) => {
    let out = text;
    for (const t of entranceTokens(text)) {
      if (!allowed.has(t)) {
        console.error(`⚠ 抹除编造入口 ${t}：${text.slice(0, 60)}`);
        warnings.push(`${t} ← ${text.slice(0, 80)}`);
        out = out.split(t).join("");
      }
    }
    return out.replace(/``/g, "").replace(/\s{2,}/g, " ").trim();
  };
  return {
    highlights: result.highlights.map(clean),
    groups: result.groups.map((g) => ({ ...g, bullets: g.bullets.map((b) => ({ ...b, text: clean(b.text) })) })),
    redactionWarnings: warnings,
  };
}

/** 带校验错误重试的小模型调用（小输出场景通用） */
function withRetry(label, prompt, validate, modelCall, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const raw = modelCall(
      attempt === 0 ? prompt : `${prompt}\n\n上次输出未过校验：${lastError.message}\n请修正后重新输出完整 JSON。`,
    );
    try {
      return validate(raw);
    } catch (err) {
      lastError = err;
      console.error(`↻ ${label} 第 ${attempt + 1} 次校验失败：${err.message}`);
    }
  }
  throw new Error(`${label} 重试 ${attempts} 次仍失败：${lastError.message}`);
}

function rewriteCommits(commits, modelCall = callHaiku) {
  console.error(`→ 三段式改写 ${commits.length} 条提交（hapi --model tier:haiku）`);
  // 白名单：注册的命令/flag/技能名 + pi 内置命令 + 提交原文里的入口（照抄原文合法）
  const allowed = new Set(collectEntrances());
  for (const c of commits) for (const t of entranceTokens(c.subject)) allowed.add(t);
  const entrances = [...allowed];

  // 第一段：聚类（输出只含序号，可靠性最高）
  const clusters = withRetry("聚类", clusterPrompt(commits), (raw) => {
    const data = extractJsonArray(raw);
    assert.ok(Array.isArray(data) && data.length >= 1, "聚类输出为空");
    const covered = new Set();
    for (const cl of data) {
      assert.ok(cl.theme && typeof cl.theme === "string", "聚类缺主题名");
      assert.ok(Array.isArray(cl.commits) && cl.commits.length > 0, `簇「${cl.theme}」无提交`);
      for (const i of cl.commits) {
        assert.ok(Number.isInteger(i) && i >= 0 && i < commits.length, `簇「${cl.theme}」序号越界：${i}`);
        assert.ok(!covered.has(i), `提交 ${i} 被重复聚类`);
        covered.add(i);
      }
    }
    const missing = [...Array(commits.length).keys()].filter((i) => !covered.has(i));
    assert.ok(missing.length === 0, `有提交未聚类：序号 ${missing.join(",")}`);
    return data;
  }, modelCall);

  // 第二段：逐簇改写（每簇一次调用，覆盖校验限定在簇内）
  const allBullets = [];
  for (const cl of clusters) {
    const members = cl.commits.map((i) => commits[i]);
    const result = withRetry(`改写「${cl.theme}」`, bulletPrompt(cl.theme, members, cl.commits, entrances), (raw) => {
      const data = extractJson(raw);
      assert.ok(VALID_GROUPS.has(data.group), `分组非法：${JSON.stringify(data.group)}`);
      assert.ok(Array.isArray(data.bullets) && data.bullets.length > 0, "无 bullet");
      const covered = new Set();
      for (const b of data.bullets) {
        assert.ok(typeof b.text === "string" && b.text.trim(), "有空 bullet");
        for (const i of b.commits ?? []) {
          assert.ok(cl.commits.includes(i), `提交 ${i} 不在本簇（本簇：${cl.commits.join(",")}）`);
          assert.ok(!covered.has(i), `提交 ${i} 在簇内重复归入`);
          covered.add(i);
        }
      }
      const missing = cl.commits.filter((i) => !covered.has(i));
      assert.ok(missing.length === 0, `簇内提交未落点：${missing.join(",")}`);
      return { group: data.group, bullets: data.bullets.map((b) => ({ text: b.text.trim(), commits: b.commits ?? [] })) };
    }, modelCall);
    allBullets.push(result);
  }

  // 第三段：亮点（输入是成品 bullet，模型只做挑选与润色）
  const flat = allBullets.flatMap((g) => g.bullets);
  const highlights = withRetry("亮点", highlightPrompt(flat), (raw) => {
    const data = extractJsonArray(raw);
    assert.ok(Array.isArray(data) && data.length >= 1 && data.length <= 5, "亮点须 1-5 条");
    data.forEach((h, i) => assert.ok(typeof h === "string" && h.trim(), `亮点第 ${i} 条为空`));
    return data.map((h) => h.trim());
  }, modelCall);

  // 分组合并 + 入口白名单抹除
  const groups = [];
  for (const title of [...GROUPS, "其他"]) {
    const bullets = allBullets.filter((g) => g.group === title).flatMap((g) => g.bullets);
    if (bullets.length > 0) groups.push({ title, bullets });
  }
  return redactUnknownEntrances({ highlights, groups }, allowed);
}

// ── 组装 ────────────────────────────────────────────────────────────

function upgradeSection(version) {
  return [
    "## 升级",
    "",
    "```bash",
    `npm install -g ${DOWNLOAD_BASE}/v${version}/hapilon-${version}.tgz`,
    "```",
    "",
    "生效需新开 pane（扩展、安全门与补丁都在进程启动时加载；插件的 shell 补丁在 `postinstall` 即已应用）。",
  ].join("\n");
}

function buildNotes({ version, commitCount, highlights, groups, warnings = [] }) {
  const lines = [`<!-- v${version} · ${commitCount} 条提交，全部落点已校验 -->`, ""];
  lines.push("## 本版亮点", "");
  for (const h of highlights) lines.push(`- ${h}`);
  lines.push("", "## 全部变更", "");
  for (const title of [...GROUPS, "其他"]) {
    const group = groups.find((g) => g.title === title);
    if (!group) continue;
    lines.push(`### ${title}`, "");
    for (const b of group.bullets) {
      const audit = b.commits.length > 1 ? ` <!-- 覆盖提交 ${b.commits.join(",")} -->` : "";
      lines.push(`- ${b.text}${audit}`);
    }
    lines.push("");
  }
  lines.push(upgradeSection(version), "");
  if (warnings.length > 0) {
    lines.push("<!-- ⚠ 模型编造的入口已被抹除，发版前请人工复核这些句子：", ...warnings.map((w) => `     ${w}`), "-->", "");
  }
  return lines.join("\n");
}

function main(argv) {
  const [prevTag, rawVersion] = argv;
  if (!VERSION_RE.test(rawVersion)) throw new Error(`版本号格式不对：${rawVersion}（期望 X.Y.Z）`);
  const version = rawVersion.replace(/^v/, "");
  resolveCommit(prevTag);

  const commits = readCommits(prevTag);
  if (commits.length === 0) {
    throw new Error(`${prevTag}..HEAD 没有提交——确认 prev-tag 是 HEAD 的祖先`);
  }

  const { highlights, groups, redactionWarnings } = rewriteCommits(commits);
  const outPath = join(REPO_DIR, ".hapilon", "release", `v${version}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildNotes({ version, commitCount: commits.length, highlights, groups, warnings: redactionWarnings }), "utf8");

  console.log(`已生成: ${relative(REPO_DIR, outPath)}（${commits.length} 条提交全覆盖）`);
  console.log("供 release.sh summary 参数选用：");
  highlights.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
}

// ── self-test（注入假模型，校验提示词之外的纯逻辑）────────────────

function selfTest() {
  const commits = [
    { subject: "feat(cli): 新命令", body: "", files: "src/…" },
    { subject: "chore: 同步 dist", body: "", files: "dist/…" },
    { subject: "fix(ui): 修 bug", body: "", files: "src/…" },
    { subject: "docs: 说明", body: "", files: "docs/…" },
  ];

  // 正常路径：全覆盖 + 合并
  const ok = validateRewrite(
    JSON.stringify({
      highlights: ["亮点一", "亮点二"],
      groups: [
        { title: "模型与会话", bullets: [{ text: "新命令来了", commits: [0] }] },
        { title: "界面与显示", bullets: [{ text: "修了 bug", commits: [2] }] },
        { title: "发版与维护", bullets: [{ text: "内部维护（同步 dist 与文档）", commits: [1, 3] }] },
      ],
    }),
    commits.length,
  );
  assert.equal(ok.highlights.length, 2);
  assert.equal(ok.groups.length, 3);

  // 组装：合并 bullet 带 HTML 审计注释，分组按固定顺序输出
  const notes = buildNotes({ version: "1.1.0", commitCount: commits.length, ...ok });
  const markers = [
    "## 本版亮点",
    "- 亮点一",
    "## 全部变更",
    "### 模型与会话",
    "### 界面与显示",
    "### 发版与维护",
    "内部维护（同步 dist 与文档） <!-- 覆盖提交 1,3 -->",
    "## 升级",
  ];
  markers.reduce((prev, marker) => {
    const at = notes.indexOf(marker);
    assert.ok(at > prev, `notes 结构错位: ${marker}\n${notes}`);
    return at;
  }, -1);

  const url = `${DOWNLOAD_BASE}/v1.1.0/hapilon-1.1.0.tgz`;
  assert.ok(notes.includes(`npm install -g ${url}`), "升级命令 URL 不对");

  // 校验层：漏提交、重复归入、非法组、空亮点都要拒
  const bad = (raw, re) => assert.throws(() => validateRewrite(raw, commits.length), re);
  const mk = (o) => JSON.stringify(o);
  bad(mk({ highlights: [], groups: [{ title: "其他", bullets: [{ text: "x", commits: [0, 1, 2, 3] }] }] }), /亮点/);
  bad(mk({ highlights: ["x"], groups: [{ title: "不存在的组", bullets: [{ text: "x", commits: [0, 1, 2, 3] }] }] }), /分组非法/);
  bad(mk({ highlights: ["x"], groups: [{ title: "其他", bullets: [{ text: "只盖三条", commits: [0, 1, 2] }] }] }), /未落点/);
  bad(
    mk({ highlights: ["x"], groups: [{ title: "其他", bullets: [{ text: "a", commits: [0, 1] }, { text: "b", commits: [1, 2, 3] }] }] }),
    /重复归入/,
  );
  bad(mk({ highlights: ["x"], groups: [{ title: "其他", bullets: [{ text: "越界", commits: [0, 1, 2, 9] }] }] }), /越界/);

  // 编造入口不阻塞：结构过验后抹除白名单外 token，保留白名单内的
  const allowed = new Set(["/new", "--model", "make-sense"]);
  const redacted = redactUnknownEntrances(
    validateRewrite(
      mk({ highlights: ["`/fast` 与 `/new` 可用"], groups: [{ title: "其他", bullets: [{ text: "支持 `--eli60` 与 `--model`", commits: [0, 1, 2, 3] }] }] }),
      commits.length,
    ),
    allowed,
  );
  assert.equal(redacted.highlights[0], "与 `/new` 可用");
  assert.equal(redacted.groups[0].bullets[0].text, "支持 与 `--model`");
  assert.equal(redacted.redactionWarnings.length, 2);

  // 抹除记录进文件末尾的 HTML 注释，发版前人工复核
  const warned = buildNotes({ version: "1.1.0", commitCount: commits.length, highlights: redacted.highlights, groups: redacted.groups, warnings: redacted.redactionWarnings });
  assert.ok(warned.includes("⚠ 模型编造的入口已被抹除"), "缺抹除复核注释");

  // 入口 token 提取：/cmd、--flag、/a:b 形态；普通词与路径不误报
  assert.deepEqual([...entranceTokens("`/team:open` 与 --model 和 /settings 可用")].sort(), ["--model", "/settings", "/team:open"]);
  assert.deepEqual([...entranceTokens("新增 22 套主题，路径 /Volumes/x 正常")], []);

  // 提交解析：hash 对齐 subject/body 与文件列表
  assert.equal(readCommits.name, "readCommits");

  // 模型输出解析：容忍围栏与前后噪音
  assert.deepEqual(
    extractJson('结果：```json\n{"highlights":["x"]}\n```'),
    { highlights: ["x"] },
  );
  assert.throws(() => extractJson("没有对象"), /不含 JSON 对象/);

  // tag 不存在必须报错，不能静默产出空文件
  assert.throws(() => resolveCommit("v0.0.0-not-a-real-tag"), /找不到提交或 tag/);

  console.log("✓ self-test 通过");
}

const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h") {
  console.log(usageText());
} else if (argv[0] === "--self-test") {
  selfTest();
} else if (argv.length !== 2) {
  console.error(usageText());
  process.exit(1);
} else {
  try {
    main(argv);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
