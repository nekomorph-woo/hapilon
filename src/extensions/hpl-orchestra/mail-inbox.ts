/**
 * mail-inbox.ts — 信箱接收侧：pane 进程内 2s 定时 drain 自己的信箱，
 * 经 pi.sendUserMessage 投递。只在会话空闲时投：忙时信件留在文件里等下一个 tick。
 * 全程不碰输入框，与人打键不冲突。
 */
import { existsSync } from "node:fs";
import { Effect } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";
import { hostAddress } from "./host.js";
import { allInstances, findTeamStateForPane, instanceStoreKey, isTeamOwner, readTeamState, teamsDir, type TeamState } from "./state.js";
import { clearMail, drainMail, MailError, type MailMessage } from "./mail.js";

const DRAIN_INTERVAL_MS = 2000;
let drainTimer: ReturnType<typeof setInterval> | undefined;
let drainInFlight = false;
/** 最近一次会话启动的 ctx：忙闲判断只能问它（ExtensionAPI 没有 idle 查询）。 */
let inboxCtx: ExtensionContext | undefined;

interface OwnMailbox {
  storeKey: string;
  paneId: string;
  state: TeamState;
}

/** 自己的信箱定位：owner 读自己宿主的状态文件，role 实例用落盘 key。非团队成员返回 undefined。 */
export function ownMailbox(): OwnMailbox | undefined {
  const paneId = hostAddress();
  if (!paneId || !existsSync(teamsDir())) return undefined;
  const own = readTeamState();
  if (own.enabled && isTeamOwner(own)) return { storeKey: paneId, paneId, state: own };
  const state = findTeamStateForPane(paneId);
  if (!state || !("roles" in state)) return undefined;
  const instance = allInstances(state).find((candidate) => candidate.paneId === paneId);
  return instance ? { storeKey: instanceStoreKey(instance), paneId, state } : undefined;
}

/** 发送方显示名：花名册昵称优先，owner 用自己的昵称，未知发送方退回 pane id。 */
export function senderLabel(state: TeamState, fromPaneId: string): string {
  const instance = allInstances(state).find((candidate) => candidate.paneId === fromPaneId);
  if (instance?.nickname) return instance.nickname;
  if (state.owner.paneId === fromPaneId) return state.owner.nickname ?? fromPaneId;
  return fromPaneId;
}

/** 单封信投递：忙时返回 false（排队重试），真正失败才是 MailError。 */
export const deliverMail = (
  pi: ExtensionAPI,
  state: TeamState,
  isIdle: () => boolean,
) =>
(msg: MailMessage): Effect.Effect<boolean, MailError> => {
  // 忙时返回 false 而不报错：drainMail 据此把剩余信件写回文件、下个 tick 重试。
  // 不能靠 sendUserMessage 的 rejection——ExtensionAPI 版本返回 void 并在 pi 内部
  // 自行 catch，流式期间抛的「Agent is already processing」根本到不了调用方。
  if (!isIdle()) return Effect.succeed(false);
  return Effect.try({
    try: () => {
      const report = msg.reportPath ? `（报告：${msg.reportPath}）` : "";
      // followUp 兜住 isIdle 与 pi 内部 isStreaming 检查之间的毫秒级窗口：那一瞬起跑的话
      // 无选项发送会抛错并被 pi 内部 catch 吞掉（信已标已送、实际丢失）；忙时进队由循环拉取永不 reject
      pi.sendUserMessage(`[${senderLabel(state, msg.from)} ${msg.from}] ${msg.text}${report}`, {
        deliverAs: "followUp",
      });
      return true;
    },
    catch: (error) => new MailError({ message: `投递信件 ${msg.id} 失败：${String(error)}` }),
  });
};

function drainOnce(pi: ExtensionAPI): void {
  if (drainInFlight) return;
  const own = ownMailbox();
  if (!own) return;
  const ctx = inboxCtx;
  // 拿不到 ctx 就不投：宁可让信留在文件里，也不拿「已送」赌一次必然失败的发送
  if (!ctx) return;
  drainInFlight = true;
  const result = Effect.runSync(
    Effect.either(drainMail(own.storeKey, own.paneId, deliverMail(pi, own.state, () => ctx.isIdle()))),
  );
  drainInFlight = false;
  if (result._tag === "Left") {
    notify(`[hpl-orchestra] 信箱 drain 失败：${result.left.message}`, "warning");
  }
}

/** 滞留即丢弃：每次会话启动清空自己的信箱（含 /new 与 clear 重建的会话），不做补投。 */
function discardStaleMail(): void {
  const own = ownMailbox();
  if (!own) return;
  const result = Effect.runSync(Effect.either(clearMail(own.storeKey, own.paneId)));
  if (result._tag === "Left") {
    notify(`[hpl-orchestra] 清空信箱失败：${result.left.message}`, "warning");
  }
}

/** 会话启动即起轮询；非团队 pane 每个 tick 只做一次目录存在性检查。 */
export function startMailInbox(pi: ExtensionAPI, ctx: ExtensionContext): void {
  inboxCtx = ctx;
  discardStaleMail();
  if (drainTimer) return;
  drainTimer = setInterval(() => drainOnce(pi), DRAIN_INTERVAL_MS);
  drainTimer.unref?.();
}

export function stopMailInbox(): void {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = undefined;
  inboxCtx = undefined;
}
