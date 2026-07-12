// ─── Command Registry ────────────────────────────────────────────────
// Single source of truth for hapilon CLI commands.
// Used by help.ts for help text display.
// (cli.ts routing is not yet driven by this registry.)

export interface CommandDef {
  name: string;
  description: string;
  usage?: string;
  subcommands?: CommandDef[];
}

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
  },
  {
    name: "doctor",
    description: "诊断 hapilon 配置状态（版本、目录、provider 认证）",
    usage: "hapilon doctor",
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
  },
  {
    name: "help",
    description: "显示帮助信息",
    usage: "hapilon help [command]",
  },
];
