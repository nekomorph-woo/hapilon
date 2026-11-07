/**
 * hpl-find-session — 自然语言找回历史会话（浮层临时多轮小对话）
 *
 *   /find-session — 打开浮层面板，经 RPC 子进程（hapi/p--mode rpc --no-session）
 *   以 haiku 档模型做多轮检索对话；子进程只加载专用只读会话工具与目标提示词，
 *   无 shell/写入/联网，无查找记录落盘。用户确认候选后由本扩展（父侧）
 *   ctx.switchSession 热切换，子模型没有任何切换权限。
 *
 * 旧实现（本地摘要索引 + SQLite 锁 + 固定预筛排序）已整体移除；磁盘缓存
 * 文件的清理由人工执行（见 README）。
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Data, Effect } from "effect";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { hapilonHome } from "../../config/hapilon-home.js";
import { resolvePiCliEffect } from "../../providers/pi-cli-path.js";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";
import { pickTierModel } from "../../cli/tier-model-arg.js";
import { describeCause, GOAL_PROMPT, FindSessionRpc, RpcSessionError, type VerifiedResult } from "./rpc-session.js";
import { SessionChatPane } from "./pane.js";
import { SessionStore } from "./session-store.js";

/** 恢复切换链路（waitForIdle/switchSession）的 typed error */
class SwitchSessionError extends Data.TaggedError("SwitchSessionError")<{ message: string }> {}

interface FindSessionInstance {
  rpc: FindSessionRpc;
  store: SessionStore;
}

