#!/usr/bin/env node
/**
 * release notes 生成器：把 git log <prev-tag>..HEAD 的提交逐条放入 release 分块，
 * 产出可直接发布的 Markdown（.hapilon/release/v<版本>.md）。
 *
 * 归类规则：
 * - conventional commit 按 type 机械映射（feat→新能力 fix→修复 perf→性能，其余 type→其他）
 * - 无法按 type 映射的提交，批量交给 haiku 档（hapi --model tier:haiku）决策分块并改写成用户视角描述
 *
 * 由 release.sh 第 0 步在发版现场调用（消灭草稿与 tag 之间的提交时间差）。
 *
 * 用法：
 *   node scripts/release-notes.mjs <prev-tag> <新版本>
 *   node scripts/release-notes.mjs --self-test
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD_BASE = "https://github.com/nekomorph-woo/hapilon/releases/download";
const SECTION_ORDER = ["新能力", "修复", "性能", "其他"];
const VALID_SECTIONS = new Set(SECTION_ORDER);
const TYPE_SECTION = { feat: "新能力", fix: "修复", perf: "性能" };
const NO_SCOPE = "通用";
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/i;
const VERSION_RE = /^v?\d+\.\d+\.\d+$/;
const SUMMARY_LIMIT = 3;
const HAIKU_TIMEOUT_MS = 120_000;

function usageText() {
  return [
    "用法: node scripts/release-notes.mjs <prev-tag> <新版本>",
    "      node scripts/release-notes.mjs --self-test",
    "",
    "从 git log <prev-tag>..HEAD 生成正式 release notes 到",
    ".hapilon/release/v<新版本>.md，供 release.sh 第 0 步自动调用。",
    "归类：conventional type 机械映射；无法映射的提交经 hapi --model tier:haiku 决策。",
    "",
    "示例: node scripts/release-notes.mjs v0.6.0 0.6.1",
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

// section 为 null 表示无法按 type 机械归类，交给 haiku 决策
function parseSubject(subject) {
  const match = CONVENTIONAL.exec(subject);
  if (!match) return { section: null, scope: "", text: subject };
  const [, type, scope = "", text] = match;
  return { section: TYPE_SECTION[type.toLowerCase()] ?? "其他", scope, text };
}

function readCommits(prevTag) {
  // 合并提交的 subject 不带 type，只会污染分类
  const out = git(["log", `${prevTag}..HEAD`, "--no-merges", "--pretty=format:%s%x00"]);
  return out
    .split("\0")
    .map((line) => line.trim())
    .filter(Boolean);
}

// ── haiku 档模型决策 ────────────────────────────────────────────────

function extractJsonArray(raw) {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`haiku 输出不含 JSON 数组：${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function haikuPrompt(subjects) {
  return [
    "你在为 hapilon 的 release notes 把提交归入分块，并把标题改写成用户能听懂的描述。",
    `分块只能是：${SECTION_ORDER.join("、")}。`,
    "描述保留具体行为，不写文件名与内部代号，一句以内。",
    "只输出 JSON 数组，不要任何其他文字或代码围栏，格式：",
    '[{"i":0,"section":"修复","text":"……"}]',
    "",
    "提交列表：",
    ...subjects.map((subject, i) => `${i}. ${subject}`),
  ].join("\n");
}

function classifyWithHaiku(subjects) {
  console.error(`→ haiku 分类 ${subjects.length} 条（hapi --model tier:haiku）`);
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [join(REPO_DIR, "dist", "cli.js"), "-p", haikuPrompt(subjects), "--model", "tier:haiku"],
      {
        cwd: REPO_DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: HAIKU_TIMEOUT_MS,
      },
    );
  } catch (err) {
    throw new Error(`haiku 档模型调用失败（hapi --model tier:haiku）：${err.message}`);
  }
  const decisions = extractJsonArray(out);
  if (!Array.isArray(decisions) || decisions.length !== subjects.length) {
    throw new Error(`haiku 决策条数不符（期望 ${subjects.length}，得到 ${decisions.length}）：${out.slice(0, 200)}`);
  }
  return decisions.map((d, i) => {
    assert.ok(VALID_SECTIONS.has(d.section), `haiku 第 ${i} 条分块非法：${JSON.stringify(d.section)}`);
    assert.ok(typeof d.text === "string" && d.text.trim(), `haiku 第 ${i} 条描述为空`);
    assert.ok(d.i === i, `haiku 第 ${i} 条序号错位：${JSON.stringify(d.i)}`);
    return { section: d.section, scope: "", text: d.text.trim() };
  });
}

function classifyCommits(subjects) {
  const commits = [];
  const pending = [];
  for (const subject of subjects) {
    const parsed = parseSubject(subject);
    if (parsed.section === null) pending.push(parsed);
    else commits.push(parsed);
  }
  if (pending.length > 0) {
    commits.push(...classifyWithHaiku(pending.map((p) => p.text)));
  }
  return commits;
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

function buildNotes({ version, commits }) {
  const groups = new Map(SECTION_ORDER.map((section) => [section, new Map()]));
  for (const commit of commits) {
    const byScope = groups.get(commit.section);
    if (!byScope.has(commit.scope)) byScope.set(commit.scope, []);
    byScope.get(commit.scope).push(commit.text);
  }

  const lines = [`<!-- scripts/release-notes.mjs 自动生成：${commits.length} 条提交 -->`, ""];
  for (const section of SECTION_ORDER) {
    const byScope = groups.get(section);
    if (byScope.size === 0) continue;
    lines.push(`## ${section}`, "");
    for (const [scope, texts] of byScope) {
      lines.push(`### ${scope || NO_SCOPE}`, "");
      for (const text of texts) lines.push(`- ${text}`);
      lines.push("");
    }
  }
  lines.push(upgradeSection(version), "");
  return lines.join("\n");
}

function summaryCandidates(commits) {
  const seen = new Set();
  const out = [];
  for (const commit of commits) {
    if (commit.section !== "新能力" || seen.has(commit.text)) continue;
    seen.add(commit.text);
    out.push(commit.text);
    if (out.length === SUMMARY_LIMIT) break;
  }
  return out;
}

function main(argv) {
  const [prevTag, rawVersion] = argv;
  if (!VERSION_RE.test(rawVersion)) throw new Error(`版本号格式不对：${rawVersion}（期望 X.Y.Z）`);
  const version = rawVersion.replace(/^v/, "");
  resolveCommit(prevTag);

  const subjects = readCommits(prevTag);
  if (subjects.length === 0) {
    throw new Error(`${prevTag}..HEAD 没有提交——确认 prev-tag 是 HEAD 的祖先`);
  }

  const commits = classifyCommits(subjects);
  const outPath = join(REPO_DIR, ".hapilon", "release", `v${version}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildNotes({ version, commits }), "utf8");

  const rel = relative(REPO_DIR, outPath);
  console.log(`已生成: ${rel}（${commits.length} 条提交）`);
  const candidates = summaryCandidates(commits);
  if (candidates.length === 0) {
    console.log("无 feat 提交——summary 请手工撰写。");
  } else {
    console.log("供 release.sh summary 参数选用：");
    candidates.forEach((text, i) => console.log(`  ${i + 1}. ${text}`));
  }
}

function selfTest() {
  const p = parseSubject;
  assert.deepEqual(p("feat(orchestra): worker 角色支持多实例"), {
    section: "新能力",
    scope: "orchestra",
    text: "worker 角色支持多实例",
  });
  assert.deepEqual(p("fix: 修复中段 slash 触发门"), { section: "修复", scope: "", text: "修复中段 slash 触发门" });
  assert.deepEqual(p("perf(cli): 启动提速"), { section: "性能", scope: "cli", text: "启动提速" });
  // 已知 conventional type 但无专属分块 → 机械归「其他」
  assert.deepEqual(p("chore: 同步 dist"), { section: "其他", scope: "", text: "同步 dist" });
  assert.deepEqual(p("docs(golden-case): 补全技能入口"), {
    section: "其他",
    scope: "golden-case",
    text: "补全技能入口",
  });
  assert.deepEqual(p("revert(help): 帮助文案保持原样"), {
    section: "其他",
    scope: "help",
    text: "帮助文案保持原样",
  });
  // 非 conventional → 交给 haiku（section null 标记）
  assert.deepEqual(p("v0.6.0 手工改的一行"), { section: null, scope: "", text: "v0.6.0 手工改的一行" });
  assert.deepEqual(p("Merge branch 'main'"), { section: null, scope: "", text: "Merge branch 'main'" });

  const notes = buildNotes({
    version: "1.1.0",
    commits: [
      p("chore: 同步 dist"),
      p("feat(cli): 新命令"),
      p("feat(orchestra): 派发收口"),
      p("feat(cli): 第二条"),
      p("fix(prompt): 修 bug"),
    ],
  });
  const markers = [
    "## 新能力",
    "### cli",
    "- 新命令",
    "- 第二条",
    "### orchestra",
    "- 派发收口",
    "## 修复",
    "### prompt",
    "- 修 bug",
    "## 其他",
    "### 通用",
    "- 同步 dist",
    "## 升级",
  ];
  markers.reduce((prev, marker) => {
    const at = notes.indexOf(marker);
    assert.ok(at > prev, `notes 结构错位: ${marker}\n${notes}`);
    return at;
  }, -1);

  const url = `${DOWNLOAD_BASE}/v1.1.0/hapilon-1.1.0.tgz`;
  assert.ok(notes.includes(`npm install -g ${url}`), "升级命令 URL 不对");
  assert.ok(notes.includes("生效需新开 pane"), "缺少生效提示");

  assert.deepEqual(
    summaryCandidates([
      p("feat(a): A"),
      p("feat(b): B"),
      p("feat(c): C"),
      p("feat(d): D"),
      p("feat(a): A"),
      p("fix(x): X"),
    ]),
    ["A", "B", "C"],
  );
  assert.deepEqual(summaryCandidates([p("fix(x): X"), p("docs: Y")]), []);

  // haiku 输出解析：容忍围栏与前后噪音
  assert.deepEqual(extractJsonArray('好的，以下是结果：```json\n[{"i":0,"section":"修复","text":"x"}]\n```'), [
    { i: 0, section: "修复", text: "x" },
  ]);
  assert.throws(() => extractJsonArray("没有数组"), /不含 JSON 数组/);

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
