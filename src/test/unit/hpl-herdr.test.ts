import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_AGENT,
  HERDR_SOURCE,
  blockMessage,
  createHerdrReporter,
  releaseAgentArgs,
  reportAgentArgs,
  reporterEnabled,
} from "../../extensions/hpl-herdr/report.js";
import { createTabNamer, pickNamingTier, qualifyingTaskInput, sanitizeTitle } from "../../extensions/hpl-herdr/tab-name.js";
import { generateTabName, registerHerdrReporting } from "../../extensions/hpl-herdr/index.js";
import { createHerdrState } from "../../extensions/hpl-herdr/state.js";
import {
  createOscReporter,
  oscEnabled,
  programStatusSequence,
} from "../../extensions/hpl-herdr/osc.js";
import { resetNotifySink, setNotifySink } from "../../extensions/notify.js";

/** 命名计时器桩：断掉真实 3 分钟 setTimeout，防 suite 悬挂与假 ctx 误触 */
const noTimer = {
  namingSchedule: () => ({}) as ReturnType<typeof setTimeout>,
  namingCancel: () => {},
};

/** 记录 spawn 调用的假 SpawnFn */
function makeSpawn(result: { error?: Error; status?: number; stderr?: string } = {}) {
  const calls: Array<{ file: string; args: string[] }> = [];
  return {
    calls,
    spawn: (file: string, args: string[]) => {
      calls.push({ file, args });
      const status = result.status ?? (result.error ? 1 : 0);
      return { status, error: result.error, stderr: result.stderr };
    },
  };
}

/** 可控时钟：显式推进毫秒，避免测试依赖真实时间 */
const CLOCK_START = 1_700_000_000_000;
function makeClock(start = CLOCK_START) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function seqs(calls: Array<{ args: string[] }>): number[] {
  return calls.map((c) => Number(c.args[c.args.indexOf("--seq") + 1]));
}

const ENV = { herdrEnv: "1", binPath: "/opt/herdr/bin/herdr", paneId: "w1:p7" };

describe("sanitizeTitle()", () => {
	it("取首个非空行", () => {
		assert.equal(sanitizeTitle("  \n修 issue#75 的 tab 命名\n第二行", 24), "修 issue#75 的 tab 命名");
	});
	it("剥 markdown 前缀与行内标记，压空白", () => {
		assert.equal(sanitizeTitle("## **修 bug** `v1`", 24), "修 bug v1");
		assert.equal(sanitizeTitle("## a   b", 24), "a b");
	});
	it("剥 herdr-core 来源包裹（hc send 语义）", () => {
		assert.equal(sanitizeTitle('<hc from="t3t">帮我确认 package.json</hc>', 24), "帮我确认 package.json");
		assert.equal(sanitizeTitle('<hc from="t3t">\n第二行', 24), "第二行");
	});
	it("默认截到 6 字符且按码点切，不劈 emoji", () => {
		assert.equal(sanitizeTitle("x".repeat(30))!.length, 6);
		assert.equal([...sanitizeTitle("🎉".repeat(30))!].length, 6);
	});
	it("截断落在英文单词中间时丢残词，结果不短于 2 字", () => {
		assert.equal(sanitizeTitle("帮我确认 package.json 里的 name"), "帮我确认");
		assert.equal(sanitizeTitle("修 bug 的按钮位置"), "修 bug");
	});
	it("空内容 undefined", () => {
		assert.equal(sanitizeTitle("   \n  "), undefined);
	});
});

describe("qualifyingTaskInput()", () => {
	it("只认交互式、非排队、非命令的输入", () => {
		assert.equal(qualifyingTaskInput("修个 bug", "interactive", undefined), true);
		assert.equal(qualifyingTaskInput("继续", "rpc", undefined), false);
		assert.equal(qualifyingTaskInput("补充一点", "interactive", "steer"), false);
		assert.equal(qualifyingTaskInput("/compact", "interactive", undefined), false);
		assert.equal(qualifyingTaskInput("!!ls", "interactive", undefined), false);
	});
});

