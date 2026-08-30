/**
 * tools.ts — hpl-add-dir 两个 LLM 工具（依赖注入）
 *
 * add_directory / search_external_files，依赖 CommandOps 注入状态与操作，
 * index.ts 组装注册，行为与拆分前一致。
 */
import { Text } from "@earendil-works/pi-tui";
import * as childProcess from "node:child_process";
import * as path from "node:path";
import { scanDirContext, resolveDir, dirExists } from "./context.js";
// ─── 工具注册 ─────────────────────────────────────────────────────────
export function registerTools(pi, ops) {
    pi.registerTool({
        name: "add_directory",
        label: "Add Directory",
        description: "Add an external directory to this session so its HAPILON.md is loaded into context. " +
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
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const dirPath = ops.resolveInputPath(params.path.replace(/^@/, ""), ctx.cwd);
            const result = ops.addDir(dirPath, ctx.cwd, ctx);
            if (!result.ok) {
                throw new Error(result.message);
            }
            // 为 LLM 构建有用的响应
            const resolvedPath = resolveDir(dirPath, ctx.cwd);
            const dirCtx = scanDirContext(resolvedPath);
            const response = [result.message];
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
        renderCall(args, theme, _context) {
            const dirPath = args.path?.replace(/^@/, "") ?? "";
            let text = theme.fg("toolTitle", theme.bold("add_directory "));
            text += theme.fg("accent", dirPath);
            if (args.reason) {
                text += theme.fg("dim", ` — ${args.reason}`);
            }
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded }, theme, _context) {
            const details = result.details;
            if (!details) {
                const content = result.content?.[0];
                const text = content && "text" in content ? content.text : "Done";
                return new Text(theme.fg("success", `✓ ${text}`), 0, 0);
            }
            const parts = [];
            parts.push(theme.fg("success", `✓ Added ${path.basename(details.directory ?? "")}`));
            const badges = [];
            if (details.hasHapilonMd)
                badges.push(theme.fg("accent", "HAPILON.md"));
            if (details.extensionCount && details.extensionCount > 0) {
                badges.push(theme.fg("dim", `${details.extensionCount} ext`));
            }
            if (badges.length > 0) {
                parts.push(theme.fg("dim", " │ ") + badges.join(theme.fg("dim", ", ")));
            }
            return new Text(parts.join(""), 0, 0);
        },
    });
    pi.registerTool({
        name: "search_external_files",
        label: "Search External Files",
        description: "Search for files across all external directories added to this session. " +
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
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
            const addedDirs = ops.getDirs();
            if (addedDirs.length === 0) {
                throw new Error("No external directories added. Use /add-dir or add_directory first.");
            }
            const maxResults = params.maxResults ?? 50;
            const pattern = params.pattern.replace(/^@/, "");
            // 对每个目录使用 find 命令
            const results = [];
            let totalFound = 0;
            for (const dir of addedDirs) {
                if (signal?.aborted)
                    break;
                if (!dirExists(dir.absolutePath))
                    continue;
                try {
                    const remaining = maxResults - totalFound;
                    if (remaining <= 0)
                        break;
                    // 使用数组参数的 spawnSync，避免 shell 注入
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
                }
                catch {
                    // 跳过 find 失败的目录
                }
            }
            if (totalFound === 0) {
                return {
                    content: [{ type: "text", text: `No files matching "${pattern}" found in ${addedDirs.length} external director${addedDirs.length === 1 ? "y" : "ies"}.` }],
                    details: { totalFound: 0, pattern },
                };
            }
            const lines = [`Found ${totalFound} file(s) matching "${pattern}":\n`];
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
        renderCall(args, theme, _context) {
            const pattern = args.pattern?.replace(/^@/, "") ?? "";
            let text = theme.fg("toolTitle", theme.bold("search_external_files "));
            text += theme.fg("accent", `"${pattern}"`);
            text += theme.fg("dim", ` across ${ops.getDirs().length} dir(s)`);
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded }, theme, _context) {
            const details = result.details;
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
