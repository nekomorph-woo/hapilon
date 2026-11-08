#!/usr/bin/env node
/**
 * issue 评论检测：扫 git log <range> 的提交，抓 GitHub 关闭关键词与裸 #N 引用，
 * 按 issue 聚合并查 open 状态，产出待评论清单。检测只读，不发评论。
 *
 * 发布流程位置：push 之前。GitHub 的 auto-close 发生在 commit 落到默认分支那一刻
 * （不是 commit 创建时），先评论后 push，读者在一条时间线上看到方案说明与关闭；
 * 错过顺序也无害，closed issue 仍可评论，只是通知显得迟到。
 *
 * 分工：检测归本脚本；评论正文由 agent 按下方起草模式读实现后撰写，直接
 * gh issue comment 发布（开源仓库，不设人工确认）。
 *
 * 起草模式（对齐 hapilon#69 那条的实际结构）：
 *   1. 结论先行：做了什么、命令入口，第一句说完；
 *   2. 方案小节：交互流程 / 隔离与安全 / 可信机制，按实现实际有的写，没有的小节删；
 *   3. 取舍：放弃了什么旧方案、为什么——because 是承重墙，必须留；
 *   4. 收尾给关键提交与代码路径；评论区已有同主题评论则跳过。
 *
 * 用法：
 *   node scripts/issue-comments.mjs [range]          # 默认最新 v* tag..HEAD（无 tag 回退 origin/main..HEAD）
 *   node scripts/issue-comments.mjs --json [range]
 *   node scripts/issue-comments.mjs --self-test
 */

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 待发范围的本义是「最新 tag 之后的提交」：用 origin/main..HEAD 时，若 main 先于发版被推
// （并行会话/重试场景）基线为空，issue 引用直接漏检（#70 实际发生过）。tag 基线与 push 时序无关。
function defaultRange() {
  const latest = execFileSync("git", ["tag", "-l", "v*", "--sort=-v:refname"], { cwd: REPO_DIR, encoding: "utf8" })
    .split("\n")[0];
  return latest ? `${latest}..HEAD` : "origin/main..HEAD";
}