describe("createTabNamer()", () => {
	/** fake session 名存内存，generate 可编程 */
	function harness({
		initialName = undefined as string | undefined,
		generate = undefined as ((texts: readonly string[]) => Promise<string | undefined>) | undefined,
	} = {}) {
		const state = { name: initialName, sets: [] as string[] };
		const genCalls: string[][] = [];
		const namer = createTabNamer({
			sessionName: {
				get: () => state.name,
				set: (n: string) => {
					state.sets.push(n);
					state.name = n;
				},
			},
			generate: async (texts) => {
				genCalls.push([...texts]);
				return generate ? generate(texts) : `生成名${genCalls.length}`;
			},
		});
		return { state, namer, genCalls };
	}

	it("时机 1：会话首条输入生成并改名，之后不再生成", async () => {
		const { state, namer, genCalls } = harness();
		await namer.onUserInput("修 issue#75 的 tab 命名");
		await namer.onUserInput("换个写法继续");
		assert.deepEqual(genCalls, [["修 issue#75 的 tab 命名"]]);
		assert.deepEqual(state.sets, ["生成名1"]);
	});

	it("生成失败回落首行截断兜底", async () => {
		const { state, namer } = harness({ generate: async () => undefined });
		await namer.onUserInput("帮我确认 package.json 里的 name");
		assert.deepEqual(state.sets, ["帮我确认"]);
	});

	it("生成抛错同样走截断兜底", async () => {
		const { state, namer } = harness({ generate: async () => {
			throw new Error("子进程炸了");
		} });
		await namer.onUserInput("修 bug 的按钮位置");
		assert.deepEqual(state.sets, ["修 bug"]);
	});

	it("session 重置后恢复一次机会", async () => {
		const { state, namer, genCalls } = harness();
		await namer.onUserInput("任务一");
		namer.resetSession();
		await namer.onUserInput("任务二");
		assert.deepEqual(genCalls.map((c) => c[0]), ["任务一", "任务二"]);
		assert.deepEqual(state.sets, ["生成名1", "生成名2"]);
	});

	it("session 名被人工起过（≠我们的值）就永久收手", async () => {
		const { state, namer, genCalls } = harness({ initialName: "我手起的名" });
		await namer.onUserInput("任何任务");
		assert.deepEqual(state.sets, []);
		assert.deepEqual(genCalls, [["任何任务"]]);
		assert.equal(state.name, "我手起的名");
	});

	it("我们命名后被人工改掉，同样收手", async () => {
		const { state, namer } = harness();
		await namer.onUserInput("任务一");
		state.name = "人改的";
		await namer.onRecapFire();
		assert.deepEqual(state.sets, ["生成名1"]);
	});

	it("时机 2：用近期任务消息生成，人工收手后不再生成", async () => {
		const { state, namer, genCalls } = harness({ generate: async () => "命名新任务" });
		await namer.onUserInput("第一条任务");
		await namer.onUserInput("第二条任务");
		await namer.onUserInput("第三条任务");
		await namer.onUserInput("第四条任务");
		assert.deepEqual(state.sets, ["命名新任务"]);
		state.name = "人改的";
		await namer.onRecapFire();
		assert.deepEqual(state.sets, ["命名新任务"], "人工收手后时机 2 不覆盖");
		// 时机 2 输入是近期 ring（最多 3 条），不含已消费的首条
		assert.deepEqual(genCalls.at(-1), ["第二条任务", "第三条任务", "第四条任务"]);
	});

	it("resetSession 收编外部已有名为基线，后续改名视为一致", async () => {
		const { state, namer } = harness({ initialName: "已有名" });
		namer.resetSession();
		await namer.onUserInput("新任务");
		assert.deepEqual(state.sets, ["生成名1"]);
	});
});

describe("pickNamingTier()", () => {
	it("haiku 优先非推理候选，haiku 空时降级 sonnet，两档全空 undefined", () => {
		const entry = (id: string, reasoning?: boolean) => ({ id, provider: "p", reasoning });
		assert.equal(pickNamingTier({ opus: [], sonnet: [], haiku: [entry("h1", true), entry("h2", false)] })?.id, "h2");
		assert.equal(pickNamingTier({ opus: [], sonnet: [entry("s1")], haiku: [] })?.id, "s1");
		assert.equal(pickNamingTier({ opus: [], sonnet: [], haiku: [] }), undefined);
	});
});

