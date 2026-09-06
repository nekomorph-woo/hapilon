import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProjectSignals } from "./policy.js";

type PackageJson = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

type ScanResult = {
  readonly files: string[];
  readonly failed: boolean;
};

const EMPTY_SIGNALS: ProjectSignals = {
  language: "other",
  effectInstalled: false,
  effectImportsFound: false,
  packageManager: undefined,
  hasAgentsMd: false,
  isGreenfield: false,
  isScriptTask: false,
};

function readPackage(cwd: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function exists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** 扫描根文件和一层子目录中的 .ts；不递归第三层。 */
function scanTwoLevels(root: string): ScanResult {
  const files: string[] = [];
  let failed = false;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { files, failed: true };
  }

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isFile()) {
      if (entry.name.endsWith(".ts")) files.push(fullPath);
      continue;
    }
    if (!entry.isDirectory()) continue;

    try {
      for (const child of readdirSync(fullPath, { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith(".ts")) {
          files.push(join(fullPath, child.name));
        }
      }
    } catch {
      // 单个深层目录失败不影响其他候选，但要让 greenfield 保守为 false。
      failed = true;
    }
  }
  return { files, failed };
}

function sourceScan(cwd: string): ScanResult {
  const src = join(cwd, "src");
  if (exists(src)) return scanTwoLevels(src);
  return scanTwoLevels(cwd);
}

function hasEffectImport(files: string[]): boolean {
  const importPattern = /from\s*["']effect["']|require\(\s*["']effect["']\s*\)/;
  for (const file of files) {
    try {
      if (importPattern.test(readFileSync(file, "utf8"))) return true;
    } catch {
      // 单文件读取失败按规格跳过，不 warning、不失败。
    }
  }
  return false;
}

function packageManager(cwd: string): ProjectSignals["packageManager"] {
  if (exists(join(cwd, "package-lock.json"))) return "npm";
  if (exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(cwd, "yarn.lock"))) return "yarn";
  if (exists(join(cwd, "bun.lockb")) || exists(join(cwd, "bun.lock"))) return "bun";
  return undefined;
}

function inspectProjectSync(cwd: string): ProjectSignals {
  try {
    const pkg = readPackage(cwd);
    if (!pkg) return { ...EMPTY_SIGNALS };

    const source = sourceScan(cwd);
    const hasAgentsMd = exists(join(cwd, "AGENTS.md")) || exists(join(cwd, "CLAUDE.md"));
    const manager = packageManager(cwd);
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasEffect = Object.hasOwn(dependencies, "effect");
    const language = exists(join(cwd, "tsconfig.json")) ? "typescript" : "javascript";

    return {
      language,
      effectInstalled: hasEffect,
      effectImportsFound: hasEffectImport(source.files),
      packageManager: manager,
      hasAgentsMd,
      // A genuinely empty scan is greenfield; an unreadable scan is conservative false.
      isGreenfield: manager === undefined && !hasAgentsMd && !source.failed && source.files.length === 0,
      isScriptTask: false,
    };
  } catch {
    return { ...EMPTY_SIGNALS };
  }
}

export const inspectProjectEffect = (cwd: string): Effect.Effect<ProjectSignals, never> =>
  Effect.sync(() => inspectProjectSync(cwd));

export function inspectProject(cwd: string): ProjectSignals {
  return Effect.runSync(inspectProjectEffect(cwd));
}
