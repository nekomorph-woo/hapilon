/**
 * hpl-startup-header workspace helpers.
 *
 * add-dir 通过 custom session entry 保存状态；这里仅读取公开的 session
 * entry 数据，不依赖 hpl-add-dir 的模块实例，因此跨扩展加载也安全。
 */

export interface AddedWorkspaceDir {
  absolutePath: string;
  label: string;
  addedAt: number;
}

export interface WorkspaceEntry {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

function isAddedWorkspaceDir(value: unknown): value is AddedWorkspaceDir {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.absolutePath === "string" &&
    typeof item.label === "string" &&
    typeof item.addedAt === "number" &&
    Number.isFinite(item.addedAt);
}

/** 读取 branch 中最新一条 add-dir:state。 */
export function readAddedWorkspaceDirs(entries: readonly WorkspaceEntry[]): AddedWorkspaceDir[] {
  let latest: AddedWorkspaceDir[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "add-dir:state") continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null) continue;
    const dirs = (data as { dirs?: unknown }).dirs;
    if (Array.isArray(dirs)) {
      latest = dirs.filter(isAddedWorkspaceDir);
    }
  }
  return latest;
}

export function formatAddedDirTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "??:??";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface WorkspacePaneContent {
  lines: string[];
  lineStyles: Array<"text" | "muted">;
}

export function buildWorkspacePaneContent(
  cwd: string,
  addedDirs: readonly AddedWorkspaceDir[],
): WorkspacePaneContent {
  const lines = [cwd, "─".repeat(40)];
  const lineStyles: Array<"text" | "muted"> = ["text", "muted"];

  if (addedDirs.length === 0) {
    lines.push("未添加外部目录（/add <path> 添加）");
    lineStyles.push("muted");
  } else {
    for (const dir of addedDirs) {
      lines.push(`  ${dir.label} — ${dir.absolutePath} · ${formatAddedDirTime(dir.addedAt)}`);
      lineStyles.push("muted");
    }
  }

  return { lines, lineStyles };
}