describe("generateTabName()", () => {
	const tierModel = { id: "haiku-test", provider: "test", input: ["text"] };

	/** 注册表桩：find 返回给定模型，complete 记录调用并返回给定正文（或抛错） */
	function fakeCtx(opts: { found?: unknown; model?: unknown; complete?: () => Promise<unknown> }) {
		const calls: Array<{ model: unknown; messages: Array<{ content: string }> }> = [];
		const ctx = {
			modelRegistry: {
				find: () => opts.found,
				complete: async (model: unknown, context: { messages: Array<{ content: string }> }) => {
					calls.push({ model, messages: context.messages });
					return opts.complete ? opts.complete() : { role: "assistant", content: [{ type: "text", text: "  修登录 bug \n" }] };
				},
			},
			model: opts.model,
		};
		return { ctx: ctx as never, calls };
	}

	it("经 modelRegistry.complete 发一条 user 消息，返回去空白的正文", async () => {
		const { ctx, calls } = fakeCtx({ found: tierModel });
		assert.equal(await generateTabName(ctx, ["帮我修登录 bug"]), "修登录 bug");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, tierModel);
		assert.match(calls[0].messages[0].content, /帮我修登录 bug/);
	});

	it("档位模型不在注册表时回落当前会话模型", async () => {
		const current = { id: "current" };
		const { ctx, calls } = fakeCtx({ found: undefined, model: current });
		await generateTabName(ctx, ["任务"]);
		assert.equal(calls[0].model, current);
	});

	it("请求失败：告警一次并返回 undefined（调用侧截断兜底）", async () => {
		const seen: Array<{ message: string; type: string }> = [];
		setNotifySink({ notify: (message, type) => seen.push({ message, type: type ?? "info" }) });
		try {
			const { ctx } = fakeCtx({ found: tierModel, complete: () => Promise.reject(new Error("ECONNREFUSED")) });
			assert.equal(await generateTabName(ctx, ["任务"]), undefined);
		} finally {
			resetNotifySink();
		}
		assert.deepEqual(seen.map((entry) => entry.type), ["warning"]);
		assert.match(seen[0].message, /ECONNREFUSED/);
	});
});

describe("registerHerdrReporting() tab 命名接线", () => {
	function fakePi() {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const events = new Map<string, (payload: unknown) => void>();
		const tools = new Map<string, { name: string }>();
		const state = { name: undefined as string | undefined };
		const pi = {
			on: (name: string, handler: (...args: never[]) => unknown) => {
				// 同名事件多 handler（如 session_start 上报重置+命名重置）依次调用，不互相覆盖
				const prev = handlers.get(name);
				handlers.set(name, prev ? ((...args: never[]) => { prev(...args); handler(...args); }) : handler);
			},
			events: { on: (name: string, handler: (payload: unknown) => void) => void events.set(name, handler) },
			registerTool: (tool: { name: string }) => void tools.set(tool.name, tool),
			getSessionName: () => state.name,
			setSessionName: (n: string) => void (state.name = n),
		};
		return { pi: pi as never, handlers, events, tools, state };
	}

	/** 上报全关（env 空）→ 只接命名机械；生成器与计时器注入，隔离子进程与真实时钟 */
	function namingOnly(pi: never, opts: { generate?: (texts: readonly string[]) => Promise<string | undefined> } = {}) {
		const genCalls: string[][] = [];
		let timerCb: (() => void) | undefined;
		registerHerdrReporting(pi, {
			spawn: (() => ({ status: 0 })) as never,
			env: { herdrEnv: undefined, binPath: undefined, paneId: undefined },
			namingTTY: true,
			generateNaming: async (texts) => {
				genCalls.push([...texts]);
				return opts.generate ? opts.generate(texts) : `生成名${genCalls.length}`;
			},
			namingSchedule: (cb: () => void) => {
				timerCb = cb;
				return {} as ReturnType<typeof setTimeout>;
			},
			namingCancel: () => {},
		});
		return { genCalls, fireTimer: () => timerCb?.() };
	}

	const idleCtx = { isIdle: () => true, hasPendingMessages: () => false };

	it("不注册任何工具；首条交互输入经注入生成器写 session 名", async () => {
		const { pi, handlers, tools, state } = fakePi();
		const { genCalls } = namingOnly(pi);
		assert.equal(tools.size, 0);
		handlers.get("input")!({
			text: "修 issue#75 的 tab 命名",
			source: "interactive",
			streamingBehavior: undefined,
		} as never);
		await Promise.resolve(); // 等命名 Promise 落地
		assert.equal(state.name, "生成名1");
		assert.deepEqual(genCalls, [["修 issue#75 的 tab 命名"]]);
	});

	it("命令、排队续跑不触发生成", async () => {
		const { pi, handlers, state } = fakePi();
		const { genCalls } = namingOnly(pi);
		handlers.get("input")!({ text: "/compact", source: "interactive", streamingBehavior: undefined } as never);
		handlers.get("input")!({ text: "排队任务", source: "interactive", streamingBehavior: "queued" } as never);
		await Promise.resolve();
		assert.deepEqual(genCalls, []);
		assert.equal(state.name, undefined);
	});

	it("时机 2：recap 计时器到点且 agent 空闲才生成；忙时不生成", async () => {
		const { pi, handlers, state } = fakePi();
		const { genCalls, fireTimer } = namingOnly(pi);
		handlers.get("session_start")!({} as never, idleCtx as never);
		fireTimer();
		assert.deepEqual(genCalls, [], "无任务消息时不生成");
		handlers.get("input")!({ text: "任务甲", source: "interactive", streamingBehavior: undefined } as never);
		await Promise.resolve();
		assert.equal(state.name, "生成名1", "时机 1 已命名");
		fireTimer();
		await Promise.resolve();
		assert.deepEqual(genCalls.length, 2, "空闲到点时机 2 生成");
		assert.equal(state.name, "生成名2");
	});

	it("时机 2：agent 忙（isIdle=false）不生成也不报错", async () => {
		const { pi, handlers, state } = fakePi();
		const { genCalls, fireTimer } = namingOnly(pi);
		handlers.get("session_start")!({} as never, { isIdle: () => false, hasPendingMessages: () => true } as never);
		handlers.get("input")!({ text: "任务甲", source: "interactive", streamingBehavior: undefined } as never);
		await Promise.resolve();
		fireTimer();
		assert.deepEqual(genCalls.length, 1, "只有时机 1 那次");
		assert.equal(state.name, "生成名1");
	});

	it("print/管道模式（namingTTY=false）命名整体不接——防 -p 子进程自嵌套", () => {
		const { pi, handlers } = fakePi();
		registerHerdrReporting(pi, {
			spawn: (() => ({ status: 0 })) as never,
			env: { herdrEnv: undefined, binPath: undefined, paneId: undefined },
			namingTTY: false,
		});
		// 上报全关 + 命名不激活：一个 handler 都不注册
		assert.equal(handlers.size, 0);
	});

	it("角色面板（HAPI_ORCH_ROLE）命名整体不接（含 input 的命名监听）", () => {
		const saved = process.env.HAPI_ORCH_ROLE;
		process.env.HAPI_ORCH_ROLE = "worker";
		try {
			const { pi, handlers } = fakePi();
			const { genCalls } = namingOnly(pi);
			// 上报也全关时连 handler 都不注册；有上报时 input 只剩上报自己的，命名不掺入
			assert.equal(handlers.get("session_start"), undefined);
			const inputHandler = handlers.get("input");
			if (inputHandler) inputHandler({ text: "任务", source: "interactive", streamingBehavior: undefined } as never);
			assert.deepEqual(genCalls, []);
		} finally {
			if (saved === undefined) delete process.env.HAPI_ORCH_ROLE;
			else process.env.HAPI_ORCH_ROLE = saved;
		}
	});
});

