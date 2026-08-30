/**
 * hpl-context — hapilon 自有上下文体系扩展
 *
 * Skills 渐进式披露由 Pi 原生引擎自动处理（resources_discover 事件）。
 *
 * 注意：HAPILON.md + Rules 注入已迁移到 hpl-system-prompt 扩展，
 *       由 before_agent_start 全量接管 system prompt 组装。
 *
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { collectUpward, discoverSkillPaths, } from "../../shared/files.js";
/** npm 扩展自带 skills 的接线表（#55）：包名 → 包内 skills 目录 */
const NPM_SKILL_DIRS = [
    ["@dietrichgebert/ponytail", "skills"],
];
/**
 * 解析 npm 扩展的包根目录。包根含 package.json——部分包 exports 锁死
 * ./package.json 子路径（如 ponytail），降级为 resolve 主入口后向上找包根
 * （与 npm-extensions.ts resolveExtensionEntry 同策略）。
 */
export function resolveNpmPkgDir(pkg, resolve) {
    let dir;
    try {
        dir = dirname(resolve(`${pkg}/package.json`));
    }
    catch {
        let probe = dirname(resolve(pkg));
        while (probe !== dirname(probe) && !existsSync(join(probe, "package.json"))) {
            probe = dirname(probe);
        }
        if (!existsSync(join(probe, "package.json")))
            return null;
        dir = probe;
    }
    return dir;
}
export default function hplContext(pi) {
    const userHome = process.env.HOME;
    if (!userHome) {
        // 加载时警告一次：HOME 缺失 → skills 发现被跳过
        console.warn("[hpl-context] HOME 环境变量未设置，hapilon skills 发现将被跳过。");
    }
    // ── Skills: 委托 Pi 原生引擎 ────────────────────────────────
    // 使用 event.cwd（会话工作目录）而非 process.cwd()，与 hpl-system-prompt 一致
    pi.on("resources_discover", (event) => {
        const skillPaths = userHome
            ? discoverSkillPaths(collectUpward(event.cwd, userHome, "agents/skills"))
            : [];
        // npm 扩展自带 skills（#55）：从模块位置解析（不依赖 cwd）。
        // 单个 SKILL.md 文件路径——Pi loadSkills 支持文件级条目。
        // 包缺失/布局变更时静默跳过：skill 是增强，不应炸掉上下文发现。
        const req = createRequire(import.meta.url);
        for (const [pkg, dir] of NPM_SKILL_DIRS) {
            try {
                const pkgDir = resolveNpmPkgDir(pkg, (id) => req.resolve(id));
                if (!pkgDir)
                    continue;
                const skillsDir = join(pkgDir, dir);
                if (!existsSync(skillsDir))
                    continue;
                for (const entry of readdirSyncSafe(skillsDir)) {
                    const skillMd = join(skillsDir, entry, "SKILL.md");
                    if (existsSync(skillMd))
                        skillPaths.push(skillMd);
                }
            }
            catch {
                // 静默跳过（见上）
            }
        }
        return { skillPaths };
    });
}
function readdirSyncSafe(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
