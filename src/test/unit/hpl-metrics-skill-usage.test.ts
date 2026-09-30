import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  firstUserPreview,
  loadSkillUsage,
  originOf,
  parseCommandLine,
  parseSkillInjection,
  parseTimestamp,
  replaySession,
} from "../../extensions/hpl-metrics/skills/usage.js";

const HOME = "/Users/example/.hapilon-dev";

// 真实会话文件里验证过的行形态
const SKILL_INJECT_LINE = JSON.stringify({
  type: "message",
  id: "a1",
  timestamp: "2026-09-30T01:12:21.950Z",
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text:
          '<skill name="recon" location="/Volumes/work/hapilon/resources/skills/recon/SKILL.md">\n正文\n</skill>\n看下这个扩展的结构',
      },
    ],
  },
});

const SKILL_INJECT_NO_ARGS_LINE = JSON.stringify({
  type: "message",
  id: "a2",
  timestamp: 1790733146806,
  message: {
    role: "user",
    content: [{ type: "text", text: '<skill name="snap" location="/Users/example/.hapilon-dev/agent/skills/snap/SKILL.md">\n正文\n</skill>' }],
  },
});

const PLAIN_USER_LINE = JSON.stringify({
  type: "message",
  id: "a3",
  timestamp: 1790733147000,
  message: { role: "user", content: [{ type: "text", text: "普通问题，不是 skill 触发" }] },
});

const READ_SKILL_LINE = JSON.stringify({
  type: "message",
  id: "b1",
  timestamp: "2026-09-30T01:13:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "toolCall", id: "c1", name: "read", arguments: { limit: 120, path: `${HOME}/agent/skills/dom/SKILL.md`, offset: 1 } },
      { type: "text", text: "顺便的正文" },
    ],
  },
});

const BASH_MENTION_LINE = JSON.stringify({
  type: "message",
  id: "b2",
  timestamp: "2026-09-30T01:14:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "toolCall", id: "c2", name: "bash", arguments: { command: "cat resources/skills/ask/SKILL.md | head -20" } },
    ],
  },
});

const SESSION_LINE = JSON.stringify({ type: "session", cwd: "/Volumes/work/demo", timestamp: "2026-09-30T01:00:00.000Z" });

describe("parseSkillInjection", () => {
  it("取 name/location，</skill> 后是参数原话", () => {
    const parsed = parseSkillInjection(
      '<skill name="ask" location="/x/SKILL.md">\n纪律正文\n</skill>\n为什么会 fold',
    );
    assert.deepEqual(parsed, { skill: "ask", location: "/x/SKILL.md", args: "为什么会 fold" });
  });

  it("无参数时 args 为空串；非注入行返回 undefined", () => {
    assert.equal(parseSkillInjection('<skill name="snap" location="/x">\n正文\n</skill>')?.args, "");
    assert.equal(parseSkillInjection("普通输入"), undefined);
  });
});

describe("parseCommandLine / firstUserPreview", () => {
  it("slash 命令采集：二级路径、参数、排除 skill: 与路径粘贴", () => {
    const parsed = parseCommandLine("/ne/settings 设置面板");
    assert.deepEqual(parsed, { name: "ne", skill: "ne/settings", args: "设置面板" });
    assert.equal(parseCommandLine("/skill:recon 看结构"), undefined, "/skill: 由注入块统计");
    assert.equal(parseCommandLine("/var/folders/5n/2w.png"), undefined, "路径粘贴不算命令");
    assert.equal(parseCommandLine("/Volumes/work/x"), undefined, "大写开头是路径");
    assert.equal(parseCommandLine("普通输入"), undefined);
  });

  it("firstUserPreview：跳过 skill 注入，取首条普通用户消息前 72 字", () => {
    const lines = [
      SKILL_INJECT_LINE,
      JSON.stringify({ type: "message", timestamp: 1, message: { role: "user", content: [{ type: "text", text: "  第一条  真正的问题 " }] } }),
    ];
    assert.equal(firstUserPreview(lines), "第一条 真正的问题");
    assert.equal(firstUserPreview(["坏行"]), "");
  });
});