describe("reporterEnabled()", () => {
  it("herdr pane 内且信息齐全才启用", () => {
    assert.equal(reporterEnabled(ENV), true);
  });
  it("缺任一条件即 no-op", () => {
    assert.equal(reporterEnabled({ ...ENV, herdrEnv: undefined }), false);
    assert.equal(reporterEnabled({ ...ENV, herdrEnv: "0" }), false);
    assert.equal(reporterEnabled({ ...ENV, binPath: undefined }), false);
    assert.equal(reporterEnabled({ ...ENV, paneId: undefined }), false);
  });
});

describe("reportAgentArgs()", () => {
  it("基本参数：source/agent/state/seq 齐全", () => {
    assert.deepEqual(reportAgentArgs("w1:p7", "working", 3), [
      "pane", "report-agent", "w1:p7",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--state", "working",
      "--seq", "3",
    ]);
  });
  it("message 与 session 路径附加", () => {
    assert.deepEqual(reportAgentArgs("w1:p7", "blocked", 4, { message: "select: 选哪个", sessionPath: "/x/s.jsonl" }), [
      "pane", "report-agent", "w1:p7",
      "--source", HERDR_SOURCE,
      "--agent", HERDR_AGENT,
      "--state", "blocked",
      "--seq", "4",
      "--message", "select: 选哪个",
      "--agent-session-path", "/x/s.jsonl",
    ]);
  });
  it("release 不带 seq（官方协议无该参数）", () => {
    assert.deepEqual(releaseAgentArgs("w1:p7"), [
      "pane", "release-agent", "w1:p7", "--source", HERDR_SOURCE, "--agent", HERDR_AGENT,
    ]);
  });
});

describe("blockMessage()", () => {
  it("标题优先，否则用 prompt 类型", () => {
    assert.equal(blockMessage({ kind: "confirm", title: "允许写入?" }), "confirm: 允许写入?");
    assert.equal(blockMessage({ kind: "select" }), "select");
    assert.equal(blockMessage({}), "prompt");
  });
});

