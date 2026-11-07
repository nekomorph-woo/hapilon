import { it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit } from "effect";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { FindSessionRpc, GOAL_PROMPT, type RpcCallbacks, type RpcClientLike } from "../../extensions/hpl-find-session/rpc-session.js";

/** 假 RPC 客户端：记录调用、由测试注入事件 */
class FakeClient implements RpcClientLike {
  prompts: Array<{ message: string; behavior?: string }> = [];
  aborted = false;
  stopped = false;
  thinkingLevels: string[] = [];
  hangStart = false;
  hangPrompt = false;
  failStop: string | null = null;
  failThinkingLevel: string | null = null;
  private listeners: Array<(event: JsonAgentSessionEvent) => void> = [];
  private failNextPrompt: string | null = null;
  private startGate: (() => void) | null = null;
  disposition = "started";

  async start(): Promise<void> {
    if (this.hangStart) {
      await new Promise<void>((resolve) => { this.startGate = resolve; });
    }
  }

  /** 释放 hangStart 阻塞的 start() */
  releaseStart(): void { this.startGate?.(); }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.failStop) throw new Error(this.failStop);
  }

  async abort(): Promise<void> { this.aborted = true; }

  async setThinkingLevel(level: string): Promise<void> {
    if (this.failThinkingLevel) throw new Error(this.failThinkingLevel);
    this.thinkingLevels.push(level);
  }

  stderrText = "";
  getStderr(): string { return this.stderrText; }

  onEvent(listener: (event: JsonAgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  async prompt(message: string, _images?: unknown, streamingBehavior?: "steer" | "followUp"): Promise<string> {
    if (this.failNextPrompt) {
      const error = this.failNextPrompt;
      this.failNextPrompt = null;
      throw new Error(error);
    }
    if (this.hangPrompt) return new Promise<string>(() => {});
    this.prompts.push({ message, behavior: streamingBehavior });
    return this.disposition;
  }
  emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(event as JsonAgentSessionEvent);
  }
  failNextPromptWith(message: string): void { this.failNextPrompt = message; }
}

const recorder = () => {
  const log: string[] = [];
  const callbacks: RpcCallbacks = {
    onUserAccepted: (text) => log.push(`user:${text}`),
    onAssistantDelta: (delta) => log.push(`delta:${delta}`),
    onAssistantFinal: (text) => log.push(`final:${text}`),
    onToolStart: (name, label) => log.push(`tool-start:${name}:${label}`),
    onToolEnd: (name, isError) => log.push(`tool-end:${name}:${isError}`),
    onSettled: (aborted) => log.push(`settled:${aborted}`),
    onError: (message) => log.push(`error:${message}`),
    onResults: (results) => log.push(`results:${results.length}`),
    onQueued: (count) => log.push(`queued:${count}`),
  };
  return { log, callbacks };
};

const toolEnd = (details: unknown): Record<string, unknown> => ({
  type: "tool_execution_end", toolName: "find_session_result", isError: false,
  result: { content: [{ type: "text", text: "ok" }], details },
});

it("多轮对话：第二轮继续复用同一子进程，事件按序投递", async () => {
  const client = new FakeClient();
  const { log, callbacks } = recorder();
  const rpc = new FindSessionRpc({ cliPath: "x", workerPath: "w", sessionsRoot: "/r", model: { provider: "p", id: "m" }, systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client });
  await Effect.runPromise(rpc.start());
  await Effect.runPromise(rpc.send("找发版讨论"));
  assert.deepEqual(client.prompts, [{ message: "找发版讨论", behavior: undefined }]);
  assert.deepEqual(log, ["user:找发版讨论"]);
  client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "正在" } });
  client.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "正在搜索" }] } });
  client.emit({ type: "tool_execution_start", toolName: "session_search", args: { keyword: "发版" } });
  client.emit({ type: "tool_execution_end", toolName: "session_search", isError: false, result: { details: {} } });
  client.emit({ type: "agent_settled", aborted: false });
  assert.ok(log.includes("delta:正在"));
  assert.ok(log.includes("final:正在搜索"));
  assert.ok(log.includes("tool-start:session_search:keyword=发版"));
  assert.ok(log.includes("tool-end:session_search:false"));
  assert.ok(log.includes("settled:false"));
  // 第二轮：settled 后 busy=false，裸 prompt 不带 streamingBehavior
  await Effect.runPromise(rpc.send("再找子代理相关的"));
  assert.equal(client.prompts.length, 2);
  assert.equal(client.prompts[1]?.behavior, undefined);
  assert.ok(log.includes("user:再找子代理相关的"));
  await Effect.runPromise(rpc.stop());
});