describe("originOf / parseTimestamp", () => {
  it("home agent/skills=user，.pi/skills=project，其余=builtin", () => {
    assert.equal(originOf(`${HOME}/agent/skills/dom/SKILL.md`, HOME), "user");
    assert.equal(originOf("/Volumes/work/demo/.pi/skills/local/SKILL.md", HOME), "project");
    assert.equal(originOf("/Volumes/work/hapilon/resources/skills/ask/SKILL.md", HOME), "builtin");
  });

  it("毫秒数字与 ISO 字符串都收，坏值 undefined", () => {
    assert.equal(parseTimestamp(1790733146806), 1790733146806);
    assert.equal(parseTimestamp("2026-09-30T01:12:21.950Z"), Date.parse("2026-09-30T01:12:21.950Z"));
    assert.equal(parseTimestamp("not-a-date"), undefined);
    assert.equal(parseTimestamp(undefined), undefined);
  });
});

describe("replaySession", () => {
  const meta = { session: "s1", project: "/Volumes/work/demo", home: HOME };

  it("explicit 与 model 都采集，噪声行不采集，事件带会话线索", () => {
    const events = replaySession(
      [SESSION_LINE, SKILL_INJECT_LINE, SKILL_INJECT_NO_ARGS_LINE, PLAIN_USER_LINE, READ_SKILL_LINE, BASH_MENTION_LINE, "坏行{{{", ""],
      meta,
    );
    assert.equal(events.length, 3, JSON.stringify(events, null, 1));
    assert.equal(events[0]!.sessionPreview, "普通问题，不是 skill 触发", "线索取自首条普通用户消息");

    const explicit = events[0]!;
    assert.equal(explicit.skill, "recon");
    assert.equal(explicit.source, "explicit");
    assert.equal(explicit.args, "看下这个扩展的结构");
    assert.equal(explicit.origin, "builtin");
    assert.equal(explicit.project, "/Volumes/work/demo");

    const noArgs = events[1]!;
    assert.equal(noArgs.skill, "snap");
    assert.equal(noArgs.origin, "user");
    assert.equal(noArgs.ts, 1790733146806, "毫秒时间戳直接采用");

    const model = events[2]!;
    assert.equal(model.skill, "dom");
    assert.equal(model.source, "model");
    assert.equal(model.args, "");
  });

  it("无任何事件返回空数组", () => {
    assert.deepEqual(replaySession([PLAIN_USER_LINE], meta), []);
  });
});

describe("loadSkillUsage", () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "hpl-metrics-usage-"));

  it("跨 home 重放；recap 无内置排除，与其他 skill 同流", async () => {
    const home = join(homeRoot, ".hapilon-dev");
    const sessionDir = join(home, "agent", "sessions", "--work--");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "2026-09-30T01-00-00.jsonl"), [SESSION_LINE, SKILL_INJECT_LINE, PLAIN_USER_LINE, READ_SKILL_LINE].join("\n"));
    // 第二个 home：recap 注入，与其他 skill 同等采集
    const home2 = join(homeRoot, ".hapilon");
    const sessionDir2 = join(home2, "agent", "sessions", "--work--");
    mkdirSync(sessionDir2, { recursive: true });
    const recapInject = SKILL_INJECT_LINE
      .replace('\\"recon\\"', '\\"recap\\"')
      .replace("resources/skills/recon/SKILL.md", "resources/skills/recap/SKILL.md");
    writeFileSync(join(sessionDir2, "2026-09-30T02-00-00.jsonl"), [recapInject].join("\n"));

    const usage = loadSkillUsage({ homeDir: homeRoot });
    assert.equal(usage.events.length, 3, JSON.stringify(usage));
    assert.equal(usage.excludedEvents.length, 0, "内置排除名单为空");
    assert.equal(usage.events[0]!.skill, "recap", "同时间戳时按 home 字母序稳定排序");
    assert.equal(usage.events[1]!.skill, "recon");
    assert.equal(usage.events[2]!.skill, "dom");
    assert.ok(usage.events[0]!.ts <= usage.events[1]!.ts && usage.events[1]!.ts <= usage.events[2]!.ts, "按时间升序");
    assert.equal(usage.sessionPreviews["2026-09-30T01-00-00"], "普通问题，不是 skill 触发");
  });

  it("清理临时目录", () => rmSync(homeRoot, { recursive: true, force: true }));
});