function usageText() {
  return [
    "用法: node scripts/issue-comments.mjs [range]          # 默认最新 v* tag..HEAD",
    "      node scripts/issue-comments.mjs --json [range]",
    "      node scripts/issue-comments.mjs --self-test",
    "",
    "扫待发提交里的 issue 引用，按 issue 聚合并查 open 状态；检测只读，",
    "评论正文由 agent 按文件头起草模式撰写后 gh issue comment 发布。",
  ].join("\n");
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gh(args) {
  return execFileSync("gh", args, { cwd: REPO_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// GitHub 关闭关键词全量 9 种：close/closes/closed、fix/fixes/fixed、resolve/resolves/resolved，
// 大小写不敏感。关键词与 #N 须同行，跨行不触发（保守口径：徽标宁可标「需人工关闭」，
// 误标「将自动关闭」会让 issue 悬着没人管）；「Fix: #1」带冒号、中文「关闭 #1」同样只算
// 普通引用；跨仓引用 owner/repo#N 不指本地 issue，先剥离再解析
const CLOSE_KEYWORD_RE = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)[ \t]+(#\d+(?:[, \t]+(?:and[ \t]+)?#\d+)*)/gi;
const CROSS_REPO_REF_RE = /\b[\w.-]+\/[\w.-]+#\d+/g;
const ISSUE_REF_RE = /#(\d+)/g;

// 纯函数：单条提交消息 → 关闭引用与全部引用（去重）
function parseIssueRefs(message) {
  const text = message.replace(CROSS_REPO_REF_RE, "");
  const closing = new Set();
  for (const m of text.matchAll(CLOSE_KEYWORD_RE)) {
    for (const n of m[1].matchAll(ISSUE_REF_RE)) closing.add(Number(n[1]));
  }
  const referenced = new Set();
  for (const m of text.matchAll(ISSUE_REF_RE)) referenced.add(Number(m[1]));
  return { closing, referenced };
}

// 纯函数：提交数组 → 按 issue 聚合（同一 issue 的多个提交合成一条评论的素材）
function collectIssues(commits) {
  const map = new Map();
  for (const c of commits) {
    const { closing, referenced } = parseIssueRefs(`${c.subject}\n${c.body}`);
    for (const n of referenced) {
      if (!map.has(n)) map.set(n, { number: n, autoClose: false, commits: [] });
      map.get(n).commits.push({ hash: c.hash.slice(0, 7), subject: c.subject });
    }
    for (const n of closing) map.get(n).autoClose = true;
  }
  return [...map.values()].sort((a, b) => a.number - b.number);
}

function readCommits(range) {
  const raw = git(["log", range, "--no-merges", "--pretty=format:%H%x01%s%x01%b%x00"]);
  const commits = [];
  for (const record of raw.split("\x00")) {
    if (!record.trim()) continue;
    // 非 首条记录以 --pretty=format 的分隔换行开头，先去掉再拆字段
    const [hash, subject, body] = record.trimStart().split("\x01");
    commits.push({ hash, subject, body });
  }
  return commits;
}

function issueDetails(slug, number) {
  const raw = gh(["api", `repos/${slug}/issues/${number}`, "--jq", "{state: .state, title: .title}"]);
  return JSON.parse(raw);
}

function main(range, asJson) {
  const issues = collectIssues(readCommits(range));
  if (issues.length === 0) {
    console.log(`${range} 内没有关联 issue 的提交，无事可做。`);
    return;
  }
  const slug = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  const enriched = issues.map((entry) => ({ ...entry, ...issueDetails(slug, entry.number) }));
  const open = enriched.filter((i) => i.state === "open");
  const closed = enriched.filter((i) => i.state !== "open");

  if (asJson) {
    console.log(JSON.stringify({ range, repo: slug, issues: enriched }, null, 2));
    return;
  }

  console.log(`range: ${range}（${slug}）`);
  for (const i of open) {
    const badge = i.autoClose ? "[将随 push 自动关闭]" : "[仅引用，需人工关闭]";
    console.log(`\n#${i.number} ${badge} ${i.title}`);
    for (const c of i.commits) console.log(`    ${c.hash} ${c.subject}`);
    console.log(`    → agent 读关联实现按起草模式写评论，直接 gh issue comment 发布`);
  }
  for (const i of closed) {
    console.log(`\n#${i.number}（已关闭，跳过）${i.title}`);
  }
  if (open.length === 0) console.log("\n待评论 issue：无（引用的 issue 都已关闭）。");
}

// ── self-test（校验引用解析与聚合的纯逻辑）────────────────

function selfTest() {
  // 关键词直跟引用触发 auto-close；列表写法整组识别
  assert.deepEqual(parseIssueRefs("fixes #12"), { closing: new Set([12]), referenced: new Set([12]) });
  assert.deepEqual(parseIssueRefs("Close #1, #2 and #3"), { closing: new Set([1, 2, 3]), referenced: new Set([1, 2, 3]) });
  assert.deepEqual(parseIssueRefs("RESOLVED #9"), { closing: new Set([9]), referenced: new Set([9]) });

  // 全量 9 种关键词逐一触发（close/closes/closed、fix/fixes/fixed、resolve/resolves/resolved）
  for (const kw of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
    assert.deepEqual(parseIssueRefs(`${kw} #8`), { closing: new Set([8]), referenced: new Set([8]) }, kw);
  }

  // 冒号、中文关键词、关键词跨行都只算引用；词根嵌在别的词里不触发（prefixes/unresolved）
  assert.deepEqual(parseIssueRefs("Fix: #12"), { closing: new Set(), referenced: new Set([12]) });
  assert.deepEqual(parseIssueRefs("关闭 #69"), { closing: new Set(), referenced: new Set([69]) });
  assert.deepEqual(parseIssueRefs("fixes\n#12"), { closing: new Set(), referenced: new Set([12]) });
  assert.deepEqual(parseIssueRefs("prefixes #3 unresolved #4"), { closing: new Set(), referenced: new Set([3, 4]) });

  // 跨仓引用 owner/repo#N 不指本地 issue：关键词绑定给跨仓引用时，本地引用只算普通引用
  assert.deepEqual(parseIssueRefs("fixes libfoo/bar#42，同时见 #7"), { closing: new Set(), referenced: new Set([7]) });
  assert.deepEqual(parseIssueRefs("close #1 and lib/x#2"), { closing: new Set([1]), referenced: new Set([1]) });

  // 裸引用、正文引用、混入哈希样文本不误判
  assert.deepEqual(parseIssueRefs("找回会话（#69）"), { closing: new Set(), referenced: new Set([69]) });
  assert.deepEqual(parseIssueRefs("no refs here"), { closing: new Set(), referenced: new Set() });

  // 聚合：多提交同 issue 合成一条，任一关闭关键词即 autoClose
  const merged = collectIssues([
    { hash: "aaaaaaaaaaaaaaaa", subject: "feat: 一版", body: "fixes #69" },
    { hash: "bbbbbbbbbbbbbbbb", subject: "feat: 重写", body: "见 #69" },
    { hash: "cccccccccccccccc", subject: "chore: 无关", body: "" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].number, 69);
  assert.equal(merged[0].autoClose, true);
  assert.deepEqual(merged[0].commits.map((c) => c.hash), ["aaaaaaa", "bbbbbbb"]);

  // 排序与独立 issue
  const multi = collectIssues([
    { hash: "d000000000000000", subject: "a #7", body: "" },
    { hash: "e000000000000000", subject: "b #3", body: "" },
  ]);
  assert.deepEqual(multi.map((i) => i.number), [3, 7]);
  assert.equal(multi[0].autoClose, false);

  console.log("✓ self-test 通过");
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const range = argv.find((a, i) => i >= (argv[0] === "--json" ? 1 : 0) && !a.startsWith("--"));
if (argv[0] === "--help" || argv[0] === "-h") {
  console.log(usageText());
} else if (argv[0] === "--self-test") {
  selfTest();
} else {
  try {
    main(range ?? defaultRange(), asJson);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
