import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * pi / 第三方扩展补丁（自补丁器，替代 patch-package）。
 *
 * 背景：代码块底色靠 pi 的 `mdCodeBlockBg` token 实现，而该 token 只存在于
 * hapilon 的补丁里；后台任务插件把 shell 写成 `/bin/sh`，Windows 上直接 spawn
 * 失败。两处都是我们没有扩展点可用的地方。patch-package 在非 dev 安装（全局
 * tarball）下没有 devDeps 可依赖，所以改成这份零依赖、幂等的字符串级补丁表；
 * postinstall 与 hapilon 启动链都调用它（pi 单独升级时 postinstall 不会跑，
 * 靠启动链补上）。
 *
 * 韧性优先于完整性：升级导致锚点失配时**只警告不阻断**。

/** 补丁锚点目标包 */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** 第二目标包:编辑器组件在 pi-tui 里(与 pi 同 scope、同层安装) */
const PI_TUI_PACKAGE = "@earendil-works/pi-tui";
/** 补丁标记:任一目标文件出现它即视为已补丁 */
const PATCH_MARKER = "mdCodeBlockBg";
/** 中段 slash 触发钩子的 marker(editor 触发门补丁专用) */
const MID_TEXT_SLASH_MARKER = "__hapiMidTextSlash";
/** 「/」键中段触发钩子的 marker(独立 marker,防同 marker 早退漏应用) */
const MID_TEXT_SLASH_OPEN_MARKER = "__hapiMidTextSlashOpen";
/** 后台任务插件 shell 修复的 marker */
const HAPI_SHELL_MARKER = "hapiShell";
/** 后台任务插件包名（hapilon 自身的依赖，不在 pi 包树里） */
const BACKGROUND_TASKS_PACKAGE = "@nklisch/pi-background-tasks";
/**
 * 全部改动均为字符串级替换，逐条 anchors 与实际 pi dist 产物 byte-for-byte 校验过
 * （theme.js 7 条 + theme-json.js 1 条 + theme-schema.json 1 条 + bundle chunk 8 条）。
 */
