/**
 * hpl-safety-gate Auto 模式单测
 *
 * 覆盖：沙箱先行纯函数 / gateAuto 配置 / 模型判定（mock complete）/
 * 108 样本重放（/tmp/safety-replay.jsonl，缺失时降级内联样本）/
 * 兜底回落（超时/错误/非法 JSON）/ 审计字段。
 *
 * HAPILON_HOME 指向临时目录（before 内设置），隔离本机配置。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { classifyWithLabel } from "../../extensions/hpl-safety-gate/classifier.js";
import { checkSandboxWrite } from "../../extensions/hpl-safety-gate/sandbox-allow.js";
import {
  GATE_AUTO_DEFAULTS,
  GateAutoApiError,
  GateAutoInvalidOutput,
  GateAutoTimeout,
  judgeCommand,
  readGateAutoConfig,
  setGateAutoEnabled,
  type AutoJudgeDeps,
  type JudgeModelShape,
} from "../../extensions/hpl-safety-gate/auto-judge.js";
import gateExtension from "../../extensions/hpl-safety-gate/index.js";

const REPLAY_FILE = "/tmp/safety-replay.jsonl";
const SANDBOX_OPTS = { cwd: "/Volumes/Under_M2/morphiiouo/hapilon", home: "" };
const FAKE_MODEL = { provider: "zai", id: "glm-4.7" };

let testHome = "";

/** 沙箱判定快捷入口（home 由 before 注入） */
const sandbox = (cmd: string) => checkSandboxWrite(cmd, { ...SANDBOX_OPTS, home: testHome });

/** 构造扩展实例与工具调用上下文；complete 可注入 mock */
function setupExtension(options: {
  flag?: boolean;
  complete?: (model: unknown, request: unknown, opts: unknown) => Promise<unknown>;
  available?: Array<{ provider: string; id: string }>;
} = {}) {
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
  const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      handlers[event] = handler;
    },
    registerFlag: (_name: string, _options: unknown) => {},
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands[name] = options.handler;
    },
    getFlag: (name: string) => (name === "gate-auto" ? (options.flag ?? false) : undefined),
  };
  gateExtension(pi as never);
  // cwd 用无项目信任的临时目录：真实仓库的 .hapilon/config.local.json 有 git push* 信任，
  // 会抢在 Auto 之前短路 confirm 分支
  const notices: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI: false,
    cwd: testHome,
    ui: { notify: (message: string, type?: string) => { notices.push({ message, type }); } },
    modelRegistry: {
      getAvailable: () => options.available ?? [FAKE_MODEL],
      complete: options.complete ?? (() => Promise.reject(new Error("测试不应调模型"))),
    },
  };
  const call = (command: string) =>
    handlers["tool_call"]!({ type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command } }, ctx) as
      | Promise<{ block: boolean; reason: string } | undefined>;
  const runCommand = (name: string, args: string) => commands[name]!(args, ctx);
  return { handlers, commands, notices, call, runCommand };
}

const completeWith = (text: string) => () => Promise.resolve({ content: [{ type: "text", text }] });

