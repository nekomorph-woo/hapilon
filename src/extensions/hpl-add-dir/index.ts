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
 * 结构（code-review 拆分）：
 *   index.ts    — 工厂入口：状态 + 核心操作 + 生命周期 + 注入 + 组装注册
 *   context.ts  — 目录扫描、注入构建、共享辅助函数（纯函数）
 *   widget.ts   — TUI 顶栏渲染
 *   commands.ts — 四个命令（依赖注入 CommandOps）
 *   tools.ts    — 两个 LLM 工具（依赖注入 CommandOps）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  scanDirContext,
  buildContextInjection,
  invalidateContextCache,
  resolveDir,
  dirExists,
  type AddedDir,
} from "./context.js";
import { updateWidget } from "./widget.js";
import { registerCommands, type AddDirResult, type RemoveDirResult } from "./commands.js";
import { registerTools } from "./tools.js";
import { suggestDirectories } from "./suggestions.js";

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function hplAddDir(pi: ExtensionAPI) {
  // 会话级状态
  let addedDirs: AddedDir[] = [];

  // -----------------------------------------------------------------------
  // 状态重建
  // -----------------------------------------------------------------------

  function reconstructState(ctx: ExtensionContext) {
    addedDirs = [];

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "add-dir:state") {
        addedDirs = (entry.data as { dirs: AddedDir[] })?.dirs ?? [];
      }
    }

    // 可能已切换会话，使缓存失效
    invalidateContextCache();

    updateWidget(ctx, addedDirs);
  }

  function persistState() {
    // 目录列表持久化到 session entries，/resume 自动恢复
    pi.appendEntry("add-dir:state", { dirs: addedDirs });
  }

  // -----------------------------------------------------------------------
  // 核心操作
  // -----------------------------------------------------------------------

  /**
   * 解析用户输入——可能是标签（例如 "xshop"）而不是真实路径。
   * 当输入无法解析为已存在的目录时，在建议中查找匹配的标签。
   */
  function resolveInputPath(input: string, cwd: string): string {
    // 若解析为已存在的目录，直接使用
    if (dirExists(resolveDir(input, cwd))) return input;

    // 若看起来是纯名称（无分隔符、非相对路径），检查建议
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

  function addDir(dirPath: string, cwd: string, ctx: ExtensionContext): AddDirResult {
    const absolutePath = resolveDir(dirPath, cwd);

    if (!dirExists(absolutePath)) {
      return { ok: false, message: `Directory does not exist: ${absolutePath}`, extensionHints: [] };
    }

    // 检查重复
    if (addedDirs.some((d) => d.absolutePath === absolutePath)) {
      return { ok: false, message: `Already added: ${absolutePath}`, extensionHints: [] };
    }

    // 检查不是当前 cwd
    const resolvedCwd = resolveDir(cwd, cwd);
    if (absolutePath === resolvedCwd) {
      return { ok: false, message: `That's the current working directory — already in scope.`, extensionHints: [] };
    }

    const label = path.basename(absolutePath);
    addedDirs.push({ absolutePath, label, addedAt: Date.now() });
    invalidateContextCache();
    persistState();
    updateWidget(ctx, addedDirs);

    // 报告扫描结果
    const dirCtx = scanDirContext(absolutePath);
    const found: string[] = [];
    if (dirCtx.hapilonMd) found.push("HAPILON.md");

    // 检测扩展并构建提示
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

  function removeDir(absolutePath: string, ctx: ExtensionContext): RemoveDirResult {
    const idx = addedDirs.findIndex((d) => d.absolutePath === absolutePath);
    if (idx === -1) {
      return { ok: false, message: `Not found: ${absolutePath}` };
    }

    const removed = addedDirs.splice(idx, 1)[0];
    invalidateContextCache();
    persistState();
    updateWidget(ctx, addedDirs);

    return { ok: true, message: `Removed ${removed.label} (${removed.absolutePath}).` };
  }

  // -----------------------------------------------------------------------
  // 会话事件
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_e, ctx) => reconstructState(ctx));
  // session_switch / session_fork 在 0.80–0.84 的 ExtensionAPI 中不存在
  // （内核 emit() 对未知事件宽容跳过、session_start 覆盖切换/分叉场景），不注册
  pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));

  // -----------------------------------------------------------------------
  // 系统提示注入
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event, _ctx) => {
    if (addedDirs.length === 0) return;

    const injection = buildContextInjection(addedDirs);
    return {
      systemPrompt: event.systemPrompt + injection,
    };
  });

  // -----------------------------------------------------------------------
  // 命令与工具注册（依赖注入）
  // -----------------------------------------------------------------------

  registerCommands(pi, {
    getDirs: () => addedDirs,
    addDir,
    removeDir,
    resolveInputPath,
  });

  registerTools(pi, {
    getDirs: () => addedDirs,
    addDir,
    removeDir,
    resolveInputPath,
  });
}
