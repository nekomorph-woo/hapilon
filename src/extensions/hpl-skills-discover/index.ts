/**
 * hpl-skills-discover — hapilon 技能发现与注入扩展（resources_discover）
 *
 * Skills 渐进式披露由 Pi 原生引擎自动处理（resources_discover 事件）。
 *
 * 注意：HAPILON.md + Rules 注入已迁移到 hpl-system-prompt 扩展，
 *       由 before_agent_start 全量接管 system prompt 组装。
 *
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectUpwardEffect,
  discoverSkillPathsEffect,
  readSkillFrontmatterName,
  stripFrontmatter,
} from "../../shared/files.js";
import { expandSkillStack } from "./stack-expand.js";
import { getEffectPolicyMode } from "../hpl-effect-policy/bridge.js";
import { hapilonHome } from "../../config/hapilon-home.js";

/** npm 扩展自带 skills 的接线表：包名 → 包内 skills 目录 */
const NPM_SKILL_DIRS: readonly [pkg: string, dir: string][] = [
  ["@dietrichgebert/ponytail", "skills"],
  // 58 个 pstack 技能：54 个 disable-model-invocation 只给人用 /skill: 调，
  // 模型可见仅 how/typescript-best-practices/unslop/why，系统提示膨胀可控。
  ["@zenspc/pi-pstack", "skills"],
];

/** 仅这些 skill 受 Effect policy 门槛约束；其它内置 skill 无条件暴露。 */
const POLICY_GATED_SKILLS: ReadonlySet<string> = new Set(["effect-typescript"]);

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

export const discoverBuiltInSkillsEffect = (
  skillsDirOverride?: string,
): Effect.Effect<string[], never> => Effect.sync(() => {
  try {
    const skillsDir = skillsDirOverride ?? Effect.runSync(resolveHapilonSkillsDirEffect());
    if (!skillsDir) return [];

    const mode = getEffectPolicyMode();
    return Effect.runSync(discoverSkillPathsEffect([skillsDir])).filter((skillPath) => {
      const skillName = basename(dirname(skillPath));
      return !POLICY_GATED_SKILLS.has(skillName) || mode === "prefer" || mode === "required";
    });
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

/**
 * 汇总一次会话 cwd 可见的全部 skill 路径（resources_discover 与 input 堆叠展开共用）。
 */
function discoverAllSkillPaths(cwd: string): string[] {
  // os.homedir():POSIX 读 HOME,Windows 读 USERPROFILE——process.env.HOME
  // 在 Windows 的 cmd/PowerShell 下为空,会误报「HOME 未设置」
  // 使用传入 cwd（会话工作目录）而非 process.cwd()，与 hpl-system-prompt 一致
  const skillPaths = Effect.runSync(
    Effect.flatMap(
      collectUpwardEffect(cwd, homedir(), "agents/skills", hapilonHome()),
      (dirs) => Effect.map(
        Effect.forEach(dirs, (dir) => discoverSkillPathsEffect([dir])),
        (paths) => paths.flat(),
      ),
    ),
  );

  // npm 扩展自带 skills：从模块位置解析（不依赖 cwd）。
  // 单个 SKILL.md 文件路径——Pi loadSkills 支持文件级条目。
  // 包缺失/布局变更时静默跳过：skill 是增强，不应炸掉上下文发现。
  const req = createRequire(import.meta.url);
  for (const [pkg, dir] of NPM_SKILL_DIRS) {
    skillPaths.push(...Effect.runSync(discoverNpmSkillsEffect(pkg, dir, (id) => req.resolve(id))));
  }

  // 内置 skill 按 skill 粒度应用 policy；通用 skill 不受 Effect policy 影响。
  skillPaths.push(...Effect.runSync(discoverBuiltInSkillsEffect()));
  return skillPaths;
}

export default function hplContext(pi: ExtensionAPI): void {
  // ── Skills: 委托 Pi 原生引擎 ────────────────────────────────
  pi.on("resources_discover", (event) => ({
    skillPaths: discoverAllSkillPaths(event.cwd),
  }));

  // ── /skill: 头部堆叠展开 ────────────────────────────────
  // pi 原生只展开首个 /skill: token，这里把头部连续多个全部展开，
  // 尾部文本作为公共参数；单个/未知名仍交还 pi 原生处理。
  pi.on("input", (event, ctx) => {
    const byName = new Map<string, string>();
    for (const p of discoverAllSkillPaths(ctx.cwd)) {
      byName.set(readSkillFrontmatterName(p), p);
    }

    const expanded = expandSkillStack(event.text, (name) => {
      const filePath = byName.get(name);
      if (!filePath) return null;
      try {
        return { filePath, body: stripFrontmatter(readFileSync(filePath, "utf-8")).trim() };
      } catch (err) {
        // 与 pi 原生一致：读失败当不可解析，停在此处，剩余文本照常传递
        console.warn(`Warning: /skill:${name} 展开读文件失败:`, err);
        return null;
      }
    });

    return expanded === null ? { action: "continue" } : { action: "transform", text: expanded };
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
