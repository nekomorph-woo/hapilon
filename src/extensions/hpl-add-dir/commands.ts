/**
 * commands.ts — hpl-add-dir 四个命令（依赖注入）
 *
 * handler 依赖工厂闭包内的状态与核心操作，通过 CommandOps 注入，
 * index.ts 组装注册，行为与拆分前一致。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickFromList } from "../../shared/list-picker.js";
import { runMenuLoop } from "../../shared/menu-loop.js";
import { suggestDirectories } from "./suggestions.js";
import { scanDirContext, resolveDir, type AddedDir } from "./context.js";

// ─── 类型 ────────────────────────────────────────────────────────────

export interface AddDirResult {
  ok: boolean;
  message: string;
  extensionHints: string[];
}

export interface RemoveDirResult {
  ok: boolean;
  message: string;
}

/** 命令 handler 依赖的状态与核心操作 */
export interface CommandOps {
  getDirs(): AddedDir[];
  addDir(dirPath: string, cwd: string, ctx: ExtensionContext): AddDirResult;
  removeDir(absolutePath: string, ctx: ExtensionContext): RemoveDirResult;
  resolveInputPath(input: string, cwd: string): string;
}

// ─── 命令注册 ─────────────────────────────────────────────────────────

export function registerCommands(pi: ExtensionAPI, ops: CommandOps): void {
  pi.registerCommand("add-dir", {
    description: "Add an external directory to this session (shows suggestions when called without args)",
    handler: async (args, ctx) => {
      let inputPath = args?.trim();

      if (!inputPath) {
        // 无参调用进入常驻菜单：加完一个目录回到菜单（建议列表现读，已加的不再出现），可连续添加
        await runMenuLoop(ctx, {
          title: "Add directory（连续添加；esc 退出）",
          build: () => {
            const suggestions = suggestDirectories({
              cwd: ctx.cwd,
              alreadyAdded: ops.getDirs().map((d) => d.absolutePath),
            });
            const items = suggestions.map((s) => ({
              label: `${s.label} — ${s.absolutePath} (${s.reasons.slice(0, 2).join(", ")})`,
              run: () => {
                const result = ops.addDir(s.absolutePath, ctx.cwd, ctx);
                ctx.ui.notify(result.message, result.ok ? "info" : "error");
                if (result.extensionHints.length > 0) {
                  ctx.ui.notify(result.extensionHints.join("\n"), "warning");
                }
              },
            }));
            items.push({
              label: "📝 Enter a custom path...",
              run: async () => {
                const prompted = await ctx.ui.input("Directory path:", "");
                if (!prompted) return;
                const resolved = ops.resolveInputPath(prompted, ctx.cwd);
                const result = ops.addDir(resolved, ctx.cwd, ctx);
                ctx.ui.notify(result.message, result.ok ? "info" : "error");
                if (result.extensionHints.length > 0) {
                  ctx.ui.notify(result.extensionHints.join("\n"), "warning");
                }
              },
            });
            return items;
          },
        });
        return;
      }

      inputPath = ops.resolveInputPath(inputPath, ctx.cwd);

      const result = ops.addDir(inputPath, ctx.cwd, ctx);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");

      // 若有扩展提示则显示
      if (result.extensionHints.length > 0) {
        ctx.ui.notify(result.extensionHints.join("\n"), "warning");
      }
    },
  });

  pi.registerCommand("suggest-dirs", {
    description: "Show directory suggestions based on project structure",
    handler: async (_args, ctx) => {
      const suggestions = suggestDirectories({
        cwd: ctx.cwd,
        alreadyAdded: ops.getDirs().map((d) => d.absolutePath),
      });

      if (suggestions.length === 0) {
        ctx.ui.notify("No suggestions found. Try /add-dir <path> to add manually.", "info");
        return;
      }

      // 常驻：加完一个回菜单（建议现读，已加的不再出现）
      await runMenuLoop(ctx, {
        title: "Suggested directories — pick to add",
        build: () => suggestDirectories({
          cwd: ctx.cwd,
          alreadyAdded: ops.getDirs().map((d) => d.absolutePath),
        }).map((s) => ({
          label: `${s.label} (${Math.round(s.score * 100)}%) — ${s.reasons.slice(0, 2).join(", ")}`,
          run: () => {
            const result = ops.addDir(s.absolutePath, ctx.cwd, ctx);
            ctx.ui.notify(result.message, result.ok ? "info" : "error");
            if (result.extensionHints.length > 0) {
              ctx.ui.notify(result.extensionHints.join("\n"), "warning");
            }
          },
        })),
      });
    },
  });

  pi.registerCommand("remove-dir", {
    description: "Remove an external directory from this session",
    getArgumentCompletions(prefix: string) {
      const dirs = ops.getDirs();
      if (dirs.length === 0) return null;
      const lower = prefix.toLowerCase();
      return dirs
        .filter((d) => d.label.toLowerCase().startsWith(lower) || d.absolutePath.toLowerCase().startsWith(lower))
        .map((d) => ({ label: d.label, value: d.absolutePath, description: d.absolutePath }));
    },
    handler: async (args, ctx) => {
      const dirs = ops.getDirs();
      if (dirs.length === 0) {
        ctx.ui.notify("No external directories added.", "info");
        return;
      }

      let absolutePath: string | undefined;

      if (args?.trim()) {
        // 同时支持标签和路径
        const input = args.trim();
        const byLabel = dirs.find((d) => d.label === input);
        absolutePath = byLabel ? byLabel.absolutePath : resolveDir(input, ctx.cwd);
      } else {
        // 交互模式：常驻菜单，删完一个回菜单（列表现读），esc 退出
        await runMenuLoop(ctx, {
          title: "Remove which directory?",
          build: () => ops.getDirs().map((d) => ({
            label: `${d.label} — ${d.absolutePath}`,
            run: () => {
              const result = ops.removeDir(d.absolutePath, ctx);
              ctx.ui.notify(result.message, result.ok ? "info" : "error");
            },
          })),
        });
        return;
      }

      const result = ops.removeDir(absolutePath, ctx);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  });

  pi.registerCommand("dirs", {
    description: "List all external directories in this session",
    handler: async (_args, ctx) => {
      const dirs = ops.getDirs();
      if (dirs.length === 0) {
        ctx.ui.notify("No external directories added. Use /add-dir <path> to add one.", "info");
        return;
      }

      const lines: string[] = [`External directories (${dirs.length}):\n`];
      for (const dir of dirs) {
        const dirCtx = scanDirContext(dir.absolutePath);
        const badges: string[] = [];
        if (dirCtx.hapilonMd) badges.push("HAPILON.md");
        if (dirCtx.extensionPaths.length > 0) badges.push(`${dirCtx.extensionPaths.length} extension(s)`);

        lines.push(`  📂 ${dir.label}`);
        lines.push(`     ${dir.absolutePath}`);
        if (badges.length > 0) {
          lines.push(`     Found: ${badges.join(", ")}`);
        }
        if (dirCtx.extensionPaths.length > 0) {
          lines.push(`     Extensions found — add to settings.json to enable`);
        }
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