/** 补丁规则表(导出仅供测试构造 fixture;运行时只读) */
export const PATCH_RULES = [
    {
        file: "dist/modes/interactive/theme/theme.js",
        find: "        ...colors,\n",
        replace: "        ...colors,\n        // hapilon: themes without this token keep the pre-patch look (\"\" -> terminal default bg)\n        mdCodeBlockBg: colors.mdCodeBlockBg ?? \"\",\n",
        occurrences: 1,
    },
    {
        file: "dist/modes/interactive/theme/theme.js",
        find: "    const bgColorKeys = new Set([\n        \"selectedBg\",\n",
        replace: "    const bgColorKeys = new Set([\n        \"selectedBg\",\n        \"mdCodeBlockBg\",\n",
        occurrences: 1,
    },
    {
        file: "dist/modes/interactive/theme/theme.js",
        find: "    return cachedCliHighlightTheme;\n}\n",
        replace: "    return cachedCliHighlightTheme;\n}\n// hapilon: code blocks render on a background swatch. cli-highlight lines carry their\n// own resets, so re-apply the background after every one of them.\nfunction codeBlockLine(text) {\n    const bg = theme.getBgAnsi(\"mdCodeBlockBg\");\n    return theme.bg(\"mdCodeBlockBg\", text.split(\"\\x1b[0m\").join(`\\x1b[0m${bg}`));\n}\n",
        occurrences: 1,
    },
    {
        file: "dist/modes/interactive/theme/theme.js",
        find: "return code.split(\"\\n\").map((line) => theme.fg(\"mdCodeBlock\", line));",
        replace: "return code.split(\"\\n\").map(codeBlockLine);",
        occurrences: 3,
    },
    {
        file: "dist/modes/interactive/theme/theme.js",
        find: "return highlight(code, opts).split(\"\\n\");",
        replace: "return highlight(code, opts).split(\"\\n\").map(codeBlockLine);",
        occurrences: 2,
    },
    {
        file: "dist/modes/interactive/theme/theme.js",
        find: "    catch {\n        return code.split(\"\\n\");\n    }",
        replace: "    catch {\n        return code.split(\"\\n\").map(codeBlockLine);\n    }",
        occurrences: 1,
    },
    {
        file: "dist/modes/interactive/theme/theme.js",
        find: "        codeBlock: (text) => theme.fg(\"mdCodeBlock\", text),\n        codeBlockBorder: (text) => theme.fg(\"mdCodeBlockBorder\", text),",
        replace: "        codeBlock: codeBlockLine,\n        codeBlockBorder: () => \"\",",
        occurrences: 1,
    },
    {
        file: "dist/modes/interactive/theme/theme-json.js",
        find: "        mdCodeBlockBorder: ColorValueSchema,\n",
        replace: "        mdCodeBlockBorder: ColorValueSchema,\n        mdCodeBlockBg: Type.Optional(ColorValueSchema),\n",
        occurrences: 1,
    },
    {
        file: "dist/modes/interactive/theme/theme-schema.json",
        find: "\t\t\t\t\"mdCodeBlockBorder\": {\n\t\t\t\t\t\"$ref\": \"#/$defs/colorValue\",\n\t\t\t\t\t\"description\": \"Markdown code block fences\"\n\t\t\t\t},\n",
        replace: "\t\t\t\t\"mdCodeBlockBorder\": {\n\t\t\t\t\t\"$ref\": \"#/$defs/colorValue\",\n\t\t\t\t\t\"description\": \"Markdown code block fences\"\n\t\t\t\t},\n\t\t\t\t\"mdCodeBlockBg\": {\n\t\t\t\t\t\"$ref\": \"#/$defs/colorValue\",\n\t\t\t\t\t\"description\": \"Markdown code block background (hapilon patch; optional)\"\n\t\t\t\t},\n",
        occurrences: 1,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "scrollbarTrack:colors.scrollbarTrack??colors.muted,",
        replace: "mdCodeBlockBg:colors.mdCodeBlockBg??\"\",scrollbarTrack:colors.scrollbarTrack??colors.muted,",
        occurrences: 1,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "bgColorKeys=new Set([\"selectedBg\",",
        replace: "bgColorKeys=new Set([\"selectedBg\",\"mdCodeBlockBg\",",
        occurrences: 1,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "function createTheme(themeJson,mode,sourcePath){",
        replace: "function codeBlockLine(text){let bg=theme.getBgAnsi(\"mdCodeBlockBg\");return theme.bg(\"mdCodeBlockBg\",text.split(\"\\x1B[0m\").join(\"\\x1B[0m\"+bg))}function createTheme(themeJson,mode,sourcePath){",
        occurrences: 1,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "code.split(`\n`).map(line=>theme.fg(\"mdCodeBlock\",line))",
        replace: "code.split(`\n`).map(codeBlockLine)",
        occurrences: 3,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "return highlight(code,opts).split(`\n`)",
        replace: "return highlight(code,opts).split(`\n`).map(codeBlockLine)",
        occurrences: 2,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "catch{return code.split(`\n`)}",
        replace: "catch{return code.split(`\n`).map(codeBlockLine)}",
        occurrences: 1,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "codeBlock:text=>theme.fg(\"mdCodeBlock\",text),codeBlockBorder:text=>theme.fg(\"mdCodeBlockBorder\",text)",
        replace: "codeBlock:codeBlockLine,codeBlockBorder:()=>\"\"",
        occurrences: 1,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "mdCodeBlockBorder:ColorValueSchema,",
        replace: "mdCodeBlockBorder:ColorValueSchema,mdCodeBlockBg:typebox_exports.Optional(ColorValueSchema),",
        occurrences: 1,
    },
    // ── 中段 slash 补全触发门(hpl-editor-slash):provider 在编辑器触发门之后,
    //    门的行首判定会让中段打字永远不请求补全。给「字母键触发分支」加一个
    //    全局钩子,由扩展注入中段片段判定;钩子缺席时行为与原版一致。
    {
        package: PI_TUI_PACKAGE,
        file: "dist/components/editor.js",
        find: "if (this.isInSlashCommandContext(textBeforeCursor)) {",
        replace: "if (this.isInSlashCommandContext(textBeforeCursor) || globalThis.__hapiMidTextSlash?.(textBeforeCursor)) {",
        occurrences: 3,
        marker: MID_TEXT_SLASH_MARKER,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: "this.isInSlashCommandContext(textBeforeCursor)?this.tryTriggerAutocomplete()",
        replace: "this.isInSlashCommandContext(textBeforeCursor)||globalThis.__hapiMidTextSlash?.(textBeforeCursor)?this.tryTriggerAutocomplete()",
        occurrences: 3,
        marker: MID_TEXT_SLASH_MARKER,
    },
    // 同一需求的另一半:「/」键本身也要能在中段触发(行首门槛 isAtStartOfMessage 之外
    // 加钩子;钩子判定与补全建议同一片段正则)。独立 marker,避免被已应用的同名 marker 早退吞掉
    {
        package: PI_TUI_PACKAGE,
        file: "dist/components/editor.js",
        find: 'if (char === "/" && this.isAtStartOfMessage()) {',
        replace: 'if (char === "/" && (this.isAtStartOfMessage() || globalThis.__hapiMidTextSlashOpen?.(before + char))) {',
        occurrences: 1,
        marker: MID_TEXT_SLASH_OPEN_MARKER,
    },
    {
        file: "dist/bundle/chunks/chunk-JVUZSMYM.js",
        find: 'else if(char==="/"&&this.isAtStartOfMessage())this.tryTriggerAutocomplete()',
        replace: 'else if(char==="/"&&(this.isAtStartOfMessage()||globalThis.__hapiMidTextSlashOpen?.(this.state.lines[this.state.cursorLine].slice(0,this.state.cursorCol)+char)))this.tryTriggerAutocomplete()',
        occurrences: 1,
        marker: MID_TEXT_SLASH_OPEN_MARKER,
    },
    // 后台任务插件（background/monitor）把 shell 写死成 "/bin/sh"：Windows 上无此路径，
    // spawn 直接 ENOENT——team 模式的派发链就跑在 background 里，于是整个机制失效。
    // 改用 pi 导出的 getShellConfig()：与 pi 的 bash 工具同一套平台解析（Windows 优先
    // Git Bash、尊重 settings.shellPath），POSIX 保持原样。上游若自行修复，删掉这三条。
    {
        base: "hapilon",
        package: BACKGROUND_TASKS_PACKAGE,
        file: "extensions/background-tasks.ts",
        find: 'import { spawn, type ChildProcess } from "node:child_process";',
        replace: 'import { spawn, type ChildProcess } from "node:child_process";\n\n'
            + '// hapilon: Windows 没有 /bin/sh；Windows 下复用 pi 的平台 shell 解析（懒解析一次）\n'
            + 'import { getShellConfig } from "@earendil-works/pi-coding-agent";\n'
            + "let hapiShellCache: string | undefined;\n"
            + "function hapiShell(): string {\n"
            + '    if (process.platform !== "win32") return "/bin/sh";\n'
            + "    return (hapiShellCache ??= getShellConfig().shell);\n"
            + "}",
        occurrences: 1,
        marker: HAPI_SHELL_MARKER,
    },
    {
        base: "hapilon",
        package: BACKGROUND_TASKS_PACKAGE,
        file: "extensions/background-tasks.ts",
        find: 'shell: "/bin/sh",',
        replace: "shell: hapiShell(),",
        occurrences: 1,
        marker: HAPI_SHELL_MARKER,
    },
    {
        base: "hapilon",
        package: BACKGROUND_TASKS_PACKAGE,
        file: "extensions/background-tasks.ts",
        find: 'result = await pi.exec!("/bin/sh", ["-c", command], {',
        replace: 'result = await pi.exec!(hapiShell(), ["-c", command], {',
        occurrences: 1,
        marker: HAPI_SHELL_MARKER,
    },
];
/**
 * 目标文件的唯一键与磁盘路径:pi 主包用 findPiDir,其余包按同 scope 同层解析
 * (node_modules/@earendil-works/pi-tui 与 pi-coding-agent 并排;全局/提升安装同构)。
 * base="hapilon" 的包从 hapilon 自身依赖树解析（不在 pi 包树里）。
 */
