/**
 * sandbox-allow.ts — Auto 模式第 0 层：沙箱写目标判定（纯函数）
 *
 * 追踪同一命令内的变量赋值（`VAR=$(mktemp …)`、`VAR=/tmp/…`、`VAR=~/.hapilon-dev/plan-task/…`），
 * 解析破坏性命令（rm / sed -i / chmod / chown）与重定向的写目标；
 * 命令含破坏性命令词且全部写目标落在沙箱路径集
 * （/tmp、/private/var/folders、$HAPILON_HOME、/dev/null）时放行。
 *
 * 宁停不错放：无法静态解析的目标（未知变量、命令替换占位、`..` 越界）一律不放行。
 * 只看重定向不够——`git push … > /tmp/log` 的危险在语义而非文件落点，
 * 因此沙箱放行以破坏性命令词存在为前提，重定向目标仅作附加校验。
 */
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { normalizeForInspection } from "./classifier.js";
import { PREFIX_WORDS, SUB_PLACEHOLDER, extractSubstitutions, splitSimpleCommands, } from "./parse.js";
/** 单引号包裹标记：内容按字面量处理，不做变量展开（shell 语义） */
const LITERAL_MARK = "\u0001";
/** mktemp 产物占位：具体路径运行时才产生，静态不可知但确定在临时目录 */
const MKTEMP_MARK = "\u0002";
/** 去引号：双引号只删引号符（替换体已抽出、变量仍会展开）；单引号内容标记为字面量 */
function dequote(view) {
    let out = "";
    let i = 0;
    while (i < view.length) {
        const ch = view[i];
        if (ch === "'") {
            const j = view.indexOf("'", i + 1);
            const end = j === -1 ? view.length : j;
            out += LITERAL_MARK + view.slice(i + 1, end) + LITERAL_MARK;
            i = end + 1;
            continue;
        }
        if (ch === '"') {
            i++;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}
function tokenize(segment) {
    return segment
        .split(/\s+/)
        .filter(Boolean)
        .map((raw) => ({
        text: raw.replaceAll(LITERAL_MARK, ""),
        literal: raw.includes(LITERAL_MARK),
    }));
}
const isAssignment = (t) => !t.literal && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text);
/** 命令词 token 下标：跳过赋值前缀与 sudo/env 等修饰词（token 空间，与 parse.commandWordAt 同语义） */
function commandWordTokenIndex(tokens) {
    let i = 0;
    while (i < tokens.length) {
        const t = tokens[i];
        if (isAssignment(t) || (!t.literal && PREFIX_WORDS.has(t.text))) {
            i++;
            continue;
        }
        return i;
    }
    return -1;
}
/** mktemp 执行体分析：有模板参数时模板目录必须在沙箱内，缺省模板在 TMPDIR（沙箱） */
function analyzeMktemp(body, opts) {
    const tokens = body.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return { kind: "unknown" };
    const word = tokens[0].split("/").pop() ?? "";
    if (word !== "mktemp")
        return { kind: "unknown" };
    let template;
    for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.startsWith("--tmpdir=")) {
            template = tok.slice("--tmpdir=".length);
            continue;
        }
        if (tok === "--tmpdir" || tok === "-p") {
            template = tokens[i + 1];
            i++;
            continue;
        }
        if (tok.startsWith("-"))
            continue;
        template = tok;
    }
    if (template === undefined)
        return { kind: "mktemp" };
    const expanded = expandRefs({ text: template, literal: false }, new Map(), opts);
    if (expanded.unknown)
        return { kind: "unknown" };
    const idx = expanded.text.lastIndexOf("/");
    const dir = idx === -1 ? opts.cwd : idx === 0 ? "/" : expanded.text.slice(0, idx);
    return isSandboxedPath(normalizePath(dir, opts), opts) ? { kind: "mktemp" } : { kind: "unknown" };
}
/** 展开 ${VAR}/$VAR（含 env）与开头 ~；`\$` 为字面量；未知变量记 unknown */
function expandRefs(token, vars, opts) {
    if (token.literal)
        return { text: token.text, unknown: false, hasMktemp: false };
    const text = token.text;
    let out = "";
    let hasMktemp = false;
    let unknown = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "\\") {
            // 解转义为字面下一字符（shell 语义：\$ 不再触发变量展开，\. 为普通段），末尾孤立 \ 原样保留
            const next = text[i + 1];
            if (next === undefined) {
                out += ch;
                i++;
            }
            else {
                out += next;
                i += 2;
            }
            continue;
        }
        if (ch === "~" && out === "") {
            // `~` 是真实用户 home（不是 HAPILON_HOME），展开后按沙箱前缀判定；
            // `~user` 指向他人 home，静态不可判 → unknown
            const next = text[i + 1];
            if (next === undefined || next === "/") {
                out += homedir();
                i++;
                continue;
            }
            return { text, unknown: true, hasMktemp: false };
        }
        if (ch !== "$") {
            out += ch;
            i++;
            continue;
        }
        const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(text.slice(i));
        const plain = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
        const name = braced?.[1] ?? plain?.[1];
        if (!name) {
            out += ch;
            i++;
            continue;
        }
        i += braced ? braced[0].length : plain[0].length;
        const known = vars.get(name);
        if (known) {
            if (known.kind === "mktemp") {
                hasMktemp = true;
                out += MKTEMP_MARK;
            }
            else if (known.path !== undefined) {
                out += known.path;
            }
            else {
                unknown = true;
            }
            continue;
        }
        const env = process.env[name];
        if (env !== undefined && env.length > 0) {
            out += env;
            continue;
        }
        unknown = true;
        out += `$${name}`;
    }
    return { text: out, unknown, hasMktemp };
}
/** 词法归一（解析 . / .. 段，相对路径挂 cwd），不追符号链接 */
function normalizePath(path, opts) {
    const abs = isAbsolute(path) ? path : join(opts.cwd, path);
    const parts = [];
    for (const seg of abs.split("/")) {
        if (seg === "" || seg === ".")
            continue;
        if (seg === "..") {
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return "/" + parts.join("/");
}
function isSandboxedPath(path, opts) {
    if (path === "/dev/null")
        return true;
    if (!path.startsWith("/"))
        return false;
    const roots = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", opts.home];
    if (opts.home.startsWith("/tmp") || opts.home.startsWith("/var/")) {
        roots.push(`/private${opts.home}`);
    }
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
function resolveTargetToken(token, vars, opts) {
    if (token.text.includes(SUB_PLACEHOLDER)) {
        return { raw: token.text, resolved: token.text, sandboxed: false, note: "目标含命令替换，静态不可解析" };
    }
    const expanded = expandRefs(token, vars, opts);
    if (expanded.unknown) {
        return { raw: token.text, resolved: expanded.text, sandboxed: false, note: "存在无法静态解析的变量" };
    }
    if (expanded.text === "") {
        return { raw: token.text, resolved: "", sandboxed: false, note: "目标为空" };
    }
    if (expanded.hasMktemp) {
        // mktemp 产物是运行时路径：仅当占位在路径开头（$SMOKE、$SMOKE/x）才可静态判定落在临时目录，
        // 非开头拼接（/etc/$SMOKE）无此保证；含 .. 段同理无法保证不逃逸。
        // 逃逸检查必须在展开后的原始文本上按段做——normalizePath 会把 .. 段消耗掉，查归一结果恒为无 ..
        const escaped = !expanded.text.startsWith(MKTEMP_MARK) || expanded.text.split("/").includes("..");
        return {
            raw: token.text,
            resolved: "(mktemp)",
            sandboxed: !escaped,
            note: escaped ? "mktemp 产物路径非占位开头或含 .. 段" : undefined,
        };
    }
    const normalized = normalizePath(expanded.text, opts);
    return {
        raw: token.text,
        resolved: normalized,
        sandboxed: isSandboxedPath(normalized, opts),
    };
}
/** 是否破坏性命令词（sed 仅在 -i 就地改写时算） */
function destructiveWord(word, rest) {
    if (word === "rm" || word === "chmod" || word === "chown")
        return true;
    return word === "sed" && rest.some((t) => !t.literal && t.text.startsWith("-i"));
}
/** 单个简单命令的写目标（破坏性命令词的操作数 + 重定向目标） */
function segmentTargets(tokens) {
    const targets = [];
    const wordIdx = commandWordTokenIndex(tokens);
    if (wordIdx >= 0) {
        const word = tokens[wordIdx].text;
        const rest = tokens.slice(wordIdx + 1);
        if (destructiveWord(word, rest)) {
            if (word === "sed") {
                // sed：非 flag 操作数全量枚举校验，首个是 script 表达式；多文件写法逐文件检查，只查段末会漏检中间文件
                let skipScript = true;
                let dashDash = false;
                for (const t of rest) {
                    if (!dashDash && t.text === "--") {
                        dashDash = true;
                        continue;
                    }
                    if (!dashDash && !t.literal && t.text.startsWith("-") && t.text.length > 1)
                        continue;
                    if (t.text === "")
                        continue; // macOS `sed -i ""` 的空备份后缀不是文件目标
                    if (skipScript) {
                        skipScript = false;
                        continue;
                    }
                    targets.push(t);
                }
            }
            else {
                // rm：非 flag 即目标（`--` 后全是目标）；chmod/chown：跳过首个操作数（mode/owner）
                let skipMode = word !== "rm";
                let dashDash = false;
                for (const t of rest) {
                    if (!dashDash && t.text === "--") {
                        dashDash = true;
                        skipMode = false;
                        continue;
                    }
                    if (!dashDash && !t.literal && t.text.startsWith("-") && t.text.length > 1)
                        continue;
                    if (skipMode) {
                        skipMode = false;
                        continue;
                    }
                    targets.push(t);
                }
            }
        }
    }
    // 重定向目标：> >> 2> &> 独立 token 或 `>/path` 连写；`<<`（heredoc）与 fd 复制（>&2）不算
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.literal)
            continue;
        if (/^(1|2|&)?>>?$/.test(t.text)) {
            const next = tokens[i + 1];
            if (next && !next.text.startsWith("&"))
                targets.push(next);
            continue;
        }
        const glued = /^(?:1|2|&)?>>?(?!<)(.+)$/.exec(t.text);
        if (glued && !glued[1].startsWith("&"))
            targets.push({ text: glued[1], literal: false });
    }
    return targets;
}
/**
 * 沙箱写判定：命令含破坏性命令词、存在写目标，且全部目标落在沙箱路径集。
 * 纯重定向（无 rm/sed -i/chmod/chown）不放行——语义型危险（git push 等）交给模型层。
 */
export function checkSandboxWrite(command, opts) {
    const { view, bodies } = extractSubstitutions(normalizeForInspection(command));
    const segments = splitSimpleCommands(dequote(view));
    const vars = new Map();
    let bodyIndex = 0;
    let hasDestructive = false;
    const rawTargets = [];
    for (const segment of segments) {
        const tokens = tokenize(segment);
        // xargs 的实际操作数运行时经 stdin 注入、静态不可见——任何段含 xargs 一律不放行。
        // 按 basename 匹配且不豁免引号 token：/usr/bin/xargs、'xargs' 等拼写形态同样拦截（误伤方向为 fail-closed）
        if (tokens.some((t) => t.text.split("/").pop() === "xargs")) {
            return { allowed: false, targets: [] };
        }
        let i = 0;
        // 前导赋值：VAR=…（值可为替换占位 / 字面路径 / 引用已有变量）
        for (; i < tokens.length; i++) {
            const t = tokens[i];
            if (!isAssignment(t))
                break;
            const value = t.text.slice(t.text.indexOf("=") + 1);
            const placeholderCount = value.split(SUB_PLACEHOLDER).length - 1;
            if (placeholderCount > 0) {
                bodyIndex += placeholderCount;
                vars.set(t.text.slice(0, t.text.indexOf("=")), placeholderCount === 1 && value === SUB_PLACEHOLDER
                    ? analyzeMktemp(bodies[bodyIndex - 1] ?? "", opts)
                    : { kind: "unknown" });
                continue;
            }
            const name = t.text.slice(0, t.text.indexOf("="));
            if (value === "") {
                vars.set(name, { kind: "unknown" });
                continue;
            }
            // 赋值值里的 ~ shell 会展开（~ 紧跟 = 后）；expandRefs 的 tilde 分支已覆盖
            const expanded = expandRefs({ text: value, literal: t.literal }, vars, opts);
            if (expanded.unknown) {
                vars.set(name, { kind: "unknown" });
            }
            else if (expanded.hasMktemp) {
                vars.set(name, { kind: "mktemp" });
            }
            else {
                vars.set(name, { kind: "path", path: expanded.text });
            }
        }
        // 非赋值位的替换占位也按序消费，保持 bodyIndex 与 bodies 对齐
        for (; i < tokens.length; i++) {
            if (tokens[i].text === SUB_PLACEHOLDER && !tokens[i].literal)
                bodyIndex++;
        }
        const wordIdx = commandWordTokenIndex(tokens);
        const word = wordIdx >= 0 ? tokens[wordIdx].text : "";
        if (destructiveWord(word, tokens.slice(wordIdx + 1)))
            hasDestructive = true;
        rawTargets.push(...segmentTargets(tokens));
    }
    if (!hasDestructive || rawTargets.length === 0) {
        return { allowed: false, targets: [] };
    }
    const seen = new Set();
    const targets = [];
    for (const token of rawTargets) {
        const key = `${token.literal ? "L" : "V"}:${token.text}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        targets.push(resolveTargetToken(token, vars, opts));
    }
    return {
        allowed: targets.every((t) => t.sandboxed),
        targets,
    };
}