/** 审计文件读取（env HAPILON_HOME → <home>/agent/gate-auto.jsonl） */
const auditPath = () => join(testHome, "agent", "gate-auto.jsonl");
const readAudit = () =>
  existsSync(auditPath())
    ? readFileSync(auditPath(), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

describe("hpl-safety-gate auto", () => {
  before(() => {
    testHome = mkdtempSync(join(tmpdir(), "gate-auto-test-"));
    process.env.HAPILON_HOME = testHome;
    mkdirSync(join(testHome, "agent"), { recursive: true });
    writeFileSync(
      join(testHome, "model-tiers-resolved.json"),
      JSON.stringify({
        opus: [],
        sonnet: [{ provider: "zai", id: "glm-5.3" }],
        haiku: [{ provider: "zai", id: "glm-4.7" }],
      }),
    );
    SANDBOX_OPTS.home = join(testHome, "hapilon-home");
  });

  after(() => {
    delete process.env.HAPILON_HOME;
    rmSync(testHome, { recursive: true, force: true });
  });

  describe("checkSandboxWrite()", () => {
    it("$SMOKE=$(mktemp -d) 赋值后 rm -rf \"$SMOKE\" → 放行", () => {
      const cmd = 'cd /repo && SMOKE=$(mktemp -d) && node -e "x" && rm -rf "$SMOKE"';
      assert.equal(sandbox(cmd).allowed, true);
    });

    it("直接 /tmp 目标 → 放行", () => {
      assert.equal(sandbox("rm -rf /tmp/build/cache").allowed, true);
    });

    it("plan-task 内 sed -i → 放行", () => {
      const cmd = `sed -i "" -e "s/a/b/" ${SANDBOX_OPTS.home}/plan-task/2026-09-19-slug/task-brief.md`;
      assert.equal(sandbox(cmd).allowed, true);
    });

    it("$HAPILON_HOME 下目标 → 放行", () => {
      assert.equal(sandbox("rm -rf $HAPILON_HOME/plan-task/x").allowed, true);
    });

    it("mktemp 带模板参数，模板在沙箱内 → 放行", () => {
      assert.equal(sandbox('F=$(mktemp -d /tmp/benchXXXX) && rm -rf "$F"').allowed, true);
    });

    it("mktemp 带越界模板 → 不放行", () => {
      assert.equal(sandbox('F=$(mktemp -d ~/evil) && rm -rf "$F"').allowed, false);
    });

    it("越界目标（~）→ 不放行", () => {
      assert.equal(sandbox("rm -rf ~/.ssh").allowed, false);
    });

    it("未知变量 → 不放行（宁停不错放）", () => {
      assert.equal(sandbox('rm -rf "$UNKNOWN_VAR"').allowed, false);
    });

    it("目标含命令替换 → 不放行", () => {
      assert.equal(sandbox("rm -rf $(cat /tmp/list)").allowed, false);
    });

    it("混合目标：rm 在沙箱 + 重定向越界 → 不放行", () => {
      assert.equal(sandbox("rm -rf /tmp/a && echo x > /etc/z").allowed, false);
    });

    it("`..` 越界（/tmp/a/../../etc）→ 不放行", () => {
      assert.equal(sandbox("rm -rf /tmp/a/../../etc").allowed, false);
    });

    it("无破坏性命令词（git push + /tmp 重定向）→ 不放行，交模型层", () => {
      assert.equal(sandbox("git push 2>&1 | tail -2 > /tmp/log").allowed, false);
    });

    it("纯赋值段不影响占位符与 bodies 对齐", () => {
      const cmd = 'A=$(echo hi) && B=$(mktemp -d) && rm -rf "$B"';
      assert.equal(sandbox(cmd).allowed, true);
    });

    // --- 评审 P1 对抗样本 ---

    it("P1-1 sed -i 多文件：中间目标越界 → 不放行（复现：只查段末会漏检）", () => {
      const check = sandbox("sed -i 's/^x//' /etc/hosts /tmp/a.txt");
      assert.equal(check.allowed, false);
      assert.ok(check.targets.some((t) => t.resolved === "/etc/hosts" && !t.sandboxed));
    });

    it("P1-1 sed -i 多文件全在沙箱内 → 维持放行", () => {
      assert.equal(sandbox("sed -i 's/^x//' /tmp/a.txt /tmp/b.txt").allowed, true);
    });

    it("P1-2 mktemp 变量拼接 .. 逃逸 → 不放行（复现：旧 .. 检查是死代码）", () => {
      assert.equal(sandbox('SMOKE=$(mktemp -d) && rm -rf "$SMOKE/../../etc"').allowed, false);
    });

    it("P1-2 mktemp 变量单层 .. → 不放行", () => {
      assert.equal(sandbox('SMOKE=$(mktemp -d) && rm -rf "$SMOKE/.."').allowed, false);
    });

    it("P1-2 mktemp 变量无 .. 子路径 → 维持放行", () => {
      assert.equal(sandbox('SMOKE=$(mktemp -d) && rm -rf "$SMOKE/sub"').allowed, true);
    });

    it("P1-3 xargs 管道承接 rm：不放行且无目标（复现：stdin 注入操作数不可见）", () => {
      const check = sandbox("find ~ -name log | xargs rm -rf /tmp/x");
      assert.equal(check.allowed, false);
      assert.equal(check.targets.length, 0);
    });

    it("P1-3 前段沙箱内 rm + 管道尾段 xargs → 整条不放行", () => {
      assert.equal(sandbox("rm -rf /tmp/a && echo done | xargs rm -rf /etc").allowed, false);
    });

    it("P1-3 xargs 全路径 /usr/bin/xargs 拼写绕过 → 不放行", () => {
      assert.equal(sandbox("rm -rf /tmp/a && echo done | /usr/bin/xargs rm -rf /etc").allowed, false);
    });

    it("P1-3 单引号 'xargs' literal 拼写绕过 → 不放行", () => {
      assert.equal(sandbox("rm -rf /tmp/a && echo done | 'xargs' rm -rf /etc").allowed, false);
    });

    it("仲裁① mktemp 变量非开头拼接 /etc/$SMOKE → 不放行", () => {
      assert.equal(sandbox("SMOKE=$(mktemp -d) && rm -rf /etc/$SMOKE").allowed, false);
    });

    it("仲裁② 反斜杠转义 .. 段 /tmp/\\../etc → 解转义后落 /etc 不放行", () => {
      const check = sandbox("rm -rf /tmp/\\../etc");
      assert.equal(check.allowed, false);
      assert.ok(check.targets.some((t) => t.resolved === "/etc"));
    });

    it("仲裁② 正控 /tmp/\\$HOME 解转义为字面 $ 段 → 沙箱内放行", () => {
      assert.equal(sandbox("rm -rf /tmp/\\$HOME").allowed, true);
    });

    // --- cd 静态跟踪（相对目标按命令内的 cd 解析）---

    it("cd 到沙箱内后相对 rm 目标 → 放行", () => {
      assert.equal(sandbox("cd /tmp/w2p6 && rm -rf vout").allowed, true);
    });

    it("cd 沙箱内但 ../.. 越界 → 不放行", () => {
      const check = sandbox("cd /tmp/w2p6 && rm -rf ../../etc");
      assert.equal(check.allowed, false);
      assert.ok(check.targets.some((t) => t.resolved === "/etc"));
    });

    it("cd 到沙箱外的 home → 相对目标不放行（不放宽）", () => {
      assert.equal(sandbox("cd ~/evil && rm -rf x").allowed, false);
    });

    it("cd 目标含未知变量 → 相对目标不放行（fail-closed）", () => {
      const check = sandbox('cd "$UNKNOWN_CD_TARGET" && rm -rf x');
      assert.equal(check.allowed, false);
      assert.ok(check.targets.some((t) => !t.sandboxed));
    });

    it("cd 无破坏性命令词（仅重定向）→ 语义型仍不放行", () => {
      assert.equal(sandbox("cd /tmp && cat f > g").allowed, false);
    });

    it("cd 带前导赋值（CDPATH=…）仍识别 cd 命令词 → 放行", () => {
      assert.equal(sandbox("CDPATH=/nonexistent cd /tmp/x && rm -rf sub").allowed, true);
    });

    it("绝对路径目标不受 cd 影响 → 仍放行", () => {
      assert.equal(sandbox("cd /etc && rm -rf /tmp/abs").allowed, true);
    });

    it("cd - （OLDPWD 不可知）→ 相对目标不放行", () => {
      assert.equal(sandbox("cd - && rm -rf x").allowed, false);
    });

    // --- cd 跨分隔符传播（只有 && 下 cd 失败才阻断后续段；;/||/换行 下 cd 可能失败，| /& 下 cd 在子 shell）---

    it("cd 后接 ; → 后续相对目标不放行（cd 可能失败）", () => {
      assert.equal(sandbox("cd /tmp/w2p6; rm -rf vout").allowed, false);
    });

    it("cd 后接换行 → 后续相对目标不放行", () => {
      assert.equal(sandbox("cd /tmp/w2p6\nrm -rf vout").allowed, false);
    });

    it("cd 后接 || → 后续相对目标不放行（cd 失败才执行）", () => {
      assert.equal(sandbox("cd /tmp/w2p6 || rm -rf vout").allowed, false);
    });

    it("cd 后接 & → 后续相对目标不放行（cd 在后台子 shell，确定不传播）", () => {
      assert.equal(sandbox("cd /tmp/w2p6 & rm -rf vout").allowed, false);
    });

    it("cd 后接 | → 后续相对目标不放行（cd 在管道子 shell，确定不传播）", () => {
      assert.equal(sandbox("cd /tmp/w2p6 | rm -rf vout").allowed, false);
    });

    it("cd /tmp && cd /etc & rm out：& 递归整个 and_or，两段 cd 都不生效 → 不放行", () => {
      // 浅层回退只会回到 /tmp（沙箱内）→ 误放行；必须回退到 and_or 起点
      assert.equal(sandbox("cd /tmp && cd /etc & rm -rf out").allowed, false);
    });

    it("管道内的 cd 不生效（cd /tmp 已被前段 && 链条建立）→ 尾段仍按 /tmp 解析", () => {
      assert.equal(sandbox("cd /tmp && cat | cd /etc && rm -rf out").allowed, true);
    });

    it("子 shell 内的 cd 不跨出 → 括号后的相对目标不放行", () => {
      assert.equal(sandbox("( cd /tmp/w2p6 ) && rm -rf vout").allowed, false);
    });

    it("cd 经 && 进入子 shell 内仍生效 → 沙箱内相对目标放行", () => {
      assert.equal(sandbox("cd /tmp/w2p6 && ( rm -rf vout )").allowed, true);
    });

    // --- 去重 key 必须含生效 cwd / 变量状态（每次出现都解析）---

    it("跨段同名目标按各自 cwd 解析 → 第二个 out 解析为 /etc/out，不放行", () => {
      const check = sandbox("cd /tmp && rm -rf out && cd /etc && rm -rf out");
      assert.equal(check.allowed, false);
      assert.ok(check.targets.some((t) => t.resolved === "/tmp/out" && t.sandboxed));
      assert.ok(check.targets.some((t) => t.resolved === "/etc/out" && !t.sandboxed));
    });

    it("同名目标重复出现在同一 cwd → 去重后仍放行", () => {
      const check = sandbox("cd /tmp/w2p6 && rm -rf out out");
      assert.equal(check.allowed, true);
      assert.equal(check.targets.length, 1);
    });

    it("变量重赋值后同名目标按新值解析（基线同判）→ 不放行", () => {
      const check = sandbox("V=/tmp/w2p6 && rm -rf $V && V=/etc && rm -rf $V");
      assert.equal(check.allowed, false);
      assert.ok(check.targets.some((t) => t.resolved === "/etc" && !t.sandboxed));
    });

    it("变量重赋值但两次值均在沙箱内 → 放行", () => {
      assert.equal(sandbox("V=/tmp/a && rm -rf $V && V=/tmp/b && rm -rf $V").allowed, true);
    });
  });

  describe("readGateAutoConfig()", () => {
    it("无 settings.json → 默认关闭", () => {
      rmSync(join(testHome, "agent", "settings.json"), { force: true });
      assert.deepEqual(readGateAutoConfig(), GATE_AUTO_DEFAULTS);
      assert.equal(GATE_AUTO_DEFAULTS.enabled, false);
    });

    it("gateAuto 配置生效", () => {
      writeFileSync(
        join(testHome, "agent", "settings.json"),
        JSON.stringify({ gateAuto: { enabled: true, timeoutMs: 1234, model: "tier:sonnet" } }),
      );
      assert.deepEqual(readGateAutoConfig(), { enabled: true, timeoutMs: 1234, model: "tier:sonnet" });
    });

    it("非法字段逐项回落默认值", () => {
      writeFileSync(
        join(testHome, "agent", "settings.json"),
        JSON.stringify({ gateAuto: { enabled: "yes", timeoutMs: -1, model: 42 } }),
      );
      assert.deepEqual(readGateAutoConfig(), GATE_AUTO_DEFAULTS);
    });

    after(() => rmSync(join(testHome, "agent", "settings.json"), { force: true }));
  });

  describe("judgeCommand()（mock complete）", () => {
    const deps = (over: Partial<AutoJudgeDeps<JudgeModelShape>> = {}): AutoJudgeDeps<JudgeModelShape> => ({
      modelSpec: "tier:haiku",
      timeoutMs: 500,
      command: "git push origin main",
      cwd: "/repo",
      available: [FAKE_MODEL],
      complete: completeWith('{"verdict":"allow","reason":"常规工作流"}'),
      ...over,
    });
    const run = (d: AutoJudgeDeps<JudgeModelShape>) => Effect.runPromise(Effect.either(judgeCommand(d)));

    it("判定 allow → Right 且带具体模型", async () => {
      const result = await run(deps());
      assert.equal(result._tag, "Right");
      if (result._tag === "Right") {
        assert.deepEqual(
          { verdict: result.right.verdict, reason: result.right.reason, model: result.right.model },
          { verdict: "allow", reason: "常规工作流", model: "zai/glm-4.7" },
        );
      }
    });

    it("围栏 JSON 也能解析", async () => {
      const result = await run(
        deps({ complete: completeWith('```json\n{"verdict":"block","reason":"删除生产数据"}\n```') }),
      );
      assert.equal(result._tag, "Right");
      if (result._tag === "Right") assert.equal(result.right.verdict, "block");
    });

    it("非法 JSON → GateAutoInvalidOutput", async () => {
      const result = await run(deps({ complete: completeWith("好的，我认为可以") }));
      assert.equal(result._tag, "Left");
      if (result._tag === "Left") assert.equal(result.left._tag, "GateAutoInvalidOutput");
    });

    it("verdict 越界值 → GateAutoInvalidOutput（schema 校验）", async () => {
      const result = await run(
        deps({ complete: completeWith('{"verdict":"maybe","reason":"嗯"}') }),
      );
      assert.equal(result._tag, "Left");
      if (result._tag === "Left") assert.equal(result.left._tag, "GateAutoInvalidOutput");
    });

    it("complete 拒绝 → GateAutoApiError", async () => {
      const result = await run(
        deps({ complete: () => Promise.reject(new Error("boom")) }),
      );
      assert.equal(result._tag, "Left");
      if (result._tag === "Left") assert.equal(result.left._tag, "GateAutoApiError");
    });

    it("超时 → GateAutoTimeout", async () => {
      const result = await run(
        deps({ timeoutMs: 30, complete: () => new Promise(() => {}) }),
      );
      assert.equal(result._tag, "Left");
      if (result._tag === "Left") assert.equal(result.left._tag, "GateAutoTimeout");
    });

    it("tier 指代解析不到可用模型 → GateAutoApiError", async () => {
      const result = await run(deps({ modelSpec: "tier:opus" }));
      assert.equal(result._tag, "Left");
      if (result._tag === "Left") assert.equal(result.left._tag, "GateAutoApiError");
    });

    it("glob 模型指代直接匹配可用列表", async () => {
      const result = await run(deps({ modelSpec: "zai/*" }));
      assert.equal(result._tag, "Right");
      if (result._tag === "Right") assert.equal(result.right.model, "zai/glm-4.7");
    });
  });

  describe("108 样本重放", () => {
    it("allow 直通不触发 Auto；confirm 中 2 条沙箱先行、3 条进模型层且审计齐全", async () => {
      const replay = existsSync(REPLAY_FILE)
        ? readFileSync(REPLAY_FILE, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
      if (replay.length === 0) {
        console.warn(`[skip] ${REPLAY_FILE} 不存在，重放降级为内联样本`);
        assert.equal(sandbox('SMOKE=$(mktemp -d) && rm -rf "$SMOKE"').allowed, true);
        assert.equal(sandbox("git push 2>&1 | tail -2").allowed, false);
        return;
      }
      assert.equal(replay.length, 108);

      rmSync(auditPath(), { force: true });
      let modelCalls = 0;
      const { call } = setupExtension({
        flag: true,
        complete: () => {
          modelCalls++;
          return Promise.resolve({ content: [{ type: "text", text: '{"verdict":"allow","reason":"常规工作流"}' }] });
        },
      });

      let sandboxAllowed = 0;
      let modelLayer = 0;
      for (const sample of replay) {
        const { verdict } = classifyWithLabel(sample.cmd);
        // ① 现行分类器与调研重放一致（allow 直通、Auto 不触发）
        assert.equal(verdict, sample.now, `重放不一致: ${sample.cmd.slice(0, 60)}`);
        if (sample.now !== "confirm") continue;
        // ② confirm 级：沙箱先行或进模型层
        if (sandbox(sample.cmd).allowed) {
          sandboxAllowed++;
          assert.equal(await call(sample.cmd), undefined, "沙箱放行应直接通行");
        } else {
          modelLayer++;
          assert.equal(await call(sample.cmd), undefined, "模型 allow 后应放行");
        }
      }

      assert.equal(sandboxAllowed, 2, "mktemp 沙箱先行应恰好 2 条");
      assert.equal(modelLayer, 3, "进模型层应恰好 3 条");
      assert.equal(modelCalls, 3, "模型调用应恰好 3 次（沙箱/缓存命中不调模型）");

      // ③ 审计字段齐全：3 条模型 auto-allow + 2 条沙箱 auto-allow
      const entries = readAudit();
      const audited = entries.filter((e) => e.outcome === "auto-allow");
      assert.equal(audited.length, 5);
      for (const e of audited) {
        for (const field of ["ts", "cwd", "command", "layer", "verdict", "reason", "model", "outcome"]) {
          assert.ok(e[field] !== undefined, `审计缺字段 ${field}`);
        }
        assert.equal(e.verdict, "allow");
        assert.ok(e.layer === "sandbox" || e.layer === "model");
      }
      const modelEntries = audited.filter((e) => e.layer === "model");
      assert.equal(modelEntries.length, 3);
      assert.ok(modelEntries.every((e) => typeof e.latencyMs === "number" && e.model === "zai/glm-4.7"));
    });
  });

  describe("handler 级兜底与缓存（无 UI 上下文）", () => {
    it("默认关闭：confirm 命令无 UI 时维持硬阻止", async () => {
      const { call } = setupExtension({ flag: false });
      const result = await call("git push origin main");
      assert.ok(result?.block);
      assert.match(result.reason, /非交互模式/);
    });

    it("模型 block → 回落硬阻止 + 审计 fallback-block", async () => {
      rmSync(auditPath(), { force: true });
      const { call } = setupExtension({
        flag: true,
        complete: completeWith('{"verdict":"block","reason":"影响面越出仓库"}'),
      });
      const result = await call("git push origin main");
      assert.ok(result?.block);
      const entries = readAudit();
      const last = entries[entries.length - 1];
      assert.equal(last.outcome, "fallback-block");
      assert.equal(last.verdict, "block");
      assert.equal(last.layer, "model");
      assert.match(last.reason, /影响面越出仓库/);
    });

    it("模型 unsure → 回落硬阻止 + 审计 fallback-block", async () => {
      rmSync(auditPath(), { force: true });
      const { call } = setupExtension({
        flag: true,
        complete: completeWith('{"verdict":"unsure","reason":"拿不准"}'),
      });
      const result = await call("git push origin main");
      assert.ok(result?.block);
      const last = readAudit().at(-1);
      assert.equal(last.outcome, "fallback-block");
      assert.equal(last.verdict, "unsure");
    });

    it("模型超时 → 回落硬阻止 + 审计 fallback-block（reason 含超时）", async () => {
      rmSync(auditPath(), { force: true });
      const { call } = setupExtension({
        flag: true,
        complete: () => new Promise(() => {}),
      });
      // settings 未写 gateAuto → 默认 timeoutMs=30000；此用例显式走短超时配置
      writeFileSync(
        join(testHome, "agent", "settings.json"),
        JSON.stringify({ gateAuto: { enabled: true, timeoutMs: 30 } }),
      );
      try {
        const result = await call("git push origin main");
        assert.ok(result?.block);
        const last = readAudit().at(-1);
        assert.equal(last.outcome, "fallback-block");
        assert.equal(last.verdict, "unsure");
        assert.match(last.reason, /超时/);
      } finally {
        rmSync(join(testHome, "agent", "settings.json"), { force: true });
      }
    });

    it("会话内缓存：同命令第二次不再调模型，审计 layer=cache", async () => {
      rmSync(auditPath(), { force: true });
      let calls = 0;
      const { call } = setupExtension({
        flag: true,
        complete: () => {
          calls++;
          return Promise.resolve({ content: [{ type: "text", text: '{"verdict":"allow","reason":"常规"}' }] });
        },
      });
      assert.equal(await call("git push origin main"), undefined);
      assert.equal(await call("git push origin main"), undefined);
      assert.equal(calls, 1, "第二次应命中缓存不调模型");
      const cacheEntries = readAudit().filter((e) => e.layer === "cache");
      assert.equal(cacheEntries.length, 1);
      assert.equal(cacheEntries[0].outcome, "auto-allow");
    });

    it("settings enabled（无 flag）同样开启 Auto", async () => {
      writeFileSync(join(testHome, "agent", "settings.json"), JSON.stringify({ gateAuto: { enabled: true } }));
      try {
        const { call } = setupExtension({
          flag: false,
          complete: completeWith('{"verdict":"allow","reason":"常规工作流"}'),
        });
        assert.equal(await call("git push origin main"), undefined);
      } finally {
        rmSync(join(testHome, "agent", "settings.json"), { force: true });
      }
    });
  });

  describe("/gate-auto-mode 命令", () => {
    const settingsPath = () => join(testHome, "agent", "settings.json");
    const readSettingsRaw = () => readFileSync(settingsPath(), "utf8");
    const writeSettingsRaw = (value: string) => writeFileSync(settingsPath(), value, "utf8");

    before(() => rmSync(settingsPath(), { force: true }));
    after(() => rmSync(settingsPath(), { force: true }));

    it("on：merge 写入只改 gateAuto.enabled，settings 其他键与 gateAuto 其他字段保留", async () => {
      writeSettingsRaw(JSON.stringify({
        quietStartup: true,
        theme: "dark",
        gateAuto: { enabled: false, timeoutMs: 1234, model: "tier:sonnet" },
      }));
      const { runCommand, notices } = setupExtension({ flag: false });
      await runCommand("gate-auto-mode", "on");

      const raw = readSettingsRaw();
      assert.ok(raw.endsWith("\n"), "写入应补结尾换行");
      assert.match(raw, /\n  "quietStartup"/, "写入应为 2 空格缩进");
      assert.deepEqual(JSON.parse(raw), {
        quietStartup: true,
        theme: "dark",
        gateAuto: { enabled: true, timeoutMs: 1234, model: "tier:sonnet" },
      });
      assert.match(notices.at(-1)!.message, /已开启/);
      assert.equal(notices.at(-1)!.type, "info");
    });

    it("off：写回 false 且保留其余配置", async () => {
      const { runCommand } = setupExtension({ flag: false });
      await runCommand("gate-auto-mode", "off");
      assert.deepEqual(JSON.parse(readSettingsRaw()), {
        quietStartup: true,
        theme: "dark",
        gateAuto: { enabled: false, timeoutMs: 1234, model: "tier:sonnet" },
      });
    });

    it("无 settings.json 时 on：新建文件只含 gateAuto.enabled", async () => {
      rmSync(settingsPath(), { force: true });
      const { runCommand } = setupExtension({ flag: false });
      await runCommand("gate-auto-mode", "on");
      assert.deepEqual(JSON.parse(readSettingsRaw()), { gateAuto: { enabled: true } });
    });

    it("on 后本会话立即生效：后续 confirm 命令不再回落硬阻止（且缓存已清）", async () => {
      rmSync(settingsPath(), { force: true });
      rmSync(auditPath(), { force: true });
      let calls = 0;
      const { call, runCommand } = setupExtension({
        flag: false,
        complete: () => {
          calls++;
          return Promise.resolve({ content: [{ type: "text", text: '{"verdict":"block","reason":"越界"}' }] });
        },
      });
      // 开之前：Auto 未生效，confirm 级在无 UI 下硬阻止且不调模型
      assert.ok((await call("git push origin main"))?.block);
      assert.equal(calls, 0);

      await runCommand("gate-auto-mode", "on");
      assert.deepEqual(JSON.parse(readSettingsRaw()), { gateAuto: { enabled: true } });

      // 开之后：进入模型层（说明内存开关生效）
      const result = await call("git push origin main");
      assert.ok(result?.block);
      assert.equal(calls, 1);
      assert.equal(readAudit().at(-1)!.outcome, "fallback-block");

      // verdictCache 已清：off 后再 on，同命令仍重新调模型（而不是命中缓存）
      await runCommand("gate-auto-mode", "off");
      assert.ok((await call("git push origin main"))?.block);
      assert.equal(calls, 1, "off 后 Auto 不生效，不调模型");
      await runCommand("gate-auto-mode", "on");
      await call("git push origin main");
      assert.equal(calls, 2, "on 清空缓存后应重新调模型");
    });

    it("状态行：分别列出 settings 值、本会话实际生效值、模型/超时、缓存条数", async () => {
      writeSettingsRaw(JSON.stringify({ gateAuto: { enabled: false, timeoutMs: 5000, model: "tier:haiku" } }));
      const { call, runCommand, notices } = setupExtension({
        flag: true, // flag 覆盖：settings 关闭但本会话生效
        complete: completeWith('{"verdict":"allow","reason":"常规"}'),
      });
      await call("git push origin main");
      await runCommand("gate-auto-mode", "");
      const message = notices.at(-1)!.message;
      assert.match(message, /settings\.json gateAuto\.enabled：关闭/);
      assert.match(message, /本会话实际生效：开启（--gate-auto flag 强制开启）/);
      assert.match(message, /判定模型：tier:haiku，超时 5000ms/);
      assert.match(message, /会话判定缓存：1 条/);
    });

    it("非法参数：只回一行 usage，不写文件", async () => {
      writeSettingsRaw(JSON.stringify({ gateAuto: { enabled: false } }));
      const before = readSettingsRaw();
      const { runCommand, notices } = setupExtension({ flag: false });
      for (const bad of ["yes", "ON", "on extra"]) {
        await runCommand("gate-auto-mode", bad);
        assert.match(notices.at(-1)!.message, /^用法：\/gate-auto-mode \[on\|off\]/);
        assert.equal(notices.at(-1)!.type, "error");
      }
      assert.equal(readSettingsRaw(), before);
    });

    it("settings.json 损坏：跳过写入、原文件不动，但本会话仍生效", async () => {
      const broken = '{ "gateAuto": { enabled: tr';
      writeSettingsRaw(broken);
      const { call, runCommand, notices } = setupExtension({
        flag: false,
        complete: completeWith('{"verdict":"allow","reason":"常规"}'),
      });
      await runCommand("gate-auto-mode", "on");
      assert.equal(readSettingsRaw(), broken, "解析失败绝不能清空用户配置");
      assert.match(notices.at(-1)!.message, /仅本会话生效/);
      assert.match(notices.at(-1)!.message, /settings\.json 写入失败/);
      assert.equal(notices.at(-1)!.type, "warning");
      // 内存已改：Auto 本会话生效
      assert.equal(await call("git push origin main"), undefined);
    });

    it("顶层非对象：跳过写入、原文件不动", () => {
      const arrayish = JSON.stringify([1, 2, 3]);
      writeSettingsRaw(arrayish);
      assert.equal(setGateAutoEnabled(true), false);
      assert.equal(readSettingsRaw(), arrayish);
    });

    it("off 时 flag 仍强制开启：回执提示需重启会话", async () => {
      rmSync(settingsPath(), { force: true });
      const { runCommand, notices } = setupExtension({ flag: true });
      await runCommand("gate-auto-mode", "off");
      assert.match(notices.at(-1)!.message, /--gate-auto/);
      assert.deepEqual(JSON.parse(readSettingsRaw()), { gateAuto: { enabled: false } });
    });
  });
});
