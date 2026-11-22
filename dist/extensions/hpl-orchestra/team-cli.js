/**
 * team-cli.ts — owner 侧团队收口 CLI：team-status / wake-owner / send-mail。
 *
 * 与 wait-pane 同级注册（cli/commands.ts），沿用同一套约定：退出码即结果
 * （background 唤醒只带退出码），stdout 给人和模型看。
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { defaultSpawn } from "./herdr.js";
import { paneAgentAlive } from "./transport.js";
import { hostAddress, isCoreHost } from "./host.js";
import { coreWaitSettle, normalizeCoreStatus } from "./core.js";
import { newMailId, postMail } from "./mail.js";
import { DEFAULT_TIMEOUT_SEC, WAIT_EXIT, defaultWaitDeps, waitForPaneSettle } from "./wait-pane.js";
import { instanceStoreKey } from "./state.js";
import { allInstances, findTeamStateForPane, isTeamOwner, listTeamStates, readTeamState, teamTasksPathFor } from "./state.js";
import { sampleAgentStateEffect } from "./agent-state.js";
import { briefDirOf, readTaskStoreEffect, taskLabel, taskUpdatedAt } from "./team-tasks.js";
export const TEAM_STATUS_EXIT = { ok: 0, noTeam: 2 };
export const WAKE_OWNER_EXIT = { sent: 0, usage: 1, noTeam: 2, herdr: 3 };
export const WAKE_OWNER_USAGE = '用法：hapi wake-owner --message "<一句话结果>" [--report <报告绝对路径>]';
/** --wait 阶段复用 wait-pane 码表：2 blocked、3 超时；noTeam 同为 2，同属「需人看输出」的非收敛类。 */
export const SEND_MAIL_EXIT = { sent: 0, noTeam: 2, timeout: 3, usage: 4 };
/** pane 回执文件名（按角色定）：只有这两个角色有固定回执名，其余不猜。 */
const REPORT_FILES = {
    worker: "worker-report.md",
    reviewer: "reviewer-report.md",
};
/** `--flag value` / `--flag=value` 两种取值形式 */
function flagValue(args, flag) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === flag)
            return args[i + 1];
        if (arg.startsWith(`${flag}=`))
            return arg.slice(flag.length + 1);
    }
    return undefined;
}
/**
 * 只认 --message / --report 两个具名参数，任何位置参数一律拒绝。
 * 位置参数形式（`wake-owner "done: … -> 路径"`）曾在花名册提示下被静默吞掉、
 * 退回缺省文案而无人察觉——丢信事故的起点，所以宁可用法报错也不猜意图。
 */
function parseWakeOwnerArgs(args) {
    let message;
    let reportPath;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
        const flag = eq > 0 ? arg.slice(0, eq) : arg;
        const inlineValue = eq > 0 ? arg.slice(eq + 1) : undefined;
        if (flag !== "--message" && flag !== "--report")
            return { ok: false, error: `不接受的参数：${arg}` };
        const value = inlineValue ?? args[i + 1];
        if (inlineValue === undefined)
            i++;
        // 空取值（`--report=`、`--report ""`）不能静默丢弃：信照发但 owner 拿不到报告路径
        if (value === undefined || value.trim() === "")
            return { ok: false, error: `参数 ${flag} 缺少取值` };
        if (flag === "--message")
            message = value.trim();
        else
            reportPath = value.trim();
    }
    if (!message)
        return { ok: false, error: "缺少 --message" };
    return { ok: true, params: { message, ...(reportPath ? { reportPath } : {}) } };
}
function countBy(tasks, status) {
    return tasks.filter((task) => task.status === status);
}
/** 数值 id 升序；非数值 id 排到最后（pi-tasks 自己只产生数值 id）。 */
function byId(tasks) {
    return [...tasks].sort((a, b) => (Number.parseInt(a.id, 10) || 0) - (Number.parseInt(b.id, 10) || 0));
}
function labels(tasks, limit) {
    const listed = tasks.slice(0, limit).map(taskLabel);
    return tasks.length > limit ? `${listed.join(", ")}, +${tasks.length - limit} more` : listed.join(", ");
}
/**
 * 回执与超时基准都取自「当前任务」：优先在办里 id 最新的一条，其次按 id 最新的带
 * brief 任务。任务列表空或无 brief → 无当前任务，done/stale 都不成立。
 */