it("运行中发送按 followUp 排队；handled 无运行直接 settle；错误保留不冒充无匹配", async () => {
  const client = new FakeClient();
  const { log, callbacks } = recorder();
  const rpc = new FindSessionRpc({ cliPath: "x", workerPath: "w", sessionsRoot: "/r", model: { provider: "p", id: "m" }, systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client });
  await Effect.runPromise(rpc.start());
  await Effect.runPromise(rpc.send("第一轮"));
  client.emit({ type: "agent_start" }); // 保持 busy（尚未 settled）
  await Effect.runPromise(rpc.send("追问"));
  assert.deepEqual(client.prompts[1], { message: "追问", behavior: "followUp" });
  assert.ok(log.includes("queued:1"));
  // handled：扩展命令之类无运行
  client.disposition = "handled";
  client.emit({ type: "agent_settled", aborted: false });
  await Effect.runPromise(rpc.send("/fsx-selfcheck"));
  assert.ok(log.includes("settled:false"));
  // prompt 失败 → typed error，错误进面板不吞
  client.disposition = "started";
  client.failNextPromptWith("provider down");
  const failed = await Effect.runPromiseExit(rpc.send("会失败"));
  assert.ok(Exit.isFailure(failed));
  const cause = Exit.isFailure(failed) ? failed.cause : undefined;
  assert.ok(JSON.stringify(cause).includes("发送失败"));
  assert.ok(JSON.stringify(cause).includes("provider down"));
  await Effect.runPromise(rpc.stop());
});

it("tool_execution_end 提取结构化结果；坏载荷报错误；abort 后 settled 标记可继续", async () => {
  const client = new FakeClient();
  const { log, callbacks } = recorder();
  const rpc = new FindSessionRpc({ cliPath: "x", workerPath: "w", sessionsRoot: "/r", model: { provider: "p", id: "m" }, systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client });
  await Effect.runPromise(rpc.start());
  const good = { findSessionResults: [{ sessionId: "s", path: "/r/p/a.jsonl", summary: "总结", reason: "匹配", evidence: [{ line: 2, messageId: "m1", quote: "原文" }] }] };
  client.emit(toolEnd(good));
  assert.ok(log.includes("results:1"));
  client.emit(toolEnd({ findSessionResults: "坏的" }));
  assert.ok(log.some((entry) => entry.startsWith("error:结果载荷格式异常")));
  await Effect.runPromise(rpc.send("x"));
  await Effect.runPromise(rpc.abort());
  assert.equal(client.aborted, true);
  client.emit({ type: "agent_settled", aborted: true });
  assert.ok(log.includes("settled:true"));
  await Effect.runPromise(rpc.stop());
});

it("关闭后迟到事件不投递；父 stderr 在 start/send/stop 前后不被替换，子 stderr 供面板显示", async () => {
  const originalWrite = process.stderr.write;
  const client = new FakeClient();
  client.stderrText = "worker boom";
  const { log, callbacks } = recorder();
  const rpc = new FindSessionRpc({ cliPath: "x", workerPath: "w", sessionsRoot: "/r", model: { provider: "p", id: "m" }, systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client });
  await Effect.runPromise(rpc.start());
  assert.equal(process.stderr.write, originalWrite, "start 后父 stderr 未被替换");
  assert.ok(rpc.stderrDump.includes("worker boom"), "子进程 stderr 经 getStderr 供面板显示");
  await Effect.runPromise(rpc.send("找发版讨论"));
  assert.equal(process.stderr.write, originalWrite, "send 后父 stderr 未被替换");
  await Effect.runPromise(rpc.stop());
  assert.equal(process.stderr.write, originalWrite, "stop 后父 stderr 未被替换");
  assert.ok(rpc.stderrDump.includes("worker boom"), "stop 后快照仍供面板报错文案读取");
  assert.equal(client.stopped, true);
  client.emit(toolEnd({ findSessionResults: [] }));
  assert.deepEqual(log, ["user:找发版讨论"], "关闭后迟到回调不投递");
  const sendAfterStop = await Effect.runPromiseExit(rpc.send("迟到"));
  assert.ok(Exit.isFailure(sendAfterStop));
});

it("thinking 档位 start 后经 setThinkingLevel 下发；未配置不下发；下发失败 typed", async () => {
  const client = new FakeClient();
  const { callbacks } = recorder();
  const rpc = new FindSessionRpc({
    cliPath: "x", workerPath: "w", sessionsRoot: "/r",
    model: { provider: "p", id: "m", thinking: "low" },
    systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client,
  });
  await Effect.runPromise(rpc.start());
  assert.deepEqual(client.thinkingLevels, ["low"]);
  await Effect.runPromise(rpc.stop());

  const plain = new FakeClient();
  const plainRpc = new FindSessionRpc({
    cliPath: "x", workerPath: "w", sessionsRoot: "/r",
    model: { provider: "p", id: "m" },
    systemPrompt: GOAL_PROMPT, callbacks, createClient: () => plain,
  });
  await Effect.runPromise(plainRpc.start());
  assert.deepEqual(plain.thinkingLevels, []);
  await Effect.runPromise(plainRpc.stop());

  const broken = new FakeClient();
  broken.failThinkingLevel = "level unsupported";
  const brokenRpc = new FindSessionRpc({
    cliPath: "x", workerPath: "w", sessionsRoot: "/r",
    model: { provider: "p", id: "m", thinking: "max" },
    systemPrompt: GOAL_PROMPT, callbacks, createClient: () => broken,
  });
  const failed = await Effect.runPromiseExit(brokenRpc.start());
  assert.ok(Exit.isFailure(failed));
  assert.ok(JSON.stringify(failed).includes("设置 thinking 级别失败"));
  assert.ok(JSON.stringify(failed).includes("level unsupported"));
});

