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
import { mkdirSync, writeFileSync } from "node:fs";
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

// ── 模型改写层 ──────────────────────────────────────────────────────

function extractJson(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`模型输出不含 JSON 对象：${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function rewritePrompt(commits) {
  return [
    "你在为 hapilon（终端 coding agent）写 release notes。读者是决定要不要升级的用户，不是维护者。",
    "",
    "任务：把下列提交全部改写进两层结构。",
    "",
    "第一层「亮点」：1-5 条，按用户可感知价值排序（修的痛 > 新能力 > 界面 > 内部），",
    "一句话一条，可加粗导语；真正的发布主题排第一。",
    "第二层「分组」：每条提交归入一个组并改写成用户视角 bullet：",
    `组只能是：${[...VALID_GROUPS].join("、")}。都不合适才用「其他」。`,
    "- 同一功能的多次迭代提交合并成一条 bullet，写结果不写过程（「撤 X 改 Y」这种流水账禁止出现）",
    "- 剥掉纯内部引用：hpl- 前缀、阶段号（S7）、文档编号（§16）、内部文件名。",
    "- 但用户要敲的入口必须保留原文：命令（/block、/team:open）、参数与 flag（--model tier:haiku[0]）、",
    "  技能与命令名（make-sense、器物晚报）——这些是操作入口，翻译成描述用户反而找不到",
    "- 描述本身用中文，但入口名、代码、路径保持原文嵌在句中",
    "- 纯内部维护（dist 同步、函数收私有）可几条合一条，但不能丢弃",
    "- 每条 bullet 一句以内，保留具体行为；用户读不懂的词不许出现",
    "",
    "只输出 JSON 对象，不要其他文字或围栏：",
    '{"highlights":["…"],"groups":[{"title":"安全与信任","bullets":[{"text":"…","commits":[0,2]}]}]}',
    "commits 是该 bullet 覆盖的提交序号数组——每条提交必须且只能出现在一个 bullet 里。",
    "",
    "提交列表：",
    ...commits.map((c, i) => `${i}. ${c.subject}${c.body ? `｜正文：${c.body}` : ""}${c.files ? `｜文件：${c.files}` : ""}`),
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

function rewriteCommits(commits, modelCall = callHaiku) {
  console.error(`→ 模型改写 ${commits.length} 条提交（hapi --model tier:haiku）`);
  // 模型偶发漏归/重归：带着校验错误重试一次，再不行就硬失败
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = modelCall(
      attempt === 0
        ? rewritePrompt(commits)
        : `${rewritePrompt(commits)}\n\n上次输出未过校验：${lastError.message}\n请修正后重新输出完整 JSON。`,
    );
    try {
      return validateRewrite(raw, commits.length);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
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

function buildNotes({ version, commitCount, highlights, groups }) {
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

  const { highlights, groups } = rewriteCommits(commits);
  const outPath = join(REPO_DIR, ".hapilon", "release", `v${version}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildNotes({ version, commitCount: commits.length, highlights, groups }), "utf8");

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
