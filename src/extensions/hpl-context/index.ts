/**
 * hpl-context — hapilon 自有上下文体系扩展
 *
 * Skills 渐进式披露由 Pi 原生引擎自动处理（resources_discover 事件）。
 *
 * 注意：HAPILON.md + Rules 注入已迁移到 hpl-system-prompt 扩展，
 *       由 before_agent_start 全量接管 system prompt 组装。
 *
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectUpwardEffect,
  discoverSkillPathsEffect,
} from "../../shared/files.js";
import { getEffectPolicyMode } from "../hpl-effect-policy/bridge.js";

/** npm 扩展自带 skills 的接线表（#55）：包名 → 包内 skills 目录 */
const NPM_SKILL_DIRS: readonly [pkg: string, dir: string][] = [
  ["@dietrichgebert/ponytail", "skills"],
];

const HAPILON_MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function resolvePackageRootSync(startDir: string): string | null {
  let probe = startDir;
  while (true) {
    if (existsSync(join(probe, "package.json"))) return probe;
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
}

export const resolveHapilonSkillsDirEffect = (
  startDir = HAPILON_MODULE_DIR,
): Effect.Effect<string | null, never> => Effect.sync(() => {
  const root = resolvePackageRootSync(startDir);
  if (!root) return null;
  const dir = join(root, "resources", "skills");
  return existsSync(dir) ? dir : null;
});

const discoverBuiltInSkillsEffect = (): Effect.Effect<string[], never> => Effect.sync(() => {
  try {
    const skillsDir = Effect.runSync(resolveHapilonSkillsDirEffect());
    const skill = skillsDir ? join(skillsDir, "effect-typescript", "SKILL.md") : "";
    return skill && existsSync(skill) ? [skill] : [];
  } catch {
    return [];
  }
});

/**
 * 解析 npm 扩展的包根目录。包根含 package.json——部分包 exports 锁死
 * ./package.json 子路径（如 ponytail），降级为 resolve 主入口后向上找包根
 * （与 npm-extensions.ts resolveExtensionEntry 同策略）。
 */
const resolveNpmPkgDirSync = (pkg: string, resolve: (id: string) => string): string | null => {
  let dir: string;
  try {
    dir = dirname(resolve(`${pkg}/package.json`));
  } catch {
    let probe = dirname(resolve(pkg));
    while (probe !== dirname(probe) && !existsSync(join(probe, "package.json"))) {
      probe = dirname(probe);
    }
    if (!existsSync(join(probe, "package.json"))) return null;
    dir = probe;
  }
  return dir;
}

export const resolveNpmPkgDirEffect = (
  pkg: string,
  resolveModule: (id: string) => string,
): Effect.Effect<string | null, never> => Effect.sync(() => {
  try {
    return resolveNpmPkgDirSync(pkg, resolveModule);
  } catch {
    return null;
  }
});

export function resolveNpmPkgDir(pkg: string, resolveModule: (id: string) => string): string | null {
  return Effect.runSync(resolveNpmPkgDirEffect(pkg, resolveModule));
}

export default function hplContext(pi: ExtensionAPI): void {
  const userHome = process.env.HOME;
  if (!userHome) {
    // 加载时警告一次：HOME 缺失 → skills 发现被跳过
    console.warn("[hpl-context] HOME 环境变量未设置，hapilon skills 发现将被跳过。");
  }

  // ── Skills: 委托 Pi 原生引擎 ────────────────────────────────
  // 使用 event.cwd（会话工作目录）而非 process.cwd()，与 hpl-system-prompt 一致
  pi.on("resources_discover", (event) => {
    const skillPaths = userHome
      ? Effect.runSync(Effect.flatMap(
          collectUpwardEffect(event.cwd, userHome, "agents/skills"),
          (dirs) => Effect.map(
            Effect.forEach(dirs, (dir) => discoverSkillPathsEffect([dir])),
            (paths) => paths.flat(),
          ),
        ))
      : [];

    // npm 扩展自带 skills（#55）：从模块位置解析（不依赖 cwd）。
    // 单个 SKILL.md 文件路径——Pi loadSkills 支持文件级条目。
    // 包缺失/布局变更时静默跳过：skill 是增强，不应炸掉上下文发现。
    const req = createRequire(import.meta.url);
    for (const [pkg, dir] of NPM_SKILL_DIRS) {
      skillPaths.push(...Effect.runSync(discoverNpmSkillsEffect(pkg, dir, (id) => req.resolve(id))));
    }

    // 与 coding_policy 段对称：仅 prefer/required 暴露 Effect skill。
    const mode = getEffectPolicyMode();
    if (mode === "prefer" || mode === "required") {
      skillPaths.push(...Effect.runSync(discoverBuiltInSkillsEffect()));
    }

    return { skillPaths };
  });
}

const discoverNpmSkillsEffect = (
  pkg: string,
  relativeDir: string,
  resolveModule: (id: string) => string,
): Effect.Effect<string[], never> => Effect.sync(() => {
  try {
    const pkgDir = Effect.runSync(resolveNpmPkgDirEffect(pkg, resolveModule));
    if (!pkgDir) return [];
    const skillsDir = join(pkgDir, relativeDir);
    if (!existsSync(skillsDir)) return [];
    return Effect.runSync(discoverSkillPathsEffect([skillsDir]));
  } catch {
    // skills 是增强能力，布局/包缺失时静默跳过。
    return [];
  }
});
