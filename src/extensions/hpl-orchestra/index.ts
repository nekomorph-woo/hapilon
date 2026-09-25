import { Effect } from "effect";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assistantMessageText,
  completePendingRole,
  getPendingRoleWizard,
  handlePendingUserMessage,
  handleTeamCommand,
  updateTeamStatus,
} from "./menu.js";
import { herdrEnvAvailable } from "./herdr.js";
import { discardPendingThinkingSwitch, recordModelSwitch, recordOwnCompletedTasks, recordThinkingSwitch, writeBackPaneModel } from "./adaptive-facts.js";
import { buildTeamSectionsEffect } from "./state.js";
import { setTeamSections } from "./bridge.js";
import { parseRoleDefSentinel } from "./role-wizard.js";

/** system-prompt 组装方只消费 setStatus 能力——收窄参数面 */
type StatusOnlyContext = { ui: { setStatus: (key: string, text: string | undefined) => void } };

interface BeforeAgentStartContext {
  ui: { setStatus: (key: string, text: string | undefined) => void };
  hasUI?: boolean;
  mode?: string;
}

type PaneThinking = NonNullable<ExtensionContext["thinkingLevel"]>;

/**
 * 程序化恢复期间抑制偏好事报。pi 的 setModel 无论 persist 与否都会发 model_select
 * （agent-session.js：_emitModelSelect 在 persist 判断之外），setThinkingLevel 变更时
 * 同样发 thinking_level_select——不抑制就会把恢复记成用户偏好、也会再触发一次写回。
 */
let suppressingRestore = false;

/** `/new` 前记下的用户选择；进程内 /new 不跨进程，模块级即可 */
let savedPanePreference: { provider: string; id: string; thinking?: PaneThinking } | undefined;

export default function hplOrchestra(pi: ExtensionAPI): void {
  pi.registerCommand("team", {
    description: "Manage the herdr three-pane team",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!herdrEnvAvailable()) {
        ctx.ui.notify("/team 仅能在 herdr 面板环境中使用。", "error");
        return;
      }
      await handleTeamCommand(pi, args, ctx);
    },
  });

  pi.registerCommand("team:open", {
    description: "Open (or revive) a role pane at its default tier, no dialogs",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!herdrEnvAvailable()) {
        ctx.ui.notify("/team:open 仅能在 herdr 面板环境中使用。", "error");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const key = parts[0];
      if (!key) {
        ctx.ui.notify("用法：/team:open <角色 key> [模型]（模型如 tier:sonnet[1] 或 provider/id:high）", "error");
        return;
      }
      // 不弹档位：主 agent 自己开面板时没人应答弹窗，一律用角色默认档；
      // 带模型参数时是用户点名，作为最高优先覆盖交给选模。
      const explicitModel = parts.slice(1).join(" ");
      await handleTeamCommand(pi, `打开角色 ${key}${explicitModel ? ` ${explicitModel}` : ""}`, ctx);
    },
  });

  pi.registerCommand("team:kick", {
    description: "Kick a role pane out of the team (role key or pane id), no dialogs",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!herdrEnvAvailable()) {
        ctx.ui.notify("/team:kick 仅能在 herdr 面板环境中使用。", "error");
        return;
      }
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("用法：/team:kick <角色 key | pane id>", "error");
        return;
      }
      await handleTeamCommand(pi, `踢出角色 ${target}`, ctx);
    },
  });

  pi.registerCommand("team:clear", {
    description: "Clear a role pane's context, no dialogs (role key or pane id)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!herdrEnvAvailable()) {
        ctx.ui.notify("/team:clear 仅能在 herdr 面板环境中使用。", "error");
        return;
      }
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("用法：/team:clear <角色 key | pane id>", "error");
        return;
      }
      const result = await handleTeamCommand(pi, `清空角色 ${target}`, ctx);
      // 拒绝原因必须进模型上下文：命令回执只到 UI，owner 看不到自己刚被拒了
      if (result && !result.ok) {
        await pi.sendMessage(
          { customType: "team:clear-refused", content: `[team:clear ${target}] ${result.line}`, display: false },
          { deliverAs: "nextTurn" },
        );
      }
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // 每轮现读 env + 状态文件写入 bridge，供 hpl-system-prompt 组装消费；
    // 无模块缓存（jiti 每扩展独立实例，跨扩展必须走本进程内显式传递）。
    setTeamSections(Effect.runSync(buildTeamSectionsEffect()));
    // 角色 pane 自己上报已完成任务（事实来源是该 pane 的任务列表；owner 不代报）
    recordOwnCompletedTasks(ctx as { model?: { provider?: string; id?: string } });
    if (!herdrEnvAvailable()) {
      (ctx as unknown as StatusOnlyContext).ui.setStatus("team", undefined);
      return;
    }
    await updateTeamStatus(ctx as unknown as BeforeAgentStartContext & ExtensionCommandContext);
  });

  pi.on("model_select", (event, ctx) => {
    // 程序化恢复不是用户偏好；写回也由恢复路径自己保证
    if (suppressingRestore) return;
    // 模型切换会先 setThinkingLevel 再发本事件；同轮缓冲的 thinking 事件是切换的
    // 附带变化，不是用户偏好，先丢弃再记切模。restore/owner 由 recordModelSwitch 过滤。
    discardPendingThinkingSwitch();
    recordModelSwitch(event, { thinking: ctx.thinkingLevel });
    // 写回 owner 状态：owner `/team:clear`（发 /new）重建 session 时 pi 按 pane 启动的
    // --model 恢复，不写回就回到旧模型。reasoning 模型带上档位，revive 时一并还原。
    writeBackPaneModel(event, { thinking: ctx.thinkingLevel, reasoning: ctx.model?.reasoning });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (suppressingRestore) return;
    // 先缓冲，同轮如果来 model_select 就丢弃；直接切 thinking 才落盘（自适应 thinking 偏好）
    recordThinkingSwitch(event, { model: ctx.model });
  });

  // 角色 pane 的 /new（owner /team:clear 发的键序）会重建 session：先记下用户当前
  // 的模型与 thinking，新 session 起来后恢复，否则回到 pane 启动时的 --model。
  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason !== "new") return;
    if (!process.env.HAPI_ORCH_ROLE || !process.env.HERDR_PANE_ID) return;
    const provider = ctx.model?.provider;
    const id = ctx.model?.id;
    if (!provider || !id) return;
    savedPanePreference = { provider, id, thinking: ctx.thinkingLevel ?? pi.getThinkingLevel() };
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new") return;
    const saved = savedPanePreference;
    savedPanePreference = undefined;
    if (!saved || !process.env.HAPI_ORCH_ROLE || !process.env.HERDR_PANE_ID) return;
    const model = ctx.modelRegistry.find(saved.provider, saved.id);
    if (!model) {
      console.warn(`[hpl-orchestra] 恢复用户切模失败：${saved.provider}/${saved.id} 不在模型注册表`);
      return;
    }
    suppressingRestore = true;
    try {
      // setModel 会按新模型重置 thinking，因此档位必须在它之后再设
      await pi.setModel(model);
      if (saved.thinking) pi.setThinkingLevel(saved.thinking);
    } finally {
      suppressingRestore = false;
    }
  });

  pi.on("message_end", async (event) => {
    if (handlePendingUserMessage(event.message)) return;
    const pending = getPendingRoleWizard();
    if (!pending) return;
    const parsed = parseRoleDefSentinel(assistantMessageText(event.message));
    if (!parsed) return;
    await completePendingRole(parsed);
  });
}
