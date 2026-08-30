/**
 * hpl-add-dir 的目录建议引擎（vendor 自 pi-add-dir v1.3.1）。
 *
 * 扫描项目环境，推荐对会话有用的目录。使用多种启发式：
 *
 * 1. 兄弟项目 —— 与 cwd 同级的、看起来像真实项目的目录
 * 2. 本地依赖路径 —— package.json 中的 file: 依赖、Gemfile 中的 path: 等
 * 3. Git 子模块 —— 来自 .gitmodules 的路径
 * 4. Monorepo 包 —— workspace 成员（npm、Cargo、Go）
 * 5. 含 HAPILON.md 的目录 —— 对本扩展价值最高
 *
 * 按 hapilon 受控上下文设计（#29）：只把 HAPILON.md 作为价值信号，
 * AGENTS.md / CLAUDE.md / skills 不作为建议依据。
 *
 * 每条建议按命中的信号数量得到一个相关度分数（0–1）。
 * 结果去重、按分数排序并限制数量。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDir, dirExists, fileExists, readFileSafe } from "./context.js";
// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 表明目录是真实项目的文件（按出现频率排序，便于快速短路判断） */
const PROJECT_MARKERS = [
    "package.json", // JS/TS（最常见）
    ".git", // 任意 git 仓库
    "Cargo.toml", // Rust
    "go.mod", // Go
    "pyproject.toml", // Python（现代）
    "Gemfile", // Ruby
    "Rakefile", // Ruby
    "pom.xml", // Maven/JVM
    "build.gradle", // Gradle
    "build.gradle.kts", // Gradle（Kotlin DSL）
    "mix.exs", // Elixir
    "Makefile", // C/C++/通用
    "CMakeLists.txt", // CMake
    "setup.py", // Python（旧式）
    "setup.cfg", // Python（旧式）
    "deno.json", // Deno
    "project.json", // Nx
    "composer.json", // PHP
    "Package.swift", // Swift PM
    "pubspec.yaml", // Dart/Flutter
];
/** 使目录对 hpl-add-dir 格外有价值的文件/目录 */
const CONTEXT_MARKERS = [
    "HAPILON.md",
    ".pi/HAPILON.md",
];
const EXTENSION_DIR = ".pi/extensions";
// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------
function isProject(dir) {
    return PROJECT_MARKERS.some(marker => {
        try {
            fs.statSync(path.join(dir, marker));
            return true;
        }
        catch {
            return false;
        }
    });
}
function hasContextFiles(dir) {
    return CONTEXT_MARKERS.some(marker => fileExists(path.join(dir, marker)));
}
function hasExtensions(dir) {
    const full = path.join(dir, EXTENSION_DIR);
    if (!dirExists(full))
        return false;
    try {
        const entries = fs.readdirSync(full, { withFileTypes: true });
        return entries.some(e => (e.isFile() && e.name.endsWith(".ts")) ||
            (e.isDirectory() && fileExists(path.join(full, e.name, "index.ts"))));
    }
    catch {
        return false;
    }
}
/**
 * 辅助：用正则扫描文件，把匹配到的路径收集为候选。
 * 每个正则必须把路径放在 `pathGroup` 索引的捕获组中（默认 1）。
 */
function collectPathsFromFile(cwd, fileName, regex, reason, weight, pathGroup = 1) {
    const content = readFileSafe(path.join(cwd, fileName));
    if (!content)
        return [];
    const candidates = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
        const relPath = match[pathGroup];
        if (!relPath)
            continue;
        const resolved = resolveDir(relPath, cwd);
        if (dirExists(resolved)) {
            candidates.push({ dir: resolved, reasons: [reason], weight });
        }
    }
    return candidates;
}
/** git root 查找缓存——避免对每个兄弟目录重复向上遍历 */
const gitRootCache = new Map();
/** 从 cwd 向上查找 git root。最多 10 层。 */
function findGitRoot(cwd) {
    const cached = gitRootCache.get(cwd);
    if (cached !== undefined)
        return cached;
    let current = cwd;
    const visited = [cwd];
    let depth = 0;
    while (depth < 10) {
        depth++;
        if (dirExists(path.join(current, ".git")) || fileExists(path.join(current, ".git"))) {
            // 为所有已访问路径缓存结果
            for (const v of visited)
                gitRootCache.set(v, current);
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            // 未找到 git root——为所有已访问路径缓存 null
            for (const v of visited)
                gitRootCache.set(v, null);
            return null;
        }
        current = parent;
        visited.push(current);
    }
    // 达到深度上限——为已访问路径缓存 null
    for (const v of visited)
        gitRootCache.set(v, null);
    return null;
}
/** 向上查找 workspace 根目录，寻找 workspace 配置文件。
 *  最多 10 层，避免在独立项目上一直遍历到 / 的高开销。 */