export default function hplFindSession(pi: ExtensionAPI): void {
  // 同时只允许一个面板/子进程；session_shutdown 兜底清理
  let active: FindSessionInstance | undefined;
  let shutdownRequested = false;

  /**
   * 释放一个实例：active 所有权比较（迟到的旧实例清理不得误清新实例的登记），
   * stop 以 typed error 上报，绝不静默。
   */
  const release = async (instance: FindSessionInstance, report: (message: string) => void): Promise<void> => {
    if (active === instance) active = undefined;
    try {
      await Effect.runPromise(instance.rpc.stop());
    } catch (error) {
      report(describeRpcError(error, instance.rpc));
    }
  };

  pi.on("session_shutdown", (_event, ctx) => {
    shutdownRequested = true;
    const current = active;
    if (!current) return;
    void release(current, (message) => ctx.ui.notify(`找回会话子进程退出异常：${message}`, "error"));
  });

  pi.registerCommand("find-session", {
    description: "Find a past session by chatting with a dedicated read-only subagent (floating pane)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify("/find-session 需要 TUI 环境；非交互场景请用 hapi -r", "warning");
        return;
      }
      if (active) {
        ctx.ui.notify("找回会话面板已打开。", "warning");
        return;
      }
      const model = pickTierModel(Effect.runSync(readResolvedTiersEffect), "haiku", 0);
      if (!model) {
        ctx.ui.notify("haiku 档没有可用模型（检查 model-tiers 配置），未启动检索。", "error");
        return;
      }
      const cliPath = Effect.runSync(Effect.either(resolvePiCliEffect));
      if (cliPath._tag === "Left") {
        ctx.ui.notify(`找不到 pi CLI：${cliPath.left.message}`, "error");
        return;
      }
      const sessionsRoot = join(hapilonHome(), "agent", "sessions");
      const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
      const store = new SessionStore(sessionsRoot);

      let paneRef: SessionChatPane | undefined;
      const rpc = new FindSessionRpc({
        cliPath: cliPath.right,
        workerPath,
        sessionsRoot,
        model: { provider: model.provider, id: model.id, ...(model.thinking ? { thinking: model.thinking } : {}) },
        systemPrompt: GOAL_PROMPT,
        callbacks: {
          onUserAccepted: (text) => paneRef?.onUserAccepted(text),
          onAssistantDelta: (delta) => paneRef?.onAssistantDelta(delta),
          onAssistantFinal: (text) => paneRef?.onAssistantFinal(text),
          onToolStart: (name, label) => paneRef?.onToolStart(name, label),
          onToolEnd: (name, isError) => paneRef?.onToolEnd(name, isError),
          onSettled: (aborted) => paneRef?.onSettled(aborted),
          onError: (message) => paneRef?.onError(message),
          onResults: (results) => paneRef?.onResults(results),
          onQueued: (count) => paneRef?.onQueued(count),
        },
      });
      const instance: FindSessionInstance = { rpc, store };
      active = instance;

      const reportToCtx = (message: string): void => ctx.ui.notify(`找回会话子进程退出异常：${message}`, "error");

      const started = await Effect.runPromise(Effect.either(rpc.start()));
      if (started._tag === "Left") {
        await release(instance, reportToCtx);
        ctx.ui.notify(describeRpcError(started.left, rpc), "error");
        return;
      }

      // 恢复不在此刻执行：面板已自关，等 overlay 收尾（子进程确认停止）后统一切换
      let pendingPick: VerifiedResult | undefined;

      const performSwitch = async (picked: VerifiedResult): Promise<void> => {
        // 父侧二次核验 id：文件可在对话期间变化；核验不过绝不切换
        const check = await Effect.runPromise(Effect.either(store.read(picked.path)));
        if (check._tag === "Left" || check.right.header.id !== picked.sessionId) {
          ctx.ui.notify(`恢复被拒绝：${picked.path} 的会话 id 与结果不符（可能已变化）。`, "error");
          return;
        }
        const switched = await Effect.runPromise(Effect.either(Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => ctx.waitForIdle(),
            catch: (cause) => new SwitchSessionError({ message: `等待会话空闲失败：${describeCause(cause)}` }),
          });
          return yield* Effect.tryPromise({
            try: () => ctx.switchSession(picked.path, {
              withSession: async (next) => {
                next.ui.notify(`已切换会话：${picked.sessionId.slice(0, 8)}`, "info");
              },
            }),
            catch: (cause) => new SwitchSessionError({ message: `切换会话失败：${describeCause(cause)}` }),
          });
        })));
        if (switched._tag === "Left") {
          ctx.ui.notify(`切换失败：${switched.left.message}`, "error");
          return;
        }
        // 切换被取消时未发生替换，旧 ctx 仍有效（与 hpl-orchestra/menu.ts 同语义）
        if (switched.right.cancelled) ctx.ui.notify("切换会话被取消。", "warning");
      };

      try {
        await ctx.ui.custom(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tui: any, theme: Theme, kb: unknown, done: (result?: unknown) => void) => {
            paneRef = new SessionChatPane(tui, theme, kb, done, {
              onSend: (text) => {
                void Effect.runPromise(Effect.either(rpc.send(text))).then((either) => {
                  if (either._tag === "Left") paneRef?.onError(describeRpcError(either.left, rpc));
                });
              },
              onAbort: () => {
                void Effect.runPromise(Effect.either(rpc.abort())).then((either) => {
                  if (either._tag === "Left") paneRef?.onError(describeRpcError(either.left, rpc));
                });
              },
              onPick: (picked) => { pendingPick = picked; },
            });
            return paneRef;
          },
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: "92%", maxHeight: "80%" },
          },
        );
      } finally {
        // overlay 完成即统一释放：杀子进程、还原 stderr，之后才允许恢复切换
        await release(instance, reportToCtx);
      }
      if (pendingPick && !shutdownRequested) await performSwitch(pendingPick);
    },
  });
}

function describeRpcError(error: unknown, rpc: FindSessionRpc): string {
  const message = error instanceof RpcSessionError ? error.message : String(error);
  const dump = rpc.stderrDump.trim();
  return dump ? `${message}\n子进程 stderr：${dump.slice(-400)}` : message;
}
