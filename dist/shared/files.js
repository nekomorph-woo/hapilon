/**
 * files.ts — hapilon 共享文件发现函数（基于文件系统 I/O）
 *
 * 扫描 .hapilon/ 目录体系，收集 HAPILON.md / rules / skills 文件。
 * 由 hpl-context 和 hpl-system-prompt 两个扩展共用。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename, sep } from "node:path";
/** 行锚定的 frontmatter 匹配：--- 必须独占一行 */
const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
/** 拆分 YAML frontmatter 与正文；无 frontmatter 时返回 undefined + 原始内容 */
function splitFrontmatter(content) {
    const trimmed = content.trimStart();
    const m = FRONTMATTER_RE.exec(trimmed);
    if (!m)
        return { meta: undefined, body: content };
    const raw = m[1] ?? "";
    const body = trimmed.slice(m[0].length).trimStart();
    const meta = {};
    for (const line of raw.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        let rawValue = line.slice(colonIdx + 1).trim();
        // 剥离 YAML 引号（"false" 与 false 等价处理）
        rawValue = /^["'](.*)["']$/.exec(rawValue)?.[1] ?? rawValue;
        if (key === "alwaysApply") {
            meta.alwaysApply = rawValue !== "false";
        }
    }
    return { meta, body };
}
/** 单层目录内的文件发现：返回匹配 pattern 的完整路径数组（仅直接子级，不递归；字母序） */
export function listFiles(dir, pattern) {
    if (!existsSync(dir))
        return [];
    try {
        const entries = readdirSync(dir).sort();
        const isWildcard = pattern.startsWith("*");
        const suffix = isWildcard ? pattern.slice(1) : null;
        return entries
            .filter((name) => {
            if (name.startsWith("."))
                return false;
            if (suffix !== null)
                return name.endsWith(suffix);
            return name === pattern;
        })
            .map((name) => join(dir, name));
    }
    catch (err) {
        console.warn(`Warning: 跳过目录 ${dir}:`, err);
        return [];
    }
}
/**
 * 从 startDir 逐级向上遍历目录树，在每层检查 `<dir>/.hapilon/<relative>`：
 * 若存在则收集其路径（文件或目录均可，目录供后续 listFiles 扫描）。
 *
 * 终止条件：到达 home 或文件系统根目录。
 * 当 startDir 不在 home 目录树内（如项目位于外置卷 /Volumes/...），
 * 遍历到根后会显式补查 `<home>/.hapilon/<relative>`，
 * 保证全局用户级配置在任何项目位置都能被加载。
 *
 * 返回数组按 全局 home → 祖先 → 深层 顺序排列（深层在后），
 * 使合并时最深层的同名条目覆盖浅层。
 */
export function collectUpward(startDir, home, relative) {
    const results = [];
    let dir = resolve(startDir);
    const resolvedHome = resolve(home);
    const withinHome = dir === resolvedHome || dir.startsWith(resolvedHome + sep);
    while (true) {
        const candidate = join(dir, ".hapilon", relative);
        if (existsSync(candidate)) {
            results.push(candidate);
        }
        if (dir === resolvedHome)
            break;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    // startDir 在 home 之外时遍历不经过 home——显式补查全局 ~/.hapilon
    if (!withinHome) {
        const globalCandidate = join(resolvedHome, ".hapilon", relative);
        if (existsSync(globalCandidate))
            results.push(globalCandidate);
    }
    results.reverse(); // 全局/祖先在前，近层在后
    return results;
}
/** 读取 HAPILON.md 文件，失败直接抛出（Fail Fast） */
export function readHapilonMd(paths) {
    return paths.map((p) => ({ path: p, content: readFileSync(p, "utf8") }));
}
/**
 * 扫描规则目录，读取所有 .md 文件并解析 alwaysApply frontmatter。
 * 返回 alwaysApply 为 true（默认）的规则；文件名为规则名（去后缀）。
 *
 * 失败路径行为：
 * - 目录不存在：listFiles 返回空数组，无 warning
 * - 单个文件读取失败：输出 warning 并跳过该文件
 * - frontmatter 格式不合法：不跳过——按无 frontmatter 处理，原文全文作为规则内容收录
 */
export function readRules(dirPaths) {
    const rules = [];
    for (const dp of dirPaths) {
        for (const file of listFiles(dp, "*.md")) {
            try {
                const raw = readFileSync(file, "utf8");
                const { meta, body } = splitFrontmatter(raw);
                if (meta?.alwaysApply === false)
                    continue;
                rules.push({ name: basename(file, ".md"), content: body });
            }
            catch (err) {
                console.warn(`Warning: 跳过规则文件 ${file}:`, err);
            }
        }
    }
    return rules;
}
/**
 * 扫描技能目录，返回所有包含 SKILL.md 的子目录中的 SKILL.md 绝对路径。
 * Pi 的 loadSkillsFromPaths() 接收这些路径并解析 SKILL.md，自动处理
 * frontmatter 校验、名称去重和渐进式披露。
 */
export function discoverSkillPaths(dirs) {
    const paths = [];
    for (const dir of dirs) {
        if (!existsSync(dir))
            continue;
        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.startsWith("."))
                    continue;
                const skillMd = join(dir, entry.name, "SKILL.md");
                if (existsSync(skillMd))
                    paths.push(skillMd);
            }
        }
        catch (err) {
            console.warn(`Warning: 跳过 skill 目录 ${dir}:`, err);
        }
    }
    return paths;
}
