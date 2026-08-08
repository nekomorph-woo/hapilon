/**
 * hpl-add-dir — 外部目录管理扩展（vendor 自 pi-add-dir v1.3.1，hapilon 改造）
 *
 * 按 hapilon 受控上下文设计改造（#29）：
 * - 只注入 HAPILON.md（目录根 + .pi/ 子目录）——AGENTS.md / CLAUDE.md
 *   不读取不注入（hapilon 以 --no-context-files 关闭内核 AGENTS/CLAUDE 识别，
 *   上下文体系由 HAPILON.md + rules 接管，外部目录同样遵守）
 * - 外部目录 skills 不注入、不注册（--no-skills + hpl-context 受控收集同理）
 *
 * 保留自上游：/add-dir /suggest-dirs /remove-dir /dirs 命令、
 * add_directory / search_external_files 工具、TUI widget、session 持久化
 * （/resume 恢复目录列表，customType "add-dir:state" 与上游兼容）。
 *
 * Commands:
 *   /add-dir <path>     — add an external directory
 *   /add-dir            — interactive mode with suggestions
 *   /suggest-dirs       — show directory suggestions
 *   /remove-dir [path]  — remove a directory (interactive if no path)
 *   /dirs               — list all added directories
 *
 * Tools:
 *   add_directory           — lets the LLM request adding a directory
 *   search_external_files   — search for files across all external directories
 *
 * Widget:
 *   Shows active external directories above the editor
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { suggestDirectories } from "./suggestions.js";
import {
  scanDirContext,
  buildContextInjection,
  invalidateContextCache,
  type AddedDir,
  type DirContext,
} from "./context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDir(input: string, cwd: string): string {
  const resolved = path.isAbsolute(input) ? input : path.resolve(cwd, input);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return path.resolve(resolved);
  }
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Generate a deterministic hash for a cwd to use as a temp file key.
 */
