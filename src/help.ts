import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, GLOBAL_FLAGS, type CommandDef } from "./commands.js";

// ─── Version ─────────────────────────────────────────────────────────

export function getVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(__dirname, "..", "package.json");
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    console.warn("Warning: 无法读取版本号");
    return "unknown";
  }
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
  console.log(`hapilon v${version} — Pi Coding Agent 启动器

用法:
  hapilon [options]                 启动 Pi TUI 交互
  hapilon <command> [args]          执行子命令

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

使用 hapilon help <command> 查看具体命令详情。`);
}

// ─── Command-specific Help ───────────────────────────────────────────

export function printHelpFor(commandName: string): void {
  const cmd = COMMANDS.find((c) => c.name === commandName);

  if (!cmd) {
    console.error(`未知命令: ${commandName}`);
    console.error("输入 hapilon help 查看可用命令");
    return;
  }

  const version = getVersion();
  console.log(`hapilon v${version} > ${cmd.name}`);

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
