import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * pi 主题补丁（自补丁器，替代 patch-package）。
 *
 * 背景：代码块底色靠 pi 的 `mdCodeBlockBg` token 实现，而该 token 只存在于
 * hapilon 的补丁里。patch-package 在非 dev 安装（全局 tarball）下没有
 * devDeps 可依赖，所以改成这份零依赖、幂等的字符串级补丁表；postinstall
 * 与 hapilon 启动链都调用它（pi 单独升级时 postinstall 不会跑，靠启动链补上）。
 *
 * 韧性优先于完整性：pi 升级导致锚点失配时**只警告不阻断**——主题 JSON 里的
 * `mdCodeBlockBg` 对未打补丁的 pi 是多余字段，fence 视觉消失而已。
 */
/** 补丁锚点目标包 */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** 补丁标记：任一目标文件出现它即视为已补丁 */
const PATCH_MARKER = "mdCodeBlockBg";
/**
 * 全部改动均为字符串级替换，逐条 anchors 与实际 pi dist 产物 byte-for-byte 校验过
 * （theme.js 7 条 + theme-json.js 1 条 + theme-schema.json 1 条 + bundle chunk 8 条）。
 */
const PATCH_RULES = [
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
];
const PATCHED_FILES = [...new Set(PATCH_RULES.map((rule) => rule.file))].sort();
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 从本模块位置向上找 pi 包（兼容 npm 提升与全局安装） */
function findPiDir() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const candidate = join(dir, "node_modules", PI_PACKAGE);
        if (existsSync(join(candidate, "package.json")))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
function anchorLabel(find) {
    return find.trim().split("\n")[0].slice(0, 60);
}
/**
 * 检查并（必要时）应用补丁。同步、零依赖、约 3ms（4 个文件共 4MB，已补丁时只读判标记）。
 */
export function ensurePiPatch() {
    const piDir = findPiDir();
    if (piDir === undefined)
        return { kind: "pi-not-found" };
    const contents = new Map();
    const readProblems = [];
    for (const file of PATCHED_FILES) {
        const path = join(piDir, file);
        if (!existsSync(path)) {
            readProblems.push(`文件不存在：${file}`);
            continue;
        }
        try {
            contents.set(file, readFileSync(path, "utf8"));
        }
        catch (error) {
            readProblems.push(`读取失败：${file}（${errorMessage(error)}）`);
        }
    }
    if (readProblems.length > 0)
        return { kind: "stale", piDir, problems: readProblems };
    if (PATCHED_FILES.every((file) => contents.get(file).includes(PATCH_MARKER))) {
        return { kind: "already-patched", piDir };
    }
    const next = new Map();
    const problems = [];
    for (const file of PATCHED_FILES) {
        let text = contents.get(file);
        let fileOk = true;
        for (const rule of PATCH_RULES) {
            if (rule.file !== file)
                continue;
            const found = text.split(rule.find).length - 1;
            if (found !== rule.occurrences) {
                problems.push(`${file}: 锚点出现 ${found} 次（期望 ${rule.occurrences}）「${anchorLabel(rule.find)}」`);
                fileOk = false;
                continue;
            }
            text = text.replaceAll(rule.find, rule.replace);
        }
        if (fileOk)
            next.set(file, text);
    }
    // 任一锚点失配 → 整个补丁都不落盘：半补丁（一部分文件带 token 一部分不带）比不补更难查
    if (problems.length > 0)
        return { kind: "stale", piDir, problems };
    // 落盘前先把可写性问完：否则写到一半被 EACCES 打断会留下半补丁
    const unwritable = [];
    for (const file of PATCHED_FILES) {
        try {
            accessSync(join(piDir, file), constants.W_OK);
        }
        catch (error) {
            unwritable.push(`${file}: ${errorMessage(error)}`);
        }
    }
    if (unwritable.length > 0)
        return { kind: "unwritable", piDir, problems: unwritable };
    const files = [];
    for (const [file, text] of next) {
        try {
            writeFileSync(join(piDir, file), text, "utf8");
            files.push(file);
        }
        catch (error) {
            return { kind: "unwritable", piDir, problems: [`${file}: ${errorMessage(error)}`] };
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
        console.warn("⚠ pi 已升级，代码块背景补丁未应用；请更新 src/patch/ensure-pi-patch.ts 的锚点");
        for (const problem of result.problems.slice(0, 3))
            console.warn(`   · ${problem}`);
    }
    else if (result.kind === "unwritable") {
        console.warn("⚠ pi 安装目录不可写，代码块背景补丁未应用（代码块将无底色）");
        for (const problem of result.problems)
            console.warn(`   · ${problem}`);
    }
}
