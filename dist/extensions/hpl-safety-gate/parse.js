/**
 * parse.ts — 危险命令检测的结构化视图
 *
 * 纯字符串处理，把一条 shell 命令拆成规则需要的几个视图：
 *   - stripQuotedText    : 引号内容置空（搜索词/文件名/提交信息不参与规则匹配）
 *   - extractSubstitutions: 抽出 $(...)/`...`/<(...)/>(...) 的执行体并置占位符
 *   - splitSimpleCommands : 按 ; && || | 换行 与括号切分为简单命令
 *   - commandWord        : 简单命令的命令词（跳过 sudo/env/VAR= 等前缀）
 *   - matchInCommandPosition: 规则命中是否落在命令词区（而非某个参数里）
 *
 * 动机：规则此前对整条命令做正则匹配，导致 `grep -n "shutdown" file` 被判
 * 「关机命令」、`grep -rn "git push" README.md` 被判「git push」等假阳性。
 */
/** 只做修饰、不构成危险操作自身的命令前缀 */
const PREFIX_WORDS = new Set([
    "sudo", "doas", "command", "builtin", "env", "time", "nohup",
    "nice", "ionice", "stdbuf", "exec", "xargs",
]);
/** 引号内容置为等长占位（保留 token 边界，避免相邻词粘连） */
export function stripQuotedText(command) {
    let out = "";
    let i = 0;
    while (i < command.length) {
        const ch = command[i];
        if (ch === "'") {
            const start = i;
            i++;
            while (i < command.length && command[i] !== "'")
                i++;
            i++; // 吃掉收尾单引号
            out += " ".repeat(Math.max(1, i - start));
            continue;
        }
        if (ch === "\"") {
            const start = i;
            i++;
            while (i < command.length) {
                if (command[i] === "\\") {
                    i += 2;
                    continue;
                }
                if (command[i] === "\"")
                    break;
                i++;
            }
            i++;
            out += " ".repeat(Math.max(1, i - start));
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}
export const SUB_PLACEHOLDER = "__HAPI_SUBST__";
/** 抽出命令替换/进程替换的执行体，原位替换为占位符 */
export function extractSubstitutions(command) {
    const bodies = [];
    let out = "";
    let i = 0;
    while (i < command.length) {
        const ch = command[i];
        // $(...) —— 支持嵌套括号
        if (ch === "$" && command[i + 1] === "(") {
            let depth = 0;
            let j = i + 1;
            for (; j < command.length; j++) {
                if (command[j] === "(")
                    depth++;
                else if (command[j] === ")") {
                    depth--;
                    if (depth === 0)
                        break;
                }
            }
            bodies.push(command.slice(i + 2, j));
            out += SUB_PLACEHOLDER;
            i = j + 1;
            continue;
        }
        // `...`
        if (ch === "`") {
            const j = command.indexOf("`", i + 1);
            const end = j === -1 ? command.length : j;
            bodies.push(command.slice(i + 1, end));
            out += SUB_PLACEHOLDER;
            i = end + 1;
            continue;
        }
        // <(...) / >(...)
        if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
            let depth = 0;
            let j = i + 1;
            for (; j < command.length; j++) {
                if (command[j] === "(")
                    depth++;
                else if (command[j] === ")") {
                    depth--;
                    if (depth === 0)
                        break;
                }
            }
            bodies.push(command.slice(i + 2, j));
            out += " " + SUB_PLACEHOLDER;
            i = j + 1;
            continue;
        }
        out += ch;
        i++;
    }
    return { view: out, bodies };
}
/** 按 ; && || | 换行 与括号切分为简单命令（引号已在视图阶段置空） */
export function splitSimpleCommands(view) {
    return view
        .replace(/&&|\|\||[;|()\n\r]|&/g, "\u0000")
        .split("\u0000")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
/** 剥离 `VAR=value` 赋值与修饰前缀，返回命令词与其起始下标 */
export function commandWordAt(simpleCommand) {
    let offset = 0;
    let rest = simpleCommand;
    for (;;) {
        const m = /^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest);
        if (!m)
            break;
        offset += m[0].length;
        rest = rest.slice(m[0].length);
    }
    for (;;) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s+/.exec(rest);
        if (!m || !PREFIX_WORDS.has(m[1]))
            break;
        offset += m[0].length;
        rest = rest.slice(m[0].length);
    }
    const m = /^\s*(\S+)/.exec(rest);
    if (!m)
        return { word: "", index: simpleCommand.length };
    return { word: m[1], index: offset + m[0].length - m[1].length };
}
/**
 * 抽出 shell 脚本载荷：`sh -c "<脚本>"`（含 bash/zsh/dash/ksh）与 `eval "<串>"`。
 * 引号内容在规则视图里已被置空，故这里单独把它们取出来递归分类——
 * 保证 `sh -c "shutdown -h now"` 这类仍被拦住。
 */
export function extractShellPayloads(command) {
    const payloads = [];
    const shellC = /\b(?:ba|z|k|da|a)?sh\s+-c\s+(['"])([\s\S]*?)\1/g;
    for (const m of command.matchAll(shellC)) {
        if (m[2])
            payloads.push(m[2]);
    }
    const evalArg = /\beval\s+(['"])([\s\S]*?)\1/g;
    for (const m of command.matchAll(evalArg)) {
        if (m[2])
            payloads.push(m[2]);
    }
    return payloads;
}
/** 命令替换是否出现在破坏性目标位（rm -rf / dd of= / chmod|chown -R 的参数） */
export function substitutionInDestructiveTarget(subView) {
    const sub = SUB_PLACEHOLDER;
    return (new RegExp(`\\brm\\s+-rf\\b[^\\n]*?["']?\\s*${sub}`).test(subView) ||
        new RegExp(`\\bdd\\b[^\\n]*\\bof=["']?\\s*${sub}`).test(subView) ||
        new RegExp(`\\bch(?:mod|own)\\s+-R\\b[^\\n]*?["']?\\s*${sub}`).test(subView));
}