function resolveTargets(piDir, hapilonRoot) {
    const seen = new Map();
    for (const rule of PATCH_RULES) {
        const pkg = rule.package ?? PI_PACKAGE;
        const base = rule.base ?? "pi";
        const key = `${base}::${pkg}::${rule.file}`;
        if (seen.has(key))
            continue;
        const pkgDir = base === "hapilon"
            ? (findAncestorPackageDir(pkg, hapilonRoot) ?? join(hapilonRoot, "node_modules", pkg))
            : resolvePackageDir(piDir, pkg);
        seen.set(key, { key, path: join(pkgDir, rule.file), label: `${pkg}/${rule.file}`, pkg, file: rule.file });
    }
    return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}
/**
 * 非 pi 主包的解析:遵循 npm 嵌套规则 —— pi 包内嵌套副本优先(pi 依赖冲突时
 * npm 会把 pi-tui 装进 pi-coding-agent/node_modules,运行时用的正是那份),
 * 否则回退同 scope 提升层。
 */
function resolvePackageDir(piDir, pkg) {
    if (pkg === PI_PACKAGE)
        return piDir;
    const nested = join(piDir, "node_modules", pkg);
    if (existsSync(join(nested, "package.json")))
        return nested;
    return join(dirname(dirname(piDir)), pkg);
}
function rulesForTarget(pkg, file) {
    return PATCH_RULES.filter((rule) => (rule.package ?? PI_PACKAGE) === pkg && rule.file === file);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 从 startDir 向上找某个包（兼容 npm 提升与全局安装） */
function findAncestorPackageDir(pkg, startDir) {
    let dir = startDir;
    for (;;) {
        const candidate = join(dir, "node_modules", pkg);
        if (existsSync(join(candidate, "package.json")))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
function findPiDir() {
    return findAncestorPackageDir(PI_PACKAGE, dirname(fileURLToPath(import.meta.url)));
}
function anchorLabel(find) {
    return find.trim().split("\n")[0].slice(0, 60);
}
/**
 * 检查并（必要时）应用补丁。同步、零依赖、已补丁时只读判标记。
 */
export function ensurePiPatch(options = {}) {
    const piDir = options.piDir ?? findPiDir();
    if (piDir === undefined)
        return { kind: "pi-not-found" };
    const hapilonRoot = options.hapilonRoot ?? dirname(fileURLToPath(import.meta.url));
    const targets = resolveTargets(piDir, hapilonRoot);
    const contents = new Map();
    const readProblems = [];
    for (const target of targets) {
        if (!existsSync(target.path)) {
            readProblems.push(`文件不存在：${target.label}`);
            continue;
        }
        try {
            contents.set(target.key, readFileSync(target.path, "utf8"));
        }
        catch (error) {
            readProblems.push(`读取失败：${target.label}（${errorMessage(error)}）`);
        }
    }
    if (readProblems.length > 0)
        return { kind: "stale", piDir, problems: readProblems };
    const alreadyPatched = targets.every((target) => rulesForTarget(target.pkg, target.file)
        .every((rule) => contents.get(target.key).includes(rule.marker ?? PATCH_MARKER)));
    if (alreadyPatched) {
        return { kind: "already-patched", piDir };
    }
    const next = new Map();
    const problems = [];
    for (const target of targets) {
        let text = contents.get(target.key);
        let fileOk = true;
        for (const rule of rulesForTarget(target.pkg, target.file)) {
            // 替换产物已在 → 规则已应用,幂等跳过。必须在锚点计数之前判:
            // 插入式规则(替换文本包含锚点)在已补丁文件上锚点依然存活,
            // 重入会重复插入(曾把 theme.js 打出重复函数声明,ESM 直接 SyntaxError)
            if (text.includes(rule.replace))
                continue;
            const found = text.split(rule.find).length - 1;
            if (found !== rule.occurrences) {
                problems.push(`${target.label}: 锚点出现 ${found} 次（期望 ${rule.occurrences}）「${anchorLabel(rule.find)}」`);
                fileOk = false;
                continue;
            }
            text = text.replaceAll(rule.find, rule.replace);
        }
        if (fileOk)
            next.set(target.key, text);
    }
    // 任一锚点失配 → 整个补丁都不落盘：半补丁（一部分文件带 token 一部分不带）比不补更难查
    if (problems.length > 0)
        return { kind: "stale", piDir, problems };
    // 落盘前先把可写性问完：否则写到一半被 EACCES 打断会留下半补丁
    const unwritable = [];
    for (const target of targets) {
        try {
            accessSync(target.path, constants.W_OK);
        }
        catch (error) {
            unwritable.push(`${target.label}: ${errorMessage(error)}`);
        }
    }
    if (unwritable.length > 0)
        return { kind: "unwritable", piDir, problems: unwritable };
    const files = [];
    for (const target of targets) {
        const text = next.get(target.key);
        if (text === undefined)
            continue;
        try {
            writeFileSync(target.path, text, "utf8");
            files.push(target.label);
        }
        catch (error) {
            return { kind: "unwritable", piDir, problems: [`${target.label}: ${errorMessage(error)}`] };
        }
    }
    return { kind: "patched", piDir, files };
}
/**
 * 仅在有问题时打警告（成功静默）——启动链与 postinstall 共用。
 * 警告不改退出码：主题 JSON 的多余 token 只是不生效，代码块退化为无底色。
 */
export function warnIfPiPatchStale(result) {
    if (result.kind === "stale") {
        console.warn("⚠ pi 或插件已变更，hapilon 补丁（代码块背景/中段 slash/后台任务 shell）未应用"
            + "；请更新 src/patch/ensure-pi-patch.ts 的锚点");
        for (const problem of result.problems.slice(0, 3))
            console.warn(`   · ${problem}`);
    }
    else if (result.kind === "unwritable") {
        console.warn("⚠ pi 或插件目录不可写，hapilon 补丁未应用（代码块无底色；中段 slash 无补全；Windows 后台任务不可用）");
        for (const problem of result.problems)
            console.warn(`   · ${problem}`);
    }
}
