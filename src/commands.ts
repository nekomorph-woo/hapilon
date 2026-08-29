// ─── Command Registry ────────────────────────────────────────────────
// Single source of truth for hapilon CLI commands.
// Used by help.ts for help text display and cli.ts for routing.
// handler 内 lazy import，保持启动开销不增加。

export interface CommandDef {
  name: string;
  description: string;
  usage?: string;
  subcommands?: CommandDef[];
  /** 命令执行器；undefined = 无独立执行逻辑 */
  handler?: (args: string[]) => Promise<void> | void;
}

/** 全局选项（--help 等）——help.ts 由此生成「选项:」段 */
export interface CommandOption {
  name: string;
  description: string;
}

export const GLOBAL_FLAGS: CommandOption[] = [
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

export const COMMANDS: CommandDef[] = [
  {
    name: "setup",
    description: "初始化 ~/.hapilon/ 和 provider 认证",
    usage: "hapilon setup [--quick]",
    subcommands: [
      {
        name: "--quick",
        description: "仅创建骨架目录，跳过交互式问答",
      },
    ],
    handler: async (args) => {
      const mod = await import("./setup.js");
      const isQuick =
        args.includes("--quick") || args.includes("-q");
      if (isQuick) {
        mod.setupQuick();
      } else {
        await mod.setupInteractive();
      }
    },
  },
  {
    name: "doctor",
    description: "诊断 hapilon 配置状态（版本、目录、provider 认证）",
    usage: "hapilon doctor",
    handler: async () => {
      const { doctor } = await import("./setup.js");
      doctor();
    },
  },
  {
    name: "config",
    description: "管理 hapilon 配置",
    subcommands: [
      {
        name: "show",
        description: "展示当前默认 provider 和模型配置",
      },
      {
        name: "default",
        description: "设置或清除默认 provider 和模型",
        subcommands: [
          {
            name: "--set",
            description: "交互式选择默认 provider 和模型",
          },
          {
            name: "--unset",
            description: "清除默认 provider 和模型配置",
          },
        ],
      },
      {
        name: "provider",
        description: "管理 provider API key",
        subcommands: [
          {
            name: "list",
            description: "列出已配置的 provider（key 脱敏显示）",
          },
          {
            name: "add <id>",
            description: "添加或更新 provider API key",
          },
          {
            name: "remove <id>",
            description: "删除 provider API key",
          },
        ],
      },
    ],
    handler: async (args) => {
      const { handleConfig } = await import("./config/handlers.js");
      await handleConfig(args);
    },
  },
  {
    name: "mcp",
    description: "管理 MCP server 配置（pi-mcp-adapter，#49/#50）",
    subcommands: [
      {
        name: "add <name> stdio -- <command> [args...] [--env K=V]...",
        description: "添加本地子进程 MCP server",
      },
      {
        name: "add <name> http <url> [--header \"K: V\"]...",
        description: "添加远程 MCP server",
      },
      {
        name: "list",
        description: "列出已配置的 MCP server",
      },
      {
        name: "remove <name> [-y]",
        description: "删除 MCP server（-y 跳过确认）",
      },
    ],
    handler: async (args) => {
      const { handleMcp } = await import("./mcp/handlers.js");
      await handleMcp(args.slice(1));
    },
  },
  {
    name: "help",
    description: "显示帮助信息",
    usage: "hapilon help [command]",
    handler: async (args) => {
      const { printHelp, printHelpFor } = await import("./help.js");
      const cmdName = args[1];
      if (cmdName) {
        printHelpFor(cmdName);
      } else {
        printHelp();
      }
    },
  },
];
