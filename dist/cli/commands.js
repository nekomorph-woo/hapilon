// ─── Command Registry ────────────────────────────────────────────────
// Single source of truth for hapilon CLI commands.
// Used by help.ts for help text display and cli.ts for routing.
// handler 内 lazy import，保持启动开销不增加。
import { deriveCliIdentity } from "./identity.js";
const cliIdentity = deriveCliIdentity();
export const GLOBAL_FLAGS = [
    {
        name: "--help, -h",
        description: "显示此帮助",
    },
    {
        name: "--no-safety",
        description: "临时关闭所有安全检查（危险命令拦截 + 文件路径保护）",
    },
    {
        name: "--sandbox",
        description: "OS 内核级沙箱隔离（macOS/Linux，Windows 暂不支持）",
    },
];
export const COMMANDS = [
    {
        name: "setup-herdr",
        description: "初始化 herdr-app 集成（start-agent 菜单 + 图标 + 启动 shim）",
        usage: `${cliIdentity.cliName} setup-herdr`,
        handler: async () => {
            const { setupHerdr } = await import("./setup-herdr.js");
            await setupHerdr();
        },
    },
    {
        name: "doctor",
        description: "诊断 hapilon 配置状态（版本、目录、provider 认证）",
        usage: `${cliIdentity.cliName} doctor`,
        handler: async () => {
            const { doctor } = await import("./setup.js");
            doctor();
        },
    },
    {
        name: "wait-pane",
        description: "等待某个 pane 收敛（团队模式派发的等待原语，供 orchestrator 后台调用）",
        usage: `${cliIdentity.cliName} wait-pane <pane-id> [--timeout <秒>]`,
        subcommands: [
            {
                name: "--timeout <秒>",
                description: `多久未收敛就放弃（默认 900）；退出码 0 收敛 / 2 等待输入 / 3 超时 / 4 用法错误`,
            },
        ],
        handler: async (args) => {
            // 同步阻塞轮询：background 工具以退出码唤醒 orchestrator，故码表即结果
            const { runWaitPaneCommand } = await import("../extensions/hpl-orchestra/wait-pane.js");
            process.exitCode = runWaitPaneCommand(args.slice(1));
        },
    },
    {
        name: "team-status",
        description: "看本团队各角色 pane 的状态、任务进度与回执（只读，替掉逐 pane 轮询）",
        usage: `${cliIdentity.cliName} team-status`,
        handler: async (args) => {
            const { runTeamStatusCommand } = await import("../extensions/hpl-orchestra/team-cli.js");
            process.exitCode = runTeamStatusCommand(args.slice(1));
        },
    },
    {
        name: "wake-owner",
        description: "角色 pane 一轮结束/需要决策时主动通知 owner（退出码 0 已投递 / 2 无归属团队 / 3 投递失败）",
        usage: `${cliIdentity.cliName} wake-owner [--message <一行>]`,
        subcommands: [
            {
                name: "--message <一行>",
                description: "给 owner 的一行结论（缺省「一轮结束」）",
            },
        ],
        handler: async (args) => {
            const { runWakeOwnerCommand } = await import("../extensions/hpl-orchestra/team-cli.js");
            process.exitCode = runWakeOwnerCommand(args.slice(1));
        },
    },
    {
        name: "help",
        description: "显示帮助信息",
        usage: `${cliIdentity.cliName} help [command]`,
        handler: async (args) => {
            const { printHelp, printHelpFor } = await import("./help.js");
            const cmdName = args[1];
            if (cmdName) {
                printHelpFor(cmdName);
            }
            else {
                printHelp();
            }
        },
    },
];