describe("createHerdrReporter()", () => {
  it("非 herdr 环境严格 no-op（不 spawn）", () => {
    const { spawn, calls } = makeSpawn();
    const reporter = createHerdrReporter({ spawn, env: { ...ENV, herdrEnv: undefined } });
    assert.equal(reporter.enabled, false);
    reporter.report("working");
    reporter.release();
    assert.equal(calls.length, 0);
  });

  it("报告走 HERDR_BIN_PATH，seq 严格递增，release 收尾", () => {
    const { spawn, calls } = makeSpawn();
    const clock = makeClock();
    const reporter = createHerdrReporter({ spawn, env: ENV, now: clock.now });
    reporter.report("idle", { sessionPath: "/s.jsonl" });
    reporter.report("working");
    reporter.report("blocked", { message: "confirm" });
    reporter.report("idle");
    reporter.release();

    assert.equal(calls.length, 5);
    assert.ok(calls.every((c) => c.file === ENV.binPath));
    const reported = seqs(calls.slice(0, 4));
    assert.deepEqual(reported, [CLOCK_START, CLOCK_START + 1, CLOCK_START + 2, CLOCK_START + 3], "同毫秒内仍须严格递增");
    assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--state") + 1], "idle");
    assert.equal(calls[3]!.args[calls[3]!.args.indexOf("--state") + 1], "idle");
    assert.ok(calls[0]!.args.includes("--agent-session-path"));
    assert.equal(calls[4]!.args[1], "release-agent");
  });

  // 回归：herdr 按 (pane, source) 记住已接受的最大 seq，旧实例哑掉后新实例必须立刻大于它，
  // 否则 /new、收编、进程重启后的上报会被静默丢弃（wait-pane 假超时的根因）。
  it("跨实例追加重建后 seq 仍大于上一实例（/new、收编后不断链）", () => {
    const clock = makeClock();
    const first = makeSpawn();
    const firstReporter = createHerdrReporter({ spawn: first.spawn, env: ENV, now: clock.now });
    firstReporter.report("working");
    clock.advance(50);
    firstReporter.report("idle");
    const beforeRestart = seqs(first.calls).at(-1)!;

    clock.advance(1_000);
    const second = makeSpawn();
    const secondReporter = createHerdrReporter({ spawn: second.spawn, env: ENV, now: clock.now });
    secondReporter.report("idle", { sessionPath: "/new-session.jsonl" });

    assert.ok(seqs(second.calls)[0]! > beforeRestart, "新实例首个 seq 必须大于旧实例最后一个");
  });

  it("上报失败告警一次而非静默吞掉", () => {
    const { spawn } = makeSpawn({ error: new Error("herdr 不在 PATH") });
    const errors: string[] = [];
    const reporter = createHerdrReporter({ spawn, env: ENV, onError: (m) => errors.push(m) });
    reporter.report("working");
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.includes("herdr 不在 PATH"));
  });

  it("herdr 以非 0 拒绝且非 pane_not_found 时要告警（含 stderr 摘要）", () => {
    const { spawn } = makeSpawn({ status: 1, stderr: '{"error":{"code":"invalid_argument"}}\n' });
    const errors: string[] = [];
    const reporter = createHerdrReporter({ spawn, env: ENV, onError: (m) => errors.push(m) });
    reporter.report("working");
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.includes("invalid_argument"));
  });

  // 回归：herdr-app（GUI/hc core）注入 HERDR_* 但 pane 注册表不认这个 id（herdr-app#358），
  // CLI 通道每次上报都报 pane_not_found——首次拒绝后闭嘴并回调升级，让 OSC 通道顶上
  it("pane_not_found 拒绝时回调升级一次，后续不再 spawn", () => {
    const { spawn, calls } = makeSpawn({ status: 1, stderr: '{"error":{"code":"pane_not_found"}}\n' });
    const errors: string[] = [];
    let rejected = 0;
    const reporter = createHerdrReporter({
      spawn,
      env: ENV,
      onError: (m) => errors.push(m),
      onPaneNotFound: () => {
        rejected += 1;
      },
    });
    reporter.report("working");
    reporter.report("idle");
    reporter.release();
    assert.equal(rejected, 1);
    assert.equal(errors.length, 0);
    assert.equal(calls.length, 1);
  });
});

