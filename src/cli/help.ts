import { Effect } from "effect";
import { COMMANDS, GLOBAL_FLAGS, type CommandDef } from "./commands.js";
import { readVersionEffect } from "./version.js";
import { deriveCliIdentity } from "./identity.js";

// ─── Version ─────────────────────────────────────────────────────────

export function getVersion(): string {
  return Effect.runSync(readVersionEffect);
}

// ─── Formatting ──────────────────────────────────────────────────────

function indent(text: string, level: number): string {
  const prefix = "  ".repeat(level);
  return prefix + text;
}

function formatSubcommands(
  subs: CommandDef[],
  level: number,
): string[] {
  const lines: string[] = [];
  for (const sub of subs) {
    lines.push(indent(`${sub.name.padEnd(16)}${sub.description}`, level));
    if (sub.subcommands) {
      lines.push(...formatSubcommands(sub.subcommands, level + 1));
    }
  }
  return lines;
}

// ─── Main Help ───────────────────────────────────────────────────────

export function printHelp(): void {
  const version = getVersion();
  const identity = deriveCliIdentity();
  const commandForms = identity.isDev ? identity.cliName : "hapilon | hapi";
  console.log(`${identity.cliName} v${version} — Pi Coding Agent 启动器

用法:
  ${commandForms} [options]          启动 Pi TUI 交互
  ${commandForms} <command> [args]   执行子命令

命令:`);

  for (const cmd of COMMANDS) {
    console.log(`  ${cmd.name.padEnd(16)}${cmd.description}`);
    if (cmd.subcommands) {
      const subLines = formatSubcommands(cmd.subcommands, 2);
      for (const line of subLines) {
        console.log(line);
      }
    }
  }

  console.log(`
选项:
  ${GLOBAL_FLAGS.map((f) => `${f.name.padEnd(13)}${f.description}`).join("\n  ")}
  其余选项透传给 Pi Coding Agent

${identity.isDev ? "devhapi 是当前仓库的开发启动别名。" : "hapi 是 hapilon 的别名，二者完全等价。"}
使用 ${identity.cliName} help <command> 查看具体命令详情。`);
}

// ─── Command-specific Help ───────────────────────────────────────────

export function printHelpFor(commandName: string): void {
  const cmd = COMMANDS.find((c) => c.name === commandName);

  if (!cmd) {
    const { cliName } = deriveCliIdentity();
    console.error(`未知命令: ${commandName}`);
    console.error(`输入 ${cliName} help 查看可用命令`);
    return;
  }

  const version = getVersion();
  console.log(`${deriveCliIdentity().cliName} v${version} > ${cmd.name}`);

  if (cmd.usage) {
    console.log(`\n用法:\n  ${cmd.usage}`);
  }

  console.log(`\n${cmd.description}`);

  if (cmd.subcommands && cmd.subcommands.length > 0) {
    console.log("\n子命令:");
    const subLines = formatSubcommands(cmd.subcommands, 1);
    for (const line of subLines) {
      console.log(line);
    }
  }

  console.log("");
}
