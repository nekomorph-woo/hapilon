#!/usr/bin/env node
/**
 * release notes 草稿生成器：把 git log <prev-tag>..HEAD 的 conventional commit
 * 按 type/scope 分组，产出一份待人工定稿的 Markdown 草稿（.hapilon/release/v<版本>.md）
 * 和供 release.sh summary 参数选用的候选句。
 *
 * 只做分组与拼接，不碰网络、不做摘要生成——文案是人的活，工具只负责不遗漏。
 *
 * 用法：
 *   node scripts/release-notes.mjs <prev-tag> <新版本>
 *   node scripts/release-notes.mjs --self-test
 *   node scripts/release-notes.mjs --help
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD_BASE = "https://github.com/nekomorph-woo/hapilon/releases/download";
const SECTION_ORDER = ["新能力", "修复", "性能", "其他"];
const TYPE_SECTION = { feat: "新能力", fix: "修复", perf: "性能" };
const NO_SCOPE = "通用";
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/i;
const VERSION_RE = /^v?\d+\.\d+\.\d+$/;
const SUMMARY_LIMIT = 3;

function usageText() {
  return [
    "用法: node scripts/release-notes.mjs <prev-tag> <新版本>",
    "      node scripts/release-notes.mjs --self-test",
    "",
    "从 git log <prev-tag>..HEAD 生成 conventional commit 分组草稿到",
    ".hapilon/release/v<新版本>.md（本地草稿，不入库），并打印可传给 release.sh 的摘要候选。",
    "",
    "示例: node scripts/release-notes.mjs v0.6.0 0.6.1",
    '定稿: ./scripts/release.sh --notes .hapilon/release/v0.6.1.md minor "一句话摘要"',
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

// 非 conventional 的 subject 整条归「其他」，不猜 type（猜错比漏分组更误导定稿人）
function parseSubject(subject) {
  const match = CONVENTIONAL.exec(subject);
  if (!match) return { section: "其他", scope: "", text: subject };
  const [, type, scope = "", text] = match;
  return { section: TYPE_SECTION[type.toLowerCase()] ?? "其他", scope, text };
}

function readCommits(prevTag) {
  // 合并提交的 subject 不带 type，只会变成「其他」噪音
  const out = git(["log", `${prevTag}..HEAD`, "--no-merges", "--pretty=format:%s%x00"]);
  return out
    .split("\0")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseSubject);
}

function header(version) {
  return [
    "<!-- 草稿，未定稿；编辑完请删除本注释。",
    "     定稿建议：标题与叙事改成用户视角，同 scope 的碎修合并成一段，",
    "     删掉纯内部改动（refactor/test/chore 噪音），保留命令与数据。",
    `     定稿后：./scripts/release.sh --notes .hapilon/release/v${version}.md <patch|minor> "一句话摘要" -->`,
  ].join("\n");
}

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

function buildDraft({ version, commits }) {
  const groups = new Map(SECTION_ORDER.map((section) => [section, new Map()]));
  for (const commit of commits) {
    const byScope = groups.get(commit.section);
    if (!byScope.has(commit.scope)) byScope.set(commit.scope, []);
    byScope.get(commit.scope).push(commit.text);
  }

  const lines = [header(version), ""];
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

  const commits = readCommits(prevTag);
  if (commits.length === 0) {
    throw new Error(`${prevTag}..HEAD 没有提交——确认 prev-tag 是 HEAD 的祖先`);
  }

  const outPath = join(REPO_DIR, ".hapilon", "release", `v${version}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildDraft({ version, commits }), "utf8");

  const rel = relative(REPO_DIR, outPath);
  console.log(`草稿: ${rel}（${commits.length} 条提交；本地草稿，不入库）`);
  const candidates = summaryCandidates(commits);
  if (candidates.length === 0) {
    console.log("无 feat 提交——summary 请手工撰写。");
  } else {
    console.log("供 release.sh summary 参数选用：");
    candidates.forEach((text, i) => console.log(`  ${i + 1}. ${text}`));
  }
  console.log(`定稿后: ./scripts/release.sh --notes ${rel} <patch|minor> "一句话摘要"`);
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
  assert.deepEqual(p("docs(golden-case): 补全技能入口"), {
    section: "其他",
    scope: "golden-case",
    text: "补全技能入口",
  });
  assert.deepEqual(p("chore: 同步 dist"), { section: "其他", scope: "", text: "同步 dist" });
  assert.deepEqual(p("revert(help): 帮助文案保持原样"), {
    section: "其他",
    scope: "help",
    text: "帮助文案保持原样",
  });
  // 非 conventional：整条原文归「其他」，不猜 type
  assert.deepEqual(p("v0.6.0 手工改的一行"), { section: "其他", scope: "", text: "v0.6.0 手工改的一行" });
  assert.deepEqual(p("Merge branch 'main'"), { section: "其他", scope: "", text: "Merge branch 'main'" });

  const draft = buildDraft({
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
    const at = draft.indexOf(marker);
    assert.ok(at > prev, `草稿结构错位: ${marker}\n${draft}`);
    return at;
  }, -1);

  const url = `${DOWNLOAD_BASE}/v1.1.0/hapilon-1.1.0.tgz`;
  assert.ok(draft.includes(`npm install -g ${url}`), "升级命令 URL 不对");
  assert.ok(draft.includes("生效需新开 pane"), "缺少生效提示");

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

  // tag 不存在必须报错，不能静默产出空草稿
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