describe("createHerdrState() 状态合成", () => {
  it("回归：主循环 settle 后 subagent 在跑保持 working，最后一个结束才 idle", () => {
    const s = createHerdrState();
    assert.equal(s.turnStart()?.state, "working");
    s.subagentStarted("a1");
    // 旧代码此处直接报 idle——subagent 还在跑，必须保持 working 且不重复上报
    assert.equal(s.agentSettled(), undefined);
    assert.equal(s.subagentEnded("a1")?.state, "idle");
  });

  it("主循环早已 settle 时，后台派发直接拉回 working", () => {
    const s = createHerdrState();
    assert.equal(s.subagentStarted("a1")?.state, "working");
  });

  it("blocked 优先，prompt 关闭后回到 subagent 撑住的 working", () => {
    const s = createHerdrState();
    s.subagentStarted("a1");
    const blocked = s.promptStart("confirm: 允许写入?");
    assert.equal(blocked?.state, "blocked");
    assert.equal(blocked?.message, "confirm: 允许写入?");
    assert.equal(s.promptEnd()?.state, "working");
    assert.equal(s.subagentEnded("a1")?.state, "idle");
  });

  it("同状态去重：连续起跑与多个 subagent 都不重复产出", () => {
    const s = createHerdrState();
    assert.ok(s.agentStart());
    assert.equal(s.turnStart(), undefined);
    assert.equal(s.subagentStarted("a1"), undefined);
    assert.equal(s.subagentStarted("a2"), undefined);
    s.agentSettled(); // 主循环结束，subagent 撑住 working
    // 并发收尾：最后一个结束才转 idle，先结束的不动
    assert.equal(s.subagentEnded("a1"), undefined);
    assert.equal(s.subagentEnded("a2")?.state, "idle");
  });

  it("failed 与 completed 同路：都解除在跑标记", () => {
    const s = createHerdrState();
    s.subagentStarted("a1");
    s.subagentStarted("a2");
    s.subagentEnded("a1");
    assert.equal(s.agentSettled(), undefined);
    assert.equal(s.subagentEnded("a2")?.state, "idle");
  });

  it("回归：主循环 settle 后 bg-task 在跑保持 working，任务结束才 idle", () => {
    const s = createHerdrState();
    assert.equal(s.turnStart()?.state, "working");
    s.bgStarted(1);
    // 旧代码此处直接报 idle——后台 shell 任务也在跑，必须保持 working
    assert.equal(s.agentSettled(), undefined);
    assert.equal(s.bgEnded(1)?.state, "idle");
  });

  it("bg-task 与 subagent 并发：两者都结束才 idle", () => {
    const s = createHerdrState();
    s.bgStarted(1);
    s.subagentStarted("a1");
    s.agentSettled();
    assert.equal(s.subagentEnded("a1"), undefined);
    assert.equal(s.bgEnded(1)?.state, "idle");
  });
});

describe("registerHerdrReporting() 接线", () => {
  function fakePi() {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const events = new Map<string, (payload: unknown) => void>();
    const tools = new Map<string, { name: string }>();
    const state = { name: undefined as string | undefined };
    const pi = {
      on: (name: string, handler: (...args: never[]) => unknown) => {
        // 同名事件多 handler（如 session_start 上报重置+命名重置）依次调用，不互相覆盖
        const prev = handlers.get(name);
        handlers.set(name, prev ? ((...args: never[]) => { prev(...args); handler(...args); }) : handler);
      },
      events: { on: (name: string, handler: (payload: unknown) => void) => void events.set(name, handler) },
      registerTool: (tool: { name: string }) => void tools.set(tool.name, tool),
      getSessionName: () => state.name,
      setSessionName: (n: string) => void (state.name = n),
    };
    return { pi: pi as never, handlers, events, tools, state };
  }

  const states = (calls: Array<{ args: string[] }>) =>
    calls.map((c) => c.args[c.args.indexOf("--state") + 1]);

  it("非 herdr 环境不上报；命名监听仍然注册（且不注册工具）", () => {
    const { spawn } = makeSpawn();
    const { pi, handlers, events, tools } = fakePi();
    registerHerdrReporting(pi, { spawn, env: { herdrEnv: undefined, binPath: undefined, paneId: undefined }, namingTTY: true, ...noTimer });
    assert.equal(events.size, 0);
    assert.equal(handlers.has("input"), true);
    assert.equal(handlers.has("session_start"), true);
    assert.equal(tools.size, 0);
  });

  it("回归：subagent 生命周期事件在主循环 settle 后撑住 working", () => {
    const { spawn, calls } = makeSpawn();
    const { pi, handlers, events } = fakePi();
    registerHerdrReporting(pi, { spawn, env: ENV, ...noTimer });
    handlers.get("turn_start")!();
    handlers.get("agent_settled")!(); // 无 subagent：沉淀即 idle
    (events.get("subagents:started")!)({ id: "a1" });
    handlers.get("agent_settled")!(); // subagent 在跑：不再报 idle
    (events.get("subagents:completed")!)({ id: "a1" });
    assert.deepEqual(states(calls), ["working", "idle", "working", "idle"]);
  });

  it("failed 同样解除在跑；blocked 事件流经状态机", () => {
    const { spawn, calls } = makeSpawn();
    const { pi, handlers, events } = fakePi();
    registerHerdrReporting(pi, { spawn, env: ENV, ...noTimer });
    (events.get("subagents:started")!)({ id: "a1" });
    (events.get("subagents:failed")!)({ id: "a1", status: "stopped" });
    assert.deepEqual(states(calls), ["working", "idle"]);
  });

  it("回归：bg-task 起止事件在主循环 settle 后撑住 working", () => {
    const { spawn, calls } = makeSpawn();
    const { pi, handlers, events } = fakePi();
    registerHerdrReporting(pi, { spawn, env: ENV, ...noTimer });
    handlers.get("turn_start")!();
    handlers.get("agent_settled")!(); // 无后台任务：沉淀即 idle
    (events.get("bg-jobs:started")!)({ id: 1 });
    handlers.get("agent_settled")!(); // 后台任务在跑：不再报 idle
    (events.get("bg-jobs:ended")!)({ id: 1 });
    assert.deepEqual(states(calls), ["working", "idle", "working", "idle"]);
  });

  it("session_start 重置状态机并带 session 路径", () => {
    const { spawn, calls } = makeSpawn();
    const { pi, handlers, events } = fakePi();
    registerHerdrReporting(pi, { spawn, env: ENV, ...noTimer });
    (events.get("subagents:started")!)({ id: "a1" });
    handlers.get("session_start")!({} as never, {
      sessionManager: { getSessionFile: () => "/s.jsonl" },
    } as never);
    const last = calls.at(-1)!;
    assert.equal(last.args[last.args.indexOf("--state") + 1], "idle");
    assert.ok(last.args.includes("--agent-session-path"));
    // 重置后旧的在跑标记不再撑状态
    handlers.get("agent_settled")!();
    assert.deepEqual(states(calls).slice(-2), ["idle", "idle"]);
  });
});

