import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { Data, Effect } from "effect";
import { classifyPath } from "../hpl-protected-paths/classifier.js";
const BASH_SCRIPT_CALL = /^[ \t]*bash[ \t]+(\.\/[\w.-]+\.sh)[ \t]+([\w./-]+)[ \t]*$/;
const PRIVATE_READ = /^(?:#!\/bin\/bash\n)?[ \t]*IFS=[ \t]+read[ \t]+-r[ \t]+[a-z][a-z0-9_]*[ \t]*<[ \t]*"\$1"[ \t]*&&[ \t]*printf[ \t]+"(?:[\w .:-]|\\n)+"[ \t]*\n?$/;
const MAX_SCRIPT_BYTES = 4096;
class ScriptReadError extends Data.TaggedError("ScriptReadError") {
}
function readScript(path) {
    return Effect.try({
        try: () => {
            const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const file = fstatSync(fd);
                if (!file.isFile() || file.size > MAX_SCRIPT_BYTES)
                    return undefined;
                const bytes = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
                const count = readSync(fd, bytes);
                if (count !== file.size || count > MAX_SCRIPT_BYTES)
                    return undefined;
                return bytes.toString("utf8", 0, count);
            }
            finally {
                closeSync(fd);
            }
        },
        catch: (cause) => new ScriptReadError({ cause }),
    });
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export function preparePrivateScript(command, cwd) {
    if (process.platform !== "darwin" && process.platform !== "linux")
        return undefined;
    const match = BASH_SCRIPT_CALL.exec(command);
    if (!match)
        return undefined;
    const [, script, input] = match;
    if (classifyPath(script, "read", cwd) !== "allow" || classifyPath(input, "read", cwd) !== "confirm")
        return undefined;
    const result = Effect.runSync(Effect.either(readScript(resolve(cwd, script))));
    if (result._tag === "Left" || !result.right || !PRIVATE_READ.test(result.right))
        return undefined;
    // 用检查过的脚本正文执行，避免文件在检查后被替换。清空子 shell 环境，避免加载启动脚本。
    return `/usr/bin/env -i /bin/bash --noprofile --norc -c ${quote(result.right)} ${quote(script)} ${quote(input)}`;
}