function currentTaskOf(tasks) {
    const ordered = byId(tasks).reverse();
    const inProgress = ordered.filter((task) => task.status === "in_progress");
    return [...inProgress, ...ordered].find((task) => briefDirOf(task) !== undefined);
}
function readStore(path) {
    const result = Effect.runSync(Effect.either(readTaskStoreEffect(path)));
    if (result._tag === "Left")
        return { tasks: [], error: result.left.message };
    return { tasks: result.right?.tasks ?? [] };
}
/** team-status 的 pane 行首：clear? 让 owner 一眼看到「清空提交失败、上下文可能还是旧的」。 */
export function paneHeaderLine(who, state, clearPending, report) {
    return `- ${who} · ${state}${clearPending ? " · clear?" : ""} · report ${report}`;
}
function paneLines(key, instance, spawn) {
    const paneId = instance.paneId;
    const who = `${key} ${paneId}${instance.nickname ? ` ${instance.nickname}` : ""}`;
    const { tasks, error } = readStore(teamTasksPathFor(instanceStoreKey(instance)));
    const reportFile = REPORT_FILES[key];
    const current = currentTaskOf(tasks);
    const currentDir = current ? briefDirOf(current) : undefined;
    const reportPath = reportFile && currentDir ? join(currentDir, reportFile) : undefined;
    // 只有「在办」才期待回执；pending 是 pane 自己拆的待办步骤，不能当停滞时钟
    const expectedReportSince = current?.status === "in_progress" ? taskUpdatedAt(current) : undefined;
    const state = Effect.runSync(sampleAgentStateEffect(paneId, {
        spawn,
        ...(reportPath ? { reportPath } : {}),
        ...(expectedReportSince !== undefined ? { expectedReportSince } : {}),
    }));
    const report = reportPath === undefined
        ? "n/a"
        : existsSync(reportPath) ? `exists (${reportPath})` : `missing (${reportPath})`;
    const header = paneHeaderLine(who, state, instance.clearPending === true, report);
    if (error)
        return [header, `  tasks: 不可读 — ${error}`];
    if (tasks.length === 0)
        return [header, "  tasks: 空（该 pane 还没建过任务）"];
    const ordered = byId(tasks);
    const completed = countBy(ordered, "completed");
    const inProgress = countBy(ordered, "in_progress");
    const pending = countBy(ordered, "pending");
    const parts = [
        `${pending.length} pending${pending.length > 0 ? ` [${labels(pending, 3)}]` : ""}`,
        `${inProgress.length} in_progress${inProgress.length > 0 ? ` [${labels(inProgress, 3)}]` : ""}`,
        `${completed.length} completed${completed.length > 0 ? ` [last ${taskLabel(completed[completed.length - 1])}]` : ""}`,
    ];
    return [header, `  tasks: ${parts.join(", ")}`];
}
/**
 * `hapi team-status`：owner 一眼看全 crew。
 * 只读——绝不写团队状态、绝不写任务列表。
 */
export function runTeamStatusCommand(_args, spawn = defaultSpawn) {
    const state = readTeamState();
    if (!state.enabled || !isTeamOwner(state)) {
        console.log("[team-status] 当前面板不是 Team 主面板（或没有进行中的编排）。");
        return TEAM_STATUS_EXIT.noTeam;
    }
    const owner = state.owner;
    console.log(`团队${state.name ? ` ${state.name}` : ""} — owner ${owner.paneId}${owner.nickname ? ` ${owner.nickname}` : ""}`);
    const instances = allInstances(state);
    if (instances.length === 0) {
        console.log("- 当前没有角色面板");
        return TEAM_STATUS_EXIT.ok;
    }
    for (const entry of state.roles) {
        for (const instance of entry.instances) {
            for (const line of paneLines(entry.key, instance, spawn))
                console.log(line);
        }
    }
    return TEAM_STATUS_EXIT.ok;
}
/**
 * `hapi wake-owner --message <一句话结果> [--report <报告绝对路径>]`：角色 pane 一轮结束/需要决策时主动叫 owner。
 * 写 owner 信箱即返回；owner 忙时消息留在信箱，空闲后收到。
 * 退出码 0 已入队 / 1 用法（含 --report 不存在或不是文件）/ 2 不属于任何团队 / 3 owner 不可用（含写信箱失败，历史键名 herdr）。
 */
