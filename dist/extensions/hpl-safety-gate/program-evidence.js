import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { Data, Effect } from "effect";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveTarget } from "../hpl-protected-paths/classifier.js";
import { READ_CONFIRM } from "../hpl-protected-paths/rules.js";
const INTERPRETERS = new Set(["bash", "sh", "zsh", "node", "python", "python3", "ruby", "perl"]);
const KNOWN_WORDS = new Set([
    "if", "then", "fi", "else", "elif", "for", "in", "do", "done", "while", "return", "exit",
    "case", "esac", "function", "def", "import", "from", "const", "let", "await", "with", "as",
    "IFS", "read", "cat", "printf", "echo", "exec", "source", "export", "open", "print", "console", "log",
    "argv", "sys", "process", "fs", "readFile", "readFileSync", "writeFile", "stdout", "stderr",
]);
const NATIVE_SYMBOLS = ["open", "fopen", "read", "fread", "fgetc", "fclose", "write", "fwrite", "printf", "fprintf", "puts", "send", "connect", "execve"];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 12 * 1024;
class ProgramReadError extends Data.TaggedError("ProgramReadError") {
}
function readProgram(path, sensitivePaths) {
    return Effect.try({
        try: () => {
            const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const file = fstatSync(fd, { bigint: true });
                if (!file.isFile() || file.size === 0n || file.size > BigInt(MAX_FILE_BYTES))
                    return undefined;
                if (sensitivePaths.some(target => {
                    const input = statSync(target, { bigint: true, throwIfNoEntry: false });
                    return input?.dev === file.dev && input.ino === file.ino;
                }))
                    return undefined;
                const bytes = Buffer.alloc(Number(file.size));
                return readSync(fd, bytes) === bytes.length ? bytes : undefined;
            }
            finally {
                closeSync(fd);
            }
        },
        catch: (cause) => new ProgramReadError({ cause }),
    });
}
function sourceOutline(source) {
    const names = new Map();
    // 只输出分析词表、参数位置和结构符号，不把源码里的值或注释交给模型。
    return source.replace(/(?:'[^'\n]*'|"(?:\\.|[^"\\\n])*"|`[^`]*`)|(?:#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|\$[1-9][0-9]?\b|[A-Za-z_][\w]*|\d+|[^\s<>=|&()[\]{};:.,+$!-]/g, (token) => {
        if (/^\$(?:[1-9]\d?)$/.test(token))
            return token;
        const positional = /^"(\$[1-9]\d?)"$/.exec(token);
        if (positional)
            return positional[1];
        if (KNOWN_WORDS.has(token))
            return token;
        if (!/^[A-Za-z_][\w]*$/.test(token))
            return "<?>";
        const name = names.get(token) ?? `id${names.size + 1}`;
        names.set(token, name);
        return name;
    });
}
function isNativeBinary(bytes) {
    const magic = bytes.subarray(0, 4).toString("hex");
    return ["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic);
}
export function collectProgramEvidence(command, cwd) {
    if (process.platform === "win32" || !/^[\w./ \t-]+$/.test(command) || command.endsWith("\n"))
        return Effect.succeed(undefined);
    const [word, ...args] = command.trim().split(/[ \t]+/);
    const interpreter = INTERPRETERS.has(word) ? word : undefined;
    const program = interpreter ? args.shift() : word;
    if (!program || (interpreter ? program.startsWith("-") : !program.includes("/")))
        return Effect.succeed(undefined);
    const isProtected = (path) => READ_CONFIRM.some(rule => rule.test(path));
    const sensitive = args.flatMap((arg, index) => {
        const path = resolveTarget(arg, cwd);
        return isProtected(path) ? [{ path, position: index + 1 }] : [];
    });
    const programPath = resolveTarget(program, cwd);
    const fromWorkspace = relative(resolveTarget(cwd, cwd), programPath);
    if (sensitive.length === 0 || isAbsolute(fromWorkspace) || fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`)
        || isProtected(resolve(cwd, program)) || isProtected(programPath))
        return Effect.succeed(undefined);
    const invocation = `${interpreter ?? "直接执行"}；敏感路径参数位置（程序名后从 1 开始）：${sensitive.map(({ position }) => position).join("、")}`;
    return readProgram(programPath, sensitive.map(({ path }) => path)).pipe(Effect.map((bytes) => {
        if (!bytes)
            return undefined;
        if (!interpreter && isNativeBinary(bytes)) {
            const symbols = NATIVE_SYMBOLS.filter(name => bytes.includes(`\0${name}\0`) || bytes.includes(`\0_${name}\0`));
            return { invocation, kind: "binary", summary: `ELF/Mach-O 文件中的已知符号字节特征（不代表调用或数据流）：${symbols.join("、") || "无"}` };
        }
        if (bytes.length > MAX_SOURCE_BYTES || bytes.includes(0))
            return undefined;
        const source = bytes.toString("utf8");
        if ((!interpreter && !source.startsWith("#!")) || source.includes("\uFFFD"))
            return undefined;
        return { invocation, kind: "script", summary: sourceOutline(source) };
    }));
}