function findWorkspaceRoot(cwd) {
    let current = cwd;
    let depth = 0;
    const MAX_DEPTH = 10;
    while (depth < MAX_DEPTH) {
        depth++;
        // 每层预扫描一次目录内容，避免大量单独的 stat 调用
        let dirFiles;
        try {
            dirFiles = new Set(fs.readdirSync(current));
        }
        catch {
            const parent = path.dirname(current);
            if (parent === current)
                return null;
            current = parent;
            continue;
        }
        // npm/yarn workspaces（通过 package.json）
        if (dirFiles.has("package.json")) {
            const pkg = readFileSafe(path.join(current, "package.json"));
            if (pkg) {
                try {
                    const parsed = JSON.parse(pkg);
                    if (parsed.workspaces)
                        return current;
                }
                catch { /* 跳过 */ }
            }
        }
        // pnpm workspaces
        if (dirFiles.has("pnpm-workspace.yaml"))
            return current;
        // Cargo workspace
        if (dirFiles.has("Cargo.toml")) {
            const cargo = readFileSafe(path.join(current, "Cargo.toml"));
            if (cargo && cargo.includes("[workspace]"))
                return current;
        }
        // Go workspace
        if (dirFiles.has("go.work"))
            return current;
        // Gradle 多项目
        if (dirFiles.has("settings.gradle") || dirFiles.has("settings.gradle.kts"))
            return current;
        // Maven 多模块
        if (dirFiles.has("pom.xml")) {
            const pomXml = readFileSafe(path.join(current, "pom.xml"));
            if (pomXml && pomXml.includes("<modules>"))
                return current;
        }
        // .NET solution
        if ([...dirFiles].some(f => f.endsWith(".sln")))
            return current;
        // Python/uv workspace
        if (dirFiles.has("pyproject.toml")) {
            const pyprojectWs = readFileSafe(path.join(current, "pyproject.toml"));
            if (pyprojectWs && pyprojectWs.includes("[tool.uv.workspace]"))
                return current;
            if (pyprojectWs && current !== cwd)
                return current;
        }
        const parent = path.dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
    return null; // 达到深度上限
}
/**
 * 收集看起来像项目的兄弟目录。
 * 只建议与 cwd 共享同一 git 仓库的兄弟目录，或含有
 * 高价值上下文文件（HAPILON.md）的兄弟目录。
 *
 * 当兄弟项目很多（>3）时，没有强信号的普通项目会被丢弃——
 * 一个放着 10 个仓库的 "projects" 文件夹意味着大多数与当前工作无关。
 */
function collectSiblings(cwd) {
    const parent = path.dirname(cwd);
    if (parent === cwd)
        return []; // 已在根目录
    // 判断 cwd 是否在 git 仓库内——同一仓库内的兄弟目录更相关
    const cwdGitRoot = findGitRoot(cwd);
    const siblings = [];
    try {
        const entries = fs.readdirSync(parent, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (entry.name.startsWith("."))
                continue;
            const fullPath = path.join(parent, entry.name);
            if (fullPath === cwd)
                continue;
            if (!isProject(fullPath))
                continue;
            const siblingGitRoot = findGitRoot(fullPath);
            const sameRepo = !!(cwdGitRoot && siblingGitRoot && cwdGitRoot === siblingGitRoot);
            const hasContext = hasContextFiles(fullPath);
            siblings.push({ fullPath, sameRepo, hasContext });
        }
    }
    catch { /* 跳过 */ }
    // 无关兄弟项目多时，只建议带强信号的
    const totalSiblings = siblings.length;
    const candidates = [];
    for (const sib of siblings) {
        if (sib.sameRepo) {
            candidates.push({
                dir: sib.fullPath,
                reasons: ["sibling project (same repo)"],
                weight: 0.35,
            });
        }
        else if (sib.hasContext) {
            candidates.push({
                dir: sib.fullPath,
                reasons: ["sibling project (has context files)"],
                weight: 0.25,
            });
        }
        else if (totalSiblings <= 3) {
            // 兄弟少——它们很可能密切相关，包含它们
            candidates.push({
                dir: sib.fullPath,
                reasons: ["sibling project"],
                weight: 0.2,
            });
        }
        // 超过 3 个兄弟且无强信号时：跳过（无关项目太多）
    }
    return candidates;
}
/**
 * 收集 package.json 中的本地 file: 依赖。
 */
function collectNpmFileDeps(cwd) {
    const pkg = readFileSafe(path.join(cwd, "package.json"));
    if (!pkg)
        return [];
    const candidates = [];
    try {
        const parsed = JSON.parse(pkg);
        const allDeps = {
            ...parsed.dependencies,
            ...parsed.devDependencies,
        };
        for (const [name, version] of Object.entries(allDeps)) {
            if (typeof version !== "string")
                continue;
            // file:、link:、portal: 协议依赖（npm file:、yarn link:/portal:）
            for (const protocol of ["file:", "link:", "portal:"]) {
                if (version.startsWith(protocol)) {
                    const relPath = version.slice(protocol.length);
                    const resolved = resolveDir(relPath, cwd);
                    if (dirExists(resolved)) {
                        candidates.push({
                            dir: resolved,
                            reasons: [`${protocol} dependency (${name})`],
                            weight: 0.6,
                        });
                    }
                    break;
                }
            }
        }
    }
    catch { /* 跳过 */ }
    return candidates;
}
/** 收集 Gemfile 中的 path: gems 与 gemspec 指令。 */
function collectGemfilePaths(cwd) {
    const content = readFileSafe(path.join(cwd, "Gemfile"));
    if (!content)
        return [];
    const candidates = [];
    // 匹配：gem 'name', ..., path: 'dir'（path: 可出现在选项任意位置）
    const gemRegex = /gem\s+['"]([^'"]+)['"][^\n]*path:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = gemRegex.exec(content)) !== null) {
        const resolved = resolveDir(match[2], cwd);
        if (dirExists(resolved)) {
            candidates.push({ dir: resolved, reasons: [`Gemfile path dependency (${match[1]})`], weight: 0.6 });
        }
    }
    // 匹配：gemspec path: 'dir'（引用其他目录中的 .gemspec）
    const gemspecRegex = /^\s*gemspec(?:\s[^\n]*)?\bpath:\s*['"]([^'"]+)['"]/gm;
    while ((match = gemspecRegex.exec(content)) !== null) {
        const resolved = resolveDir(match[1], cwd);
        if (dirExists(resolved)) {
            candidates.push({ dir: resolved, reasons: ["Gemfile gemspec path"], weight: 0.6 });
        }
    }
    return candidates;
}
/** 收集 Cargo.toml 的 path 依赖。 */
function collectCargoPaths(cwd) {
    return collectPathsFromFile(cwd, "Cargo.toml", /path\s*=\s*"([^"]+)"/g, "Cargo path dependency", 0.6);
}
/** 收集 pyproject.toml 中的 Python 本地文件依赖。 */
function collectPythonPaths(cwd) {
    return collectPathsFromFile(cwd, "pyproject.toml", /file:([^\s"',\]]+)/g, "Python file dependency", 0.6);
}
/**
 * 收集 Composer path 仓库引用。
 */
function collectComposerPaths(cwd) {
    const composer = readFileSafe(path.join(cwd, "composer.json"));
    if (!composer)
        return [];
    const candidates = [];
    try {
        const parsed = JSON.parse(composer);
        const repos = parsed.repositories;
        if (Array.isArray(repos)) {
            for (const repo of repos) {
                if (repo?.type === "path" && typeof repo.url === "string") {
                    // Composer path 仓库可使用 glob 模式，如 ../packages/*
                    const urlPath = repo.url;
                    if (urlPath.endsWith("/*")) {
                        const baseDir = resolveDir(urlPath.slice(0, -2), cwd);
                        if (dirExists(baseDir)) {
                            try {
                                const entries = fs.readdirSync(baseDir, { withFileTypes: true });
                                for (const entry of entries) {
                                    if (!entry.isDirectory() || entry.name.startsWith("."))
                                        continue;
                                    const fullPath = path.join(baseDir, entry.name);
                                    if (isProject(fullPath)) {
                                        candidates.push({
                                            dir: fullPath,
                                            reasons: ["Composer path repository"],
                                            weight: 0.6,
                                        });
                                    }
                                }
                            }
                            catch { /* 跳过 */ }
                        }
                    }
                    else {
                        const resolved = resolveDir(urlPath, cwd);
                        if (dirExists(resolved)) {
                            candidates.push({
                                dir: resolved,
                                reasons: ["Composer path repository"],
                                weight: 0.6,
                            });
                        }
                    }
                }
            }
        }
    }
    catch { /* 跳过 */ }
    return candidates;
}
/** 收集 Elixir mix.exs 的 path 依赖。 */
function collectMixPaths(cwd) {
    return collectPathsFromFile(cwd, "mix.exs", /\{:\w+\s*,\s*path:\s*"([^"]+)"/g, "Elixir mix.exs path dependency", 0.6);
}
/** 收集 Swift Package Manager 本地包依赖。 */
function collectSwiftPMPaths(cwd) {
    return collectPathsFromFile(cwd, "Package.swift", /\.package\s*\(\s*(?:name:\s*"[^"]*"\s*,\s*)?path:\s*"([^"]+)"/g, "Swift PM local package", 0.6);
}
/** 收集 Dart/Flutter pubspec.yaml 的 path 依赖。 */
function collectPubspecPaths(cwd) {
    return collectPathsFromFile(cwd, "pubspec.yaml", /path:\s*['"]?(\.\.\/[^'"\s]+|\.\/.+)['"]?/g, "pubspec.yaml path dependency", 0.6);
}
/** 收集 tsconfig.json 的项目引用（composite 项目）。 */
function collectTsProjectRefs(cwd) {
    // 用正则处理，因为 tsconfig 可能含注释（不是合法 JSON）
    return collectPathsFromFile(cwd, "tsconfig.json", /"path"\s*:\s*"([^"]+)"/g, "TypeScript project reference", 0.55);
}
/**
 * 收集 Docker Compose 构建上下文路径。
 */
function collectDockerComposePaths(cwd) {
    const composeNames = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
    let composeContent = null;
    for (const name of composeNames) {
        composeContent = readFileSafe(path.join(cwd, name));
        if (composeContent)
            break;
    }
    if (!composeContent)
        return [];
    const candidates = [];
    // 匹配构建上下文路径：build: ./path 或 build: { context: ./path }
    // 简单模式：包含 "context:" 或 "build:" 且后跟相对路径的行
    const contextRegex = /(?:context|build):\s*['"]?(\.\.\/[^'"\s]+|\.\/[^'"\s]+)['"]?/g;
    let match;
    while ((match = contextRegex.exec(composeContent)) !== null) {
        const relPath = match[1];
        const resolved = resolveDir(relPath, cwd);
        if (dirExists(resolved) && resolved !== resolveDir(".", cwd)) {
            candidates.push({
                dir: resolved,
                reasons: ["Docker Compose service"],
                weight: 0.5,
            });
        }
    }
    return candidates;
}
/**
 * 从 .gitmodules 收集 git submodule 路径。
 */
function collectSubmodules(cwd) {
    // 在 cwd 或 git root 中查找 .gitmodules
    const gitRoot = findGitRoot(cwd);
    const searchDirs = gitRoot && gitRoot !== cwd ? [cwd, gitRoot] : [cwd];
    const candidates = [];
    for (const searchDir of searchDirs) {
        const gitmodules = readFileSafe(path.join(searchDir, ".gitmodules"));
        if (!gitmodules)
            continue;
        // 匹配：path = vendor/lib-a
        const pathRegex = /path\s*=\s*(.+)/g;
        let match;
        while ((match = pathRegex.exec(gitmodules)) !== null) {
            const relPath = match[1].trim();
            const resolved = resolveDir(relPath, searchDir);
            if (dirExists(resolved)) {
                candidates.push({
                    dir: resolved,
                    reasons: ["git submodule"],
                    weight: 0.5,
                });
            }
        }
    }
    return candidates;
}
/**
 * 收集 monorepo 的 workspace 成员。
 * 支持：npm workspaces、Cargo workspace、Go workspace。
 */
function collectWorkspaceMembers(cwd) {
    const wsRoot = findWorkspaceRoot(cwd);
    if (!wsRoot)
        return [];
    const candidates = [];
    // --- npm workspaces ---
    const pkg = readFileSafe(path.join(wsRoot, "package.json"));
    if (pkg) {
        try {
            const parsed = JSON.parse(pkg);
            const workspaces = Array.isArray(parsed.workspaces)
                ? parsed.workspaces
                : parsed.workspaces?.packages ?? [];
            for (const pattern of workspaces) {
                // 展开简单 glob 模式，如 "packages/*"
                if (pattern.endsWith("/*")) {
                    const baseDir = path.join(wsRoot, pattern.slice(0, -2));
                    if (dirExists(baseDir)) {
                        try {
                            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
                            for (const entry of entries) {
                                if (!entry.isDirectory() || entry.name.startsWith("."))
                                    continue;
                                const fullPath = path.join(baseDir, entry.name);
                                if (fullPath === cwd)
                                    continue;
                                if (isProject(fullPath)) {
                                    candidates.push({
                                        dir: fullPath,
                                        reasons: ["workspace member"],
                                        weight: 0.5,
                                    });
                                }
                            }
                        }
                        catch { /* 跳过 */ }
                    }
                }
                else {
                    // 直接路径
                    const fullPath = resolveDir(pattern, wsRoot);
                    if (fullPath !== cwd && dirExists(fullPath) && isProject(fullPath)) {
                        candidates.push({
                            dir: fullPath,
                            reasons: ["workspace member"],
                            weight: 0.5,
                        });
                    }
                }
            }
        }
        catch { /* 跳过 */ }
    }
    // --- pnpm workspaces (pnpm-workspace.yaml) ---
    const pnpmWs = readFileSafe(path.join(wsRoot, "pnpm-workspace.yaml"));
    if (pnpmWs) {
        // 解析 YAML 风格模式：位于 "packages:" 下、以 "- " 开头的行
        // 格式：
        //   packages:
        //     - 'packages/*'
        //     - 'apps/*'
        const packageLines = pnpmWs.match(/packages:\s*\n((?:\s+-\s*.+\n?)*)/)?.[1] ?? "";
        const patterns = [...packageLines.matchAll(/^\s*-\s*['"]?([^'"\s]+)['"]?/gm)]
            .map(m => m[1]);
        for (const pattern of patterns) {
            if (pattern.endsWith("/*")) {
                const baseDir = path.join(wsRoot, pattern.slice(0, -2));
                if (dirExists(baseDir)) {
                    try {
                        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (!entry.isDirectory() || entry.name.startsWith("."))
                                continue;
                            const fullPath = path.join(baseDir, entry.name);
                            if (fullPath === cwd)
                                continue;
                            if (isProject(fullPath)) {
                                candidates.push({
                                    dir: fullPath,
                                    reasons: ["pnpm workspace member"],
                                    weight: 0.5,
                                });
                            }
                        }
                    }
                    catch { /* 跳过 */ }
                }
            }
            else {
                const fullPath = resolveDir(pattern, wsRoot);
                if (fullPath !== cwd && dirExists(fullPath) && isProject(fullPath)) {
                    candidates.push({
                        dir: fullPath,
                        reasons: ["pnpm workspace member"],
                        weight: 0.5,
                    });
                }
            }
        }
    }
    // --- Cargo workspace ---
    const cargo = readFileSafe(path.join(wsRoot, "Cargo.toml"));
    if (cargo && cargo.includes("[workspace]")) {
        // 匹配 members = ["crates/*"]
        const membersMatch = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/);
        if (membersMatch) {
            const membersStr = membersMatch[1];
            const patterns = membersStr.match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, "")) ?? [];
            for (const pattern of patterns) {
                if (pattern.endsWith("/*")) {
                    const baseDir = path.join(wsRoot, pattern.slice(0, -2));
                    if (dirExists(baseDir)) {
                        try {
                            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
                            for (const entry of entries) {
                                if (!entry.isDirectory() || entry.name.startsWith("."))
                                    continue;
                                const fullPath = path.join(baseDir, entry.name);
                                if (fullPath === cwd)
                                    continue;
                                candidates.push({
                                    dir: fullPath,
                                    reasons: ["Cargo workspace member"],
                                    weight: 0.5,
                                });
                            }
                        }
                        catch { /* 跳过 */ }
                    }
                }
                else {
                    const fullPath = resolveDir(pattern, wsRoot);
                    if (fullPath !== cwd && dirExists(fullPath)) {
                        candidates.push({
                            dir: fullPath,
                            reasons: ["Cargo workspace member"],
                            weight: 0.5,
                        });
                    }
                }
            }
        }
    }
    // --- Gradle multi-project (settings.gradle / settings.gradle.kts) ---
    const gradleNames = ["settings.gradle", "settings.gradle.kts"];
    for (const gName of gradleNames) {
        const gradleSettings = readFileSafe(path.join(wsRoot, gName));
        if (!gradleSettings)
            continue;
        // 匹配：include(':app', ':lib:core') 或 include(":app", ":lib:core")
        // Gradle 用冒号分隔的模块路径，映射到目录路径
        const includeRegex = /include\s*\(?\s*([^)\n]+)/g;
        let gMatch;
        while ((gMatch = includeRegex.exec(gradleSettings)) !== null) {
            const args = gMatch[1];
            // 提取带引号的字符串：':app'、':lib:core'、"app"
            const moduleRegex = /['"][:.]?([^'"]+)['"]/g;
            let mMatch;
            while ((mMatch = moduleRegex.exec(args)) !== null) {
                // 把 Gradle 模块路径（:lib:core）转换为文件系统路径（lib/core）
                const modulePath = mMatch[1].replace(/^:/, "").replace(/:/g, "/");
                const fullPath = resolveDir(modulePath, wsRoot);
                if (fullPath !== cwd && dirExists(fullPath)) {
                    candidates.push({
                        dir: fullPath,
                        reasons: ["Gradle project module"],
                        weight: 0.5,
                    });
                }
            }
        }
        break; // 只处理一个 settings 文件
    }
    // --- Maven multi-module (pom.xml) ---
    const pom = readFileSafe(path.join(wsRoot, "pom.xml"));
    if (pom) {
        // 匹配 <modules> 块内的 <module>subdir</module>
        const modulesMatch = pom.match(/<modules>([\s\S]*?)<\/modules>/);
        if (modulesMatch) {
            const moduleRegex = /<module>([^<]+)<\/module>/g;
            let mMatch;
            while ((mMatch = moduleRegex.exec(modulesMatch[1])) !== null) {
                const modulePath = mMatch[1].trim();
                const fullPath = resolveDir(modulePath, wsRoot);
                if (fullPath !== cwd && dirExists(fullPath)) {
                    candidates.push({
                        dir: fullPath,
                        reasons: ["Maven module"],
                        weight: 0.5,
                    });
                }
            }
        }
    }
    // --- .NET solution (.sln) ---
    try {
        const slnFiles = fs.readdirSync(wsRoot).filter(f => f.endsWith(".sln"));
        for (const slnFile of slnFiles.slice(0, 1)) { // 只处理第一个 .sln
            const slnContent = readFileSafe(path.join(wsRoot, slnFile));
            if (!slnContent)
                continue;
            // 匹配：Project("{...}") = "Name", "path\to\project.csproj", "{...}"
            const projRegex = /Project\([^)]+\)\s*=\s*"[^"]+"\s*,\s*"([^"]+)"/g;
            let slnMatch;
            while ((slnMatch = projRegex.exec(slnContent)) !== null) {
                const projPath = slnMatch[1].replace(/\\/g, "/"); // 转换 Windows 路径
                // 获取包含 .csproj/.fsproj 的目录
                const projDir = path.dirname(projPath);
                if (!projDir || projDir === ".")
                    continue;
                const fullPath = resolveDir(projDir, wsRoot);
                if (fullPath !== cwd && dirExists(fullPath)) {
                    candidates.push({
                        dir: fullPath,
                        reasons: [".NET solution project"],
                        weight: 0.5,
                    });
                }
            }
        }
    }
    catch { /* 跳过 */ }
    // --- uv/Python workspace（pyproject.toml，含 [tool.uv.workspace] members） ---
    const pyprojectRoot = readFileSafe(path.join(wsRoot, "pyproject.toml"));
    if (pyprojectRoot && pyprojectRoot.includes("[tool.uv.workspace]")) {
        // 匹配 TOML 中的 members = ["packages/*", "apps/*"]
        const membersMatch = pyprojectRoot.match(/\[tool\.uv\.workspace\][\s\S]*?members\s*=\s*\[([^\]]+)\]/);
        if (membersMatch) {
            const patterns = [...membersMatch[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
            for (const pattern of patterns) {
                if (pattern.endsWith("/*")) {
                    const baseDir = path.join(wsRoot, pattern.slice(0, -2));
                    if (dirExists(baseDir)) {
                        try {
                            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
                            for (const entry of entries) {
                                if (!entry.isDirectory() || entry.name.startsWith("."))
                                    continue;
                                const fullPath = path.join(baseDir, entry.name);
                                if (fullPath === cwd)
                                    continue;
                                if (isProject(fullPath)) {
                                    candidates.push({
                                        dir: fullPath,
                                        reasons: ["uv workspace member"],
                                        weight: 0.5,
                                    });
                                }
                            }
                        }
                        catch { /* 跳过 */ }
                    }
                }
                else {
                    const fullPath = resolveDir(pattern, wsRoot);
                    if (fullPath !== cwd && dirExists(fullPath) && isProject(fullPath)) {
                        candidates.push({
                            dir: fullPath,
                            reasons: ["uv workspace member"],
                            weight: 0.5,
                        });
                    }
                }
            }
        }
    }
    // --- Go workspace ---
    const gowork = readFileSafe(path.join(wsRoot, "go.work"));
    if (gowork) {
        // 匹配 "use" 块：use ( ./cmd/server ./pkg/auth )
        const useMatch = gowork.match(/use\s*\(([\s\S]*?)\)/);
        if (useMatch) {
            const paths = useMatch[1].trim().split(/\s+/).filter(Boolean);
            for (const p of paths) {
                const fullPath = resolveDir(p, wsRoot);
                if (fullPath !== cwd && dirExists(fullPath)) {
                    candidates.push({
                        dir: fullPath,
                        reasons: ["Go workspace member"],
                        weight: 0.5,
                    });
                }
            }
        }
    }
    return candidates;
}
// ---------------------------------------------------------------------------
// 评分
// ---------------------------------------------------------------------------
function scoreCandidates(candidates, _cwd) {
    // 按绝对路径去重，合并 reasons 和 weights
    const byPath = new Map();
    for (const c of candidates) {
        const existing = byPath.get(c.dir);
        if (existing) {
            existing.reasons.push(...c.reasons);
            existing.totalWeight += c.weight;
        }
        else {
            byPath.set(c.dir, { reasons: [...c.reasons], totalWeight: c.weight });
        }
    }
    const suggestions = [];
    for (const [dir, data] of byPath) {
        let score = Math.min(data.totalWeight, 1.0);
        // 含 HAPILON.md 的加分（对 hpl-add-dir 价值高）
        if (hasContextFiles(dir)) {
            score = Math.min(score + 0.25, 1.0);
            data.reasons.push("has HAPILON.md");
        }
        // 含扩展的加分
        if (hasExtensions(dir)) {
            score = Math.min(score + 0.1, 1.0);
            data.reasons.push("has .pi/extensions");
        }
        // reasons 去重
        const uniqueReasons = [...new Set(data.reasons)];
        suggestions.push({
            absolutePath: dir,
            label: path.basename(dir),
            score: Math.round(score * 100) / 100,
            reasons: uniqueReasons,
        });
    }
    // 按分数降序排序，再按字母序
    suggestions.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    return suggestions;
}
// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
export function suggestDirectories(options) {
    const { cwd, alreadyAdded = [], maxResults = 10 } = options;
    if (!dirExists(cwd))
        return [];
    // 每次调用清空 git root 缓存（路径可能在调用之间变化）
    gitRootCache.clear();
    // 预扫描一次 cwd 内容，避免每个收集器里重复 statSync
    let cwdFiles;
    try {
        cwdFiles = new Set(fs.readdirSync(cwd));
    }
    catch {
        cwdFiles = new Set();
    }
    // 从各启发式收集候选——只调用触发文件存在的收集器
    const candidates = [
        ...collectSiblings(cwd), // 总是运行（扫描父目录）
    ];
    // 文件触发的收集器——cwd 中不存在触发文件则跳过
    if (cwdFiles.has("package.json"))
        candidates.push(...collectNpmFileDeps(cwd));
    if (cwdFiles.has("tsconfig.json"))
        candidates.push(...collectTsProjectRefs(cwd));
    if (cwdFiles.has("composer.json"))
        candidates.push(...collectComposerPaths(cwd));
    if (cwdFiles.has("pubspec.yaml"))
        candidates.push(...collectPubspecPaths(cwd));
    if (cwdFiles.has("Package.swift"))
        candidates.push(...collectSwiftPMPaths(cwd));
    if (cwdFiles.has("mix.exs"))
        candidates.push(...collectMixPaths(cwd));
    if (cwdFiles.has("Gemfile"))
        candidates.push(...collectGemfilePaths(cwd));
    if (cwdFiles.has("Cargo.toml"))
        candidates.push(...collectCargoPaths(cwd));
    if (cwdFiles.has("pyproject.toml"))
        candidates.push(...collectPythonPaths(cwd));
    // Docker Compose —— 检查多个可能的文件名
    if (cwdFiles.has("docker-compose.yml") || cwdFiles.has("docker-compose.yaml") ||
        cwdFiles.has("compose.yml") || cwdFiles.has("compose.yaml")) {
        candidates.push(...collectDockerComposePaths(cwd));
    }
    // 总是运行这些（它们扫描 git root / workspace root，而非 cwd）
    candidates.push(...collectSubmodules(cwd));
    candidates.push(...collectWorkspaceMembers(cwd));
    // 评分并去重
    const scored = scoreCandidates(candidates, cwd);
    // 过滤掉已添加目录、cwd 本身、cwd 的祖先目录及低分噪音
    const resolvedCwd = resolveDir(".", cwd);
    const excluded = new Set([resolvedCwd, ...alreadyAdded]);
    const MIN_SCORE = 0.15;
    return scored
        .filter(s => {
        if (excluded.has(s.absolutePath))
            return false;
        if (s.score < MIN_SCORE)
            return false;
        // 排除 cwd 的祖先目录（我们已在其中）
        if (resolvedCwd.startsWith(s.absolutePath + path.sep))
            return false;
        return true;
    })
        .slice(0, maxResults);
}