describe("oscEnabled()", () => {
  const BARE = { herdrEnv: undefined, binPath: undefined, paneId: undefined };
  it("有 TTY 且 CLI 通道未激活才启用", () => {
    assert.equal(oscEnabled(BARE, true), true);
    assert.equal(oscEnabled(ENV, true), false); // herdr-tui CLI 通道在场，让路
    assert.equal(oscEnabled(BARE, false), false);
    assert.equal(oscEnabled(BARE, undefined), false);
  });
});

describe("programStatusSequence()", () => {
  it("app=hapilon，working 不带 msg", () => {
    assert.equal(programStatusSequence("working"), "\x1b]7501;state=working:app=hapilon\x1b\\");
  });
  it("blocked 的说明文本编码为 base64 msg", () => {
    const b64 = Buffer.from("select: 选哪个", "utf8").toString("base64");
    assert.equal(
      programStatusSequence("blocked", "select: 选哪个"),
      `\x1b]7501;state=blocked:app=hapilon:msg=${b64}\x1b\\`,
    );
  });
});

describe("createOscReporter()", () => {
  const BARE = { herdrEnv: undefined, binPath: undefined, paneId: undefined };
  it("无 TTY 严格 no-op（不写任何序列）", () => {
    const writes: string[] = [];
    const reporter = createOscReporter({ env: BARE, isTTY: false, write: (s) => writes.push(s) });
    reporter.report("working");
    reporter.release();
    assert.deepEqual(writes, []);
  });
  it("报告写 pty，release 收尾写 state=clear", () => {
    const writes: string[] = [];
    const reporter = createOscReporter({ env: BARE, isTTY: true, write: (s) => writes.push(s) });
    reporter.report("idle");
    reporter.report("blocked", { message: "权限确认" });
    reporter.release();
    assert.deepEqual(writes, [
      "\x1b]7501;state=idle:app=hapilon\x1b\\",
      `\x1b]7501;state=blocked:app=hapilon:msg=${Buffer.from("权限确认", "utf8").toString("base64")}\x1b\\`,
      "\x1b]7501;state=clear\x1b\\",
    ]);
  });

  // 回归：herdr-app GUI 注入 HERDR_*（静态不激活）但 CLI 被 pane_not_found 拒，
  // escalate 翻转后 OSC 顶上；非 TTY 时即使 escalate 也不写（盲写会污染管道输出）
  it("escalate 翻转后激活；无 TTY 时 escalate 也不激活", () => {
    const writes: string[] = [];
    const escalate = { value: false };
    const reporter = createOscReporter({ env: ENV, isTTY: true, write: (s) => writes.push(s), escalate });
    assert.equal(reporter.enabled, false);
    reporter.report("working");
    assert.deepEqual(writes, [], "静态未激活且未升级时不写");
    escalate.value = true;
    reporter.report("working");
    reporter.release();
    assert.deepEqual(writes, ["\x1b]7501;state=working:app=hapilon\x1b\\", "\x1b]7501;state=clear\x1b\\"]);
    const piped: string[] = [];
    const noTty = createOscReporter({ env: ENV, isTTY: false, write: (s) => piped.push(s), escalate });
    noTty.report("idle");
    assert.deepEqual(piped, []);
  });
});