export function runWakeOwnerCommand(args, spawn = defaultSpawn) {
    const parsed = parseWakeOwnerArgs(args);
    if (!parsed.ok) {
        console.error(`[wake-owner] ${parsed.error}`);
        console.error(WAKE_OWNER_USAGE);
        return WAKE_OWNER_EXIT.usage;
    }
    const { message, reportPath } = parsed.params;
    // 报告路径由 owner 在自己的 cwd 里读：相对路径只是发送方的私有约定，收方解析必错
    if (reportPath !== undefined && !isAbsolute(reportPath)) {
        console.error(`[wake-owner] --report 必须是绝对路径：${reportPath}`);
        console.error(WAKE_OWNER_USAGE);
        return WAKE_OWNER_EXIT.usage;
    }
    if (reportPath !== undefined) {
        const stat = statSync(reportPath, { throwIfNoEntry: false });
        if (!stat) {
            console.error(`[wake-owner] --report 指向的文件不存在：${reportPath}，未投递。`);
            return WAKE_OWNER_EXIT.usage;
        }
        // 只收文件：目录/设备路径拼出来的「报告」到 owner 手上必定读不出东西
        if (!stat.isFile()) {
            console.error(`[wake-owner] --report 不是文件：${reportPath}，未投递。`);
            return WAKE_OWNER_EXIT.usage;
        }
    }
    // 发送方身份随宿主：TUI 是 herdr pane id，core 是 hc 终端 id。
    const paneId = hostAddress();
    if (!paneId) {
        console.error("[wake-owner] 当前宿主没有团队地址（HERDR_PANE_ID / HC_TERMINAL_ID 皆缺），无法确定发送方。");
        return WAKE_OWNER_EXIT.noTeam;
    }
    const state = findTeamStateForPane(paneId);
    if (!state || !("roles" in state)) {
        console.error(`[wake-owner] 面板 ${paneId} 不属于任何团队，未投递。`);
        return WAKE_OWNER_EXIT.noTeam;
    }
    const ownerPane = state.owner.paneId;
    if (!Effect.runSync(paneAgentAlive(ownerPane, spawn))) {
        console.error(`[wake-owner] owner ${ownerPane} 不可用，未投递。`);
        return WAKE_OWNER_EXIT.herdr;
    }
    // 信箱是唯一投递通道：不再经输入框，busy 不构成拒绝；昵称前缀由接收侧按花名册组装。
    const mail = {
        id: newMailId(),
        from: paneId,
        to: ownerPane,
        kind: "done",
        text: message,
        ...(reportPath !== undefined ? { reportPath } : {}),
    };
    const result = Effect.runSync(Effect.either(postMail(ownerPane, mail)));
    if (result._tag === "Left") {
        console.error(`[wake-owner] 写 owner ${ownerPane} 信箱失败：${result.left.message}`);
        return WAKE_OWNER_EXIT.herdr;
    }
    console.log(`[wake-owner] 已入队 ${ownerPane}：${message}${reportPath ? `（报告：${reportPath}）` : ""}`);
    return WAKE_OWNER_EXIT.sent;
}
/** 目标信箱定位（发送侧）：与 mail-inbox.ownMailbox 同一规则——owner 用 paneId 本名，role 用落盘 key；非团队成员 undefined。 */
export function resolveMailboxKey(targetPaneId) {
    const state = findTeamStateForPane(targetPaneId);
    if (state && "roles" in state) {
        const instance = allInstances(state).find((candidate) => candidate.paneId === targetPaneId);
        return instance ? instanceStoreKey(instance) : undefined;
    }
    const ownerTeam = listTeamStates().find((entry) => entry.state.owner.paneId === targetPaneId);
    return ownerTeam ? targetPaneId : undefined;
}
/**
 * `hapi send-mail <pane-id> --text "<一行>" [--wait] [--timeout <秒>]`：owner 向 role 信箱投派发信。
 * 写信箱即返回，目标 working 也排队不拒绝——「不向 working 派发」上移为编排纪律；
 * --wait 复用 wait-pane 收敛原语，等这一轮结束再返回。退出码 0 已入队（--wait 时已收敛）、
 * 2 无归属团队或 blocked、3 到时未收敛、4 用法。
 */
export function runSendMailCommand(args, deps = defaultWaitDeps) {
    const paneId = args.find((arg) => !arg.startsWith("--"));
    const text = flagValue(args, "--text")?.trim();
    if (!paneId || !text) {
        console.error('用法：hapi send-mail <pane-id> --text "<一行>" [--wait] [--timeout <秒>]');
        return SEND_MAIL_EXIT.usage;
    }
    const storeKey = resolveMailboxKey(paneId);
    if (!storeKey) {
        console.error(`[send-mail] ${paneId} 不属于任何团队，未投递。`);
        return SEND_MAIL_EXIT.noTeam;
    }
    const mail = { id: newMailId(), from: hostAddress() ?? paneId, to: paneId, kind: "dispatch", text };
    const result = Effect.runSync(Effect.either(postMail(storeKey, mail)));
    if (result._tag === "Left") {
        console.error(`[send-mail] 写 ${storeKey} 信箱失败：${result.left.message}`);
        return SEND_MAIL_EXIT.noTeam;
    }
    console.log(`[send-mail] 已入队 ${storeKey}：${text}`);
    if (!args.includes("--wait"))
        return SEND_MAIL_EXIT.sent;
    const timeoutSec = Number(flagValue(args, "--timeout")) || DEFAULT_TIMEOUT_SEC;
    if (isCoreHost()) {
        // core 宿主收敛走 hc wait 原语：wait-pane 轮询依赖 herdr 状态序号，core 下恒缺（herdr server 不在场）
        const wait = Effect.runSync(coreWaitSettle(paneId, timeoutSec, deps.coreSpawn ?? defaultSpawn));
        const outcome = !wait.settled
            ? "timeout"
            : normalizeCoreStatus(wait.status) === "blocked" ? "blocked" : "settled";
        console.log(`[send-mail] ${paneId} → ${outcome}（status=${wait.status ?? "unknown"}）`);
        return WAIT_EXIT[outcome];
    }
    const wait = waitForPaneSettle(paneId, { timeoutMs: timeoutSec * 1000 }, deps);
    console.log(`[send-mail] ${paneId} → ${wait.outcome}（status=${wait.status}，耗时 ${Math.round(wait.elapsedMs / 1000)}s）`);
    return WAIT_EXIT[wait.outcome];
}