function cwdHash(cwd: string): string {
  return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

/**
 * Path to the temp state file used by resources_discover.
 * Keyed by cwd so different projects don't share state.
 */
function getTempStatePath(cwd: string): string {
  return path.join(os.tmpdir(), `hpl-add-dir-${cwdHash(cwd)}.json`);
}

/**
 * Write directory list to the temp state file so resources_discover can read it.
 */
function writeTempState(cwd: string, dirs: AddedDir[]): void {
  try {
    fs.writeFileSync(getTempStatePath(cwd), JSON.stringify({ dirs }), "utf-8");
  } catch {
    // Non-critical — temp state is a performance optimization
  }
}

/**
 * Remove the temp state file for a given cwd.
 */
function removeTempState(cwd: string): void {
  try {
    fs.unlinkSync(getTempStatePath(cwd));
  } catch {
    // Already gone or never existed
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function hplAddDir(pi: ExtensionAPI) {
  // Per-session state
  let addedDirs: AddedDir[] = [];

  // Track the cwd for temp state file operations
  let currentCwd: string = "";

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  function reconstructState(ctx: ExtensionContext) {
    addedDirs = [];
    currentCwd = ctx.cwd;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "add-dir:state") {
        addedDirs = (entry.data as { dirs: AddedDir[] })?.dirs ?? [];
      }
    }

    // Invalidate cache since we may have switched sessions
    invalidateContextCache();

    // Sync temp state file so resources_discover stays current
    writeTempState(currentCwd, addedDirs);

    updateWidget(ctx);
  }

  function persistState(cwd?: string) {
    pi.appendEntry("add-dir:state", { dirs: addedDirs });
    // Also write to temp file for resources_discover
    const effectiveCwd = cwd || currentCwd;
    if (effectiveCwd) {
      writeTempState(effectiveCwd, addedDirs);
    }
  }

  // -----------------------------------------------------------------------
  // Widget — width-aware to prevent TUI overflow crashes
  // -----------------------------------------------------------------------

  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    if (addedDirs.length === 0) {
      ctx.ui.setWidget("add-dir", undefined);
      return;
    }

    ctx.ui.setWidget("add-dir", (_tui, theme) => {
      return {
        dispose() {},
        invalidate() {},
        render(width: number): string[] {
          const prefix = theme.fg("accent", "📂");
          const count = theme.fg("muted", ` ${addedDirs.length} external dir${addedDirs.length === 1 ? "" : "s"}`);
          const sep = theme.fg("dim", " │ ");
          const suffix = theme.fg("dim", "  (/dirs to manage)");

          const dirLabels = addedDirs.map((d) => theme.fg("text", d.label)).join(theme.fg("dim", ", "));

          const fullLine = ` ${prefix}${count}${sep}${dirLabels}${suffix}`;
          const fullWidth = visibleWidth(fullLine);

          if (fullWidth <= width) {
            return [fullLine];
          }

          // Truncate dir labels to fit — keep prefix/count/sep/suffix, shrink the middle
          const withoutLabels = ` ${prefix}${count}${sep}`;
          const overhead = visibleWidth(withoutLabels) + visibleWidth(suffix);
          const available = width - overhead;

          if (available > 5) {
            const truncatedLabels = truncateToWidth(dirLabels, available, "…");
            return [`${withoutLabels}${truncatedLabels}${suffix}`];
          }

          // Extremely narrow — just show count
          const minimal = ` ${prefix}${count}`;
          return [truncateToWidth(minimal, width, "…")];
        },
      };
    });
  }

  // -----------------------------------------------------------------------
  // Core operations
  // -----------------------------------------------------------------------

  /**
   * Resolve a user-provided input that might be a label (e.g. "xshop")
   * instead of a real path. Checks suggestions for a matching label
   * when the input doesn't resolve to an existing directory.
   */
  function resolveInputPath(input: string, cwd: string): string {
    // If it resolves to an existing dir, use it as-is
    if (dirExists(resolveDir(input, cwd))) return input;

    // If it looks like a plain name (no separators, not relative), check suggestions
    if (!path.isAbsolute(input) && !input.includes(path.sep) && !input.startsWith(".")) {
      const suggestions = suggestDirectories({
        cwd,
        alreadyAdded: addedDirs.map((d) => d.absolutePath),
      });
      const match = suggestions.find((s) => s.label === input);
      if (match) return match.absolutePath;
    }

    return input;
  }

  function addDir(dirPath: string, cwd: string, ctx: ExtensionContext): {
    ok: boolean;
    message: string;
    extensionHints: string[];
  } {
    const absolutePath = resolveDir(dirPath, cwd);

    if (!dirExists(absolutePath)) {
      return { ok: false, message: `Directory does not exist: ${absolutePath}`, extensionHints: [] };
    }

    // Check for duplicates
    if (addedDirs.some((d) => d.absolutePath === absolutePath)) {
      return { ok: false, message: `Already added: ${absolutePath}`, extensionHints: [] };
    }

    // Check it's not the current cwd
    const resolvedCwd = resolveDir(cwd, cwd);
    if (absolutePath === resolvedCwd) {
      return { ok: false, message: `That's the current working directory — already in scope.`, extensionHints: [] };
    }

    const label = path.basename(absolutePath);
    addedDirs.push({ absolutePath, label, addedAt: Date.now() });
    invalidateContextCache();
    persistState(cwd);
    updateWidget(ctx);

    // Report what was found
    const dirCtx = scanDirContext(absolutePath);
    const found: string[] = [];
    if (dirCtx.hapilonMd) found.push("HAPILON.md");

    // Detect extensions and build hints
    const extensionHints: string[] = [];
    if (dirCtx.extensionPaths.length > 0) {
      extensionHints.push(
        `Found ${dirCtx.extensionPaths.length} extension(s) in ${label}/.pi/extensions/.`,
        `   To enable them, add to your settings.json:`,
        `   { "extensions": ["${absolutePath}/.pi/extensions"] }`,
        `   Then /reload to activate.`,
      );
    }

    const foundStr = found.length > 0 ? ` Found: ${found.join(", ")}.` : " No HAPILON.md found.";
    const message = `Added ${label} (${absolutePath}).${foundStr}`;

    return { ok: true, message, extensionHints };
  }

  function removeDir(absolutePath: string, ctx: ExtensionContext): {
    ok: boolean;
    message: string;
  } {
    const idx = addedDirs.findIndex((d) => d.absolutePath === absolutePath);
    if (idx === -1) {
      return { ok: false, message: `Not found: ${absolutePath}` };
    }

    const removed = addedDirs.splice(idx, 1)[0];
    invalidateContextCache();
    persistState();
    updateWidget(ctx);

    return { ok: true, message: `Removed ${removed.label} (${removed.absolutePath}).` };
  }

  // -----------------------------------------------------------------------
  // Session events
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  // session_switch / session_fork 在 0.80–0.84 的 ExtensionAPI 中不存在
  // （内核 emit() 对未知事件宽容跳过、session_start 覆盖切换/分叉场景），不注册
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

  // Clean up temp state file on shutdown
  pi.on("session_shutdown", async () => {
    if (currentCwd) {
      removeTempState(currentCwd);
    }
  });

  // -----------------------------------------------------------------------
  // System prompt injection
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event, _ctx) => {
    if (addedDirs.length === 0) return;

    const injection = buildContextInjection(addedDirs);
    return {
      systemPrompt: event.systemPrompt + injection,
    };
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("add-dir", {
    description: "Add an external directory to this session (shows suggestions when called without args)",
    handler: async (args, ctx) => {
      let inputPath = args?.trim();

      if (!inputPath) {
        // Show suggestions when called without args
        const suggestions = suggestDirectories({
          cwd: ctx.cwd,
          alreadyAdded: addedDirs.map((d) => d.absolutePath),
        });

        if (suggestions.length > 0) {
          const choices = suggestions.map((s) => {
            const reasons = s.reasons.slice(0, 2).join(", ");
            return `${s.label} — ${s.absolutePath} (${reasons})`;
          });
          choices.push("📝 Enter a custom path...");

          const selected = await ctx.ui.select("Add directory:", choices);
          if (selected === undefined) return;

          const selectedIdx = choices.indexOf(selected);
          if (selectedIdx === choices.length - 1 || selectedIdx === -1) {
            // Custom path (last option or not found)
            const prompted = await ctx.ui.input("Directory path:", "");
            if (!prompted) return;
            inputPath = prompted;
          } else {
            inputPath = suggestions[selectedIdx].absolutePath;
          }
        } else {
          const prompted = await ctx.ui.input("Directory path (no suggestions found):", "");
          if (!prompted) return;
          inputPath = prompted;
        }
      }

      inputPath = resolveInputPath(inputPath, ctx.cwd);

      const result = addDir(inputPath, ctx.cwd, ctx);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");

      // Show extension hints if any
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
        alreadyAdded: addedDirs.map((d) => d.absolutePath),
      });

      if (suggestions.length === 0) {
        ctx.ui.notify("No suggestions found. Try /add-dir <path> to add manually.", "info");
        return;
      }

      const choices = suggestions.map((s) => {
        const score = Math.round(s.score * 100);
        const reasons = s.reasons.slice(0, 2).join(", ");
        return `${s.label} (${score}%) — ${reasons}`;
      });

      const selected = await ctx.ui.select("Suggested directories — pick to add:", choices);
      if (selected === undefined) return;

      const selectedIdx = choices.indexOf(selected);
      if (selectedIdx === -1) return;

      const picked = suggestions[selectedIdx];
      if (!picked) return;

      const result = addDir(picked.absolutePath, ctx.cwd, ctx);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");

      if (result.extensionHints.length > 0) {
        ctx.ui.notify(result.extensionHints.join("\n"), "warning");
      }
    },
  });

  pi.registerCommand("remove-dir", {
    description: "Remove an external directory from this session",
    getArgumentCompletions(prefix: string) {
      if (addedDirs.length === 0) return null;
      const lower = prefix.toLowerCase();
      return addedDirs
        .filter((d) => d.label.toLowerCase().startsWith(lower) || d.absolutePath.toLowerCase().startsWith(lower))
        .map((d) => ({ label: d.label, value: d.absolutePath, description: d.absolutePath }));
    },
    handler: async (args, ctx) => {
      if (addedDirs.length === 0) {
        ctx.ui.notify("No external directories added.", "info");
        return;
      }

      let absolutePath: string | undefined;

      if (args?.trim()) {
        // Support both labels and paths
        const input = args.trim();
        const byLabel = addedDirs.find((d) => d.label === input);
        absolutePath = byLabel ? byLabel.absolutePath : resolveDir(input, ctx.cwd);
      } else {
        // Interactive: pick from list
        const choices = addedDirs.map((d) => `${d.label} — ${d.absolutePath}`);
        const selected = await ctx.ui.select("Remove which directory?", choices);
        if (selected === undefined) return;
        const selectedIdx = choices.indexOf(selected);
        const selectedDir = selectedIdx >= 0 ? addedDirs[selectedIdx] : undefined;
        absolutePath = selectedDir?.absolutePath;
      }

      if (!absolutePath) return;

      const result = removeDir(absolutePath, ctx);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  });

  pi.registerCommand("dirs", {
    description: "List all external directories in this session",
    handler: async (_args, ctx) => {
      if (addedDirs.length === 0) {
        ctx.ui.notify("No external directories added. Use /add-dir <path> to add one.", "info");
        return;
      }

      const lines: string[] = [`External directories (${addedDirs.length}):\n`];
      for (const dir of addedDirs) {
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

  // -----------------------------------------------------------------------
  // LLM Tool — lets the agent request adding a directory
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "add_directory",
    label: "Add Directory",
    description:
      "Add an external directory to this session so its HAPILON.md is loaded into context. " +
      "Use this when you need to reference or work with code in a directory outside the current working directory.",
    promptSnippet: "Add an external directory to this session (loads its HAPILON.md)",
    promptGuidelines: [
      "Use add_directory when you need context from another project or directory outside cwd.",
      "The directory's HAPILON.md is injected into the system prompt automatically.",
      "After adding, you can read/edit/write files in that directory using absolute paths.",
    ],
    // JSON Schema 字面量（hapilon 惯例，不依赖 TypeBox 包）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the directory to add" },
        reason: { type: "string", description: "Why this directory is being added (shown to user)" },
      },
      required: ["path"],
    } as any,

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const dirPath = resolveInputPath(params.path.replace(/^@/, ""), ctx.cwd);
      const result = addDir(dirPath, ctx.cwd, ctx);

      if (!result.ok) {
        throw new Error(result.message);
      }

      // Build a useful response for the LLM
      const resolvedPath = resolveDir(dirPath, ctx.cwd);
      const dirCtx: DirContext = scanDirContext(resolvedPath);
      const response: string[] = [result.message];

      if (dirCtx.hapilonMd) {
        response.push("\nHAPILON.md content has been injected into system context.");
      }
      if (dirCtx.extensionPaths.length > 0) {
        response.push(`\nFound ${dirCtx.extensionPaths.length} extension(s) in .pi/extensions/.`);
        response.push(`To enable: add "${resolvedPath}/.pi/extensions" to settings.json extensions array, then /reload.`);
      }
      response.push(`\nYou can now access files at: ${resolvedPath}`);

      return {
        content: [{ type: "text", text: response.join("\n") }],
        details: {
          directory: resolvedPath,
          hasHapilonMd: !!dirCtx.hapilonMd,
          extensionCount: dirCtx.extensionPaths.length,
        },
      };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderCall(args: any, theme, _context) {
      const dirPath = args.path?.replace(/^@/, "") ?? "";
      let text = theme.fg("toolTitle", theme.bold("add_directory "));
      text += theme.fg("accent", dirPath);
      if (args.reason) {
        text += theme.fg("dim", ` — ${args.reason}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as {
        directory?: string;
        hasHapilonMd?: boolean;
        extensionCount?: number;
      } | undefined;

      if (!details) {
        const content = result.content?.[0];
        const text = content && "text" in content ? content.text : "Done";
        return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
      }

      const parts: string[] = [];
      parts.push(theme.fg("success", `✓ Added ${path.basename(details.directory ?? "")}`));

      const badges: string[] = [];
      if (details.hasHapilonMd) badges.push(theme.fg("accent", "HAPILON.md"));
      if (details.extensionCount && details.extensionCount > 0) {
        badges.push(theme.fg("dim", `${details.extensionCount} ext`));
      }
      if (badges.length > 0) {
        parts.push(theme.fg("dim", " │ ") + badges.join(theme.fg("dim", ", ")));
      }

      return new Text(parts.join(""), 0, 0);
    },
  });

  // -----------------------------------------------------------------------
  // LLM Tool — search files across external directories
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "search_external_files",
    label: "Search External Files",
    description:
      "Search for files across all external directories added to this session. " +
      "Use this when you need to find files in external directories, since the @ file picker " +
      "only searches the current working directory.",
    promptSnippet: "Search for files across all added external directories by name pattern",
    promptGuidelines: [
      "Use search_external_files when you need to find a file in an external directory but don't know its exact path.",
      "Supports glob-style patterns like '*.ts', '**/*.test.js', 'src/**/*.rb'.",
      "Returns matching file paths with their parent directory labels.",
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "File name or glob pattern to search for (e.g., '*.ts', 'config/**', 'README.md')" },
        maxResults: { type: "number", description: "Maximum number of results to return (default: 50)" },
      },
      required: ["pattern"],
    } as any,

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(_toolCallId, params: any, signal, _onUpdate, _ctx) {
      if (addedDirs.length === 0) {
        throw new Error("No external directories added. Use /add-dir or add_directory first.");
      }

      const maxResults = params.maxResults ?? 50;
      const pattern = params.pattern.replace(/^@/, "");

      // Use find command for each directory
      const results: { dir: string; label: string; files: string[] }[] = [];
      let totalFound = 0;

      for (const dir of addedDirs) {
        if (signal?.aborted) break;
        if (!dirExists(dir.absolutePath)) continue;

        try {
          const remaining = maxResults - totalFound;
          if (remaining <= 0) break;

          // Use spawnSync with array args to avoid shell injection
          const hasSlash = pattern.includes("/");
          const findFlag = hasSlash ? "-path" : "-name";
          const findArgs = [
            dir.absolutePath,
            "-not", "-path", "*/node_modules/*",
            "-not", "-path", "*/.git/*",
            findFlag, pattern,
            "-type", "f",
          ];
          const result = childProcess.spawnSync("find", findArgs, {
            encoding: "utf-8",
            timeout: 10_000,
          });
          const output = (result.stdout ?? "").trim();
          const allFiles = output ? output.split("\n").filter(Boolean) : [];
          const files = allFiles.slice(0, remaining);

          if (files.length > 0) {
            results.push({ dir: dir.absolutePath, label: dir.label, files });
            totalFound += files.length;
          }
        } catch {
          // Skip dirs where find fails
        }
      }

      if (totalFound === 0) {
        return {
          content: [{ type: "text", text: `No files matching "${pattern}" found in ${addedDirs.length} external director${addedDirs.length === 1 ? "y" : "ies"}.` }],
          details: { totalFound: 0, pattern },
        };
      }

      const lines: string[] = [`Found ${totalFound} file(s) matching "${pattern}":\n`];
      for (const r of results) {
        lines.push(`📂 ${r.label} (${r.dir}):`);
        for (const f of r.files) {
          lines.push(`  ${f}`);
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { totalFound, pattern, dirCount: results.length },
      };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderCall(args: any, theme, _context) {
      const pattern = args.pattern?.replace(/^@/, "") ?? "";
      let text = theme.fg("toolTitle", theme.bold("search_external_files "));
      text += theme.fg("accent", `"${pattern}"`);
      text += theme.fg("dim", ` across ${addedDirs.length} dir(s)`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { totalFound?: number; pattern?: string; dirCount?: number } | undefined;

      if (!details || !details.totalFound) {
        const content = result.content?.[0];
        const text = content && "text" in content ? content.text : "No results";
        return new Text(theme.fg("muted", text), 0, 0);
      }

      let text = theme.fg("success", `✓ ${details.totalFound} file(s)`);
      text += theme.fg("dim", ` matching "${details.pattern}" in ${details.dirCount} dir(s)`);

      if (expanded) {
        const content = result.content?.[0];
        if (content && "text" in content) {
          text += "\n" + theme.fg("muted", content.text);
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