describe("registerHerdrReporting() OSC 通道接线", () => {
  function fakePi() {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const events = new Map<string, (payload: unknown) => void>();
    const pi = {
      on: (name: string, handler: (...args: never[]) => unknown) => {
        // 同名事件多 handler（如 session_start 上报重置+命名重置）依次调用，不互相覆盖
        const prev = handlers.get(name);
        handlers.set(name, prev ? ((...args: never[]) => { prev(...args); handler(...args); }) : handler);
      },
      events: { on: (name: string, handler: (payload: unknown) => void) => void events.set(name, handler) },
      registerTool: () => {},
      getSessionName: () => undefined,
      setSessionName: () => {},
    };
    return { pi: pi as never, handlers, events };
  }

  it("非 herdr 环境 + TTY：走 OSC 上报，subagent 撑住 working", () => {
    const writes: string[] = [];
    const { pi, handlers, events } = fakePi();
    registerHerdrReporting(pi, {
      spawn: makeSpawn().spawn,
      env: { herdrEnv: undefined, binPath: undefined, paneId: undefined },
      osc: { isTTY: true, write: (s) => writes.push(s) },
    });
    handlers.get("turn_start")!();
    handlers.get("agent_settled")!();
    (events.get("subagents:started")!)({ id: "a1" });
    handlers.get("agent_settled")!();
    assert.deepEqual(writes, [
      "\x1b]7501;state=working:app=hapilon\x1b\\",
      "\x1b]7501;state=idle:app=hapilon\x1b\\",
      "\x1b]7501;state=working:app=hapilon\x1b\\",
    ]);
  });

  it("herdr-tui 环境 + TTY：CLI 通道独占，OSC 不写", () => {
    const writes: string[] = [];
    const { spawn, calls } = makeSpawn();
    const { pi, handlers } = fakePi();
    registerHerdrReporting(pi, { spawn, env: ENV, osc: { isTTY: true, write: (s) => writes.push(s) }, ...noTimer });
    handlers.get("turn_start")!();
    assert.deepEqual(writes, []);
    assert.equal(calls.length, 1);
  });

  // 回归（用户报障场景）：herdr-app GUI 注入 HERDR_*，CLI 每次 pane_not_found，
  // agents 列表永不出现 hapi。首次拒绝后 escalate：CLI 停 spawn，OSC 接管上报
  it("herdr-app GUI 场景：CLI 被 pane_not_found 拒后 OSC 接管", () => {
    const writes: string[] = [];
    const { spawn, calls } = makeSpawn({ status: 1, stderr: '{"error":{"code":"pane_not_found"}}\n' });
    const { pi, handlers } = fakePi();
    registerHerdrReporting(pi, { spawn, env: ENV, osc: { isTTY: true, write: (s) => writes.push(s) }, ...noTimer });
    handlers.get("turn_start")!();
    assert.equal(calls.length, 1);
    // cli.report 同步被拒、escalate 翻转，同一 report 轮内轮到 osc 时已激活——首次状态就落到 OSC
    assert.deepEqual(writes, ["\x1b]7501;state=working:app=hapilon\x1b\\"]);
    handlers.get("agent_settled")!();
    handlers.get("turn_start")!();
    assert.equal(calls.length, 1, "升级后 CLI 不再 spawn");
    assert.deepEqual(writes, [
      "\x1b]7501;state=working:app=hapilon\x1b\\",
      "\x1b]7501;state=idle:app=hapilon\x1b\\",
      "\x1b]7501;state=working:app=hapilon\x1b\\",
    ]);
  });

  it("session_shutdown 走 OSC 时写 state=clear", () => {
    const writes: string[] = [];
    const { pi, handlers } = fakePi();
    registerHerdrReporting(pi, {
      spawn: makeSpawn().spawn,
      env: { herdrEnv: undefined, binPath: undefined, paneId: undefined },
      osc: { isTTY: true, write: (s) => writes.push(s) },
    });
    handlers.get("session_shutdown")!();
    assert.deepEqual(writes, ["\x1b]7501;state=clear\x1b\\"]);
  });
});