it("启动失败：typed error、杀进程清理、父 stderr 不被替换、事件退订", async () => {
  const originalWrite = process.stderr.write;
  const client = new FakeClient();
  const { log, callbacks } = recorder();
  const rpc = new FindSessionRpc({
    cliPath: "x", workerPath: "w", sessionsRoot: "/r",
    model: { provider: "p", id: "m" },
    systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client,
  });
  // 让 client.start 抛错
  (client as unknown as { start: () => Promise<void> }).start = async () => {
    throw new Error("spawn failed");
  };
  const failed = await Effect.runPromiseExit(rpc.start());
  assert.ok(Exit.isFailure(failed));
  assert.ok(JSON.stringify(failed).includes("找回会话子进程启动失败"));
  assert.ok(JSON.stringify(failed).includes("spawn failed"));
  assert.equal(process.stderr.write, originalWrite, "启动失败后父 stderr 未被替换");
  assert.equal(client.stopped, true, "启动失败后已调 client.stop 清理");
  client.emit({ type: "agent_settled", aborted: false });
  assert.deepEqual(log, [], "启动失败后迟到事件不投递");
  const after = await Effect.runPromiseExit(rpc.send("x"));
  assert.ok(Exit.isFailure(after));
});

it("启动期间被 stop：start 以 typed error 结束、杀进程、父 stderr 全程不被替换", async () => {
  const originalWrite = process.stderr.write;
  const client = new FakeClient();
  const { log, callbacks } = recorder();
  const rpc = new FindSessionRpc({
    cliPath: "x", workerPath: "w", sessionsRoot: "/r",
    model: { provider: "p", id: "m" },
    systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client,
  });
  client.hangStart = true;
  const startPromise = Effect.runPromiseExit(rpc.start());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(process.stderr.write, originalWrite, "启动期间父 stderr 未被替换");
  const stopExit = await Effect.runPromiseExit(rpc.stop());
  assert.ok(Exit.isSuccess(stopExit));
  client.releaseStart();
  const startExit = await startPromise;
  assert.ok(Exit.isFailure(startExit));
  assert.ok(JSON.stringify(startExit).includes("子进程已关闭"));
  assert.equal(process.stderr.write, originalWrite, "stop 后父 stderr 未被替换");
  assert.equal(client.stopped, true);
  client.emit({ type: "agent_settled", aborted: false });
  assert.deepEqual(log, [], "迟到事件不投递");
});

it("在途 send 被 stop 取消：不再悬挂、无迟到回调", async () => {
  const client = new FakeClient();
  const { log, callbacks } = recorder();
  const rpc = new FindSessionRpc({
    cliPath: "x", workerPath: "w", sessionsRoot: "/r",
    model: { provider: "p", id: "m" },
    systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client,
  });
  await Effect.runPromise(rpc.start());
  client.hangPrompt = true;
  // timeout 兜底：若关闭信号失效，send 永不结束，这里以超时失败暴露而不是吊死整个测试进程
  const sendExit = Effect.runPromiseExit(rpc.send("会悬挂").pipe(Effect.timeout("3 seconds")));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stopExit = await Effect.runPromiseExit(rpc.stop());
  assert.ok(Exit.isSuccess(stopExit), "stop 不被在途 send 阻塞");
  const settled = await sendExit;
  assert.ok(Exit.isFailure(settled));
  assert.ok(JSON.stringify(settled).includes("子进程已关闭"));
  assert.ok(!log.some((entry) => entry.startsWith("user:")), "被取消的 send 不投递 user 回调");
  assert.equal(client.stopped, true);
});

it("退出报错：stop 以 typed error 上报，但本地回收（stderr 还原/退订）已完成", async () => {
  const originalWrite = process.stderr.write;
  const client = new FakeClient();
  const { log, callbacks } = recorder();
  const rpc = new FindSessionRpc({
    cliPath: "x", workerPath: "w", sessionsRoot: "/r",
    model: { provider: "p", id: "m" },
    systemPrompt: GOAL_PROMPT, callbacks, createClient: () => client,
  });
  await Effect.runPromise(rpc.start());
  client.failStop = "kill failed";
  const stopExit = await Effect.runPromiseExit(rpc.stop());
  assert.ok(Exit.isFailure(stopExit), "退出失败不吞");
  assert.ok(JSON.stringify(stopExit).includes("子进程退出失败"));
  assert.ok(JSON.stringify(stopExit).includes("kill failed"));
  assert.equal(process.stderr.write, originalWrite, "本地回收先于退出 await 完成（父 stderr 始终未被替换）");
  client.emit({ type: "agent_settled", aborted: false });
  assert.deepEqual(log, [], "退出报错后迟到事件不投递");
});
