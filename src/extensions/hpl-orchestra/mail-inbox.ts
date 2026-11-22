/**
 * mail-inbox.ts — 信箱接收侧：pane 进程内 2s 定时 drain 自己的信箱，
 * 经 pi.sendUserMessage 投递。busy 时 pi 自动排队、回合结束自动送达，
 * 全程不碰输入框，与人打键不冲突。
 */
import { existsSync } from "node:fs";
import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";
import { hostAddress } from "./host.js";
import { allInstances, findTeamStateForPane, instanceStoreKey, isTeamOwner, readTeamState, teamsDir, type TeamState } from "./state.js";
import { clearMail, drainMail, MailError, type MailMessage } from "./mail.js";

const DRAIN_INTERVAL_MS = 2000;
let drainTimer: ReturnType<typeof setInterval> | undefined;
let drainInFlight = false;

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

const deliverMail = (
  pi: ExtensionAPI,
  state: TeamState,
) =>
(msg: MailMessage): Effect.Effect<boolean, MailError> =>
  Effect.try({
    try: () => {
      const report = msg.reportPath ? `（报告：${msg.reportPath}）` : "";
      pi.sendUserMessage(`[${senderLabel(state, msg.from)} ${msg.from}] ${msg.text}${report}`);
      return true;
    },
    catch: (error) => new MailError({ message: `投递信件 ${msg.id} 失败：${String(error)}` }),
  });

function drainOnce(pi: ExtensionAPI): void {
  if (drainInFlight) return;
  const own = ownMailbox();
  if (!own) return;
  drainInFlight = true;
  const result = Effect.runSync(
    Effect.either(drainMail(own.storeKey, own.paneId, deliverMail(pi, own.state))),
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
export function startMailInbox(pi: ExtensionAPI): void {
  discardStaleMail();
  if (drainTimer) return;
  drainTimer = setInterval(() => drainOnce(pi), DRAIN_INTERVAL_MS);
  drainTimer.unref?.();
}

export function stopMailInbox(): void {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = undefined;
}
