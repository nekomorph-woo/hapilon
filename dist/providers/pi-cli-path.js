import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
export class PiCliNotFoundError extends Data.TaggedError("PiCliNotFoundError") {
}
function findPiCli() {
    const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    let dir = dirname(fileURLToPath(entryUrl));
    while (true) {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
            if (pkg.name === "@earendil-works/pi-coding-agent" &&
                pkg.bin?.pi) {
                return resolve(dir, pkg.bin.pi);
            }
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}
export const resolvePiCliEffect = Effect.gen(function* () {
    const path = yield* Effect.sync(findPiCli);
    if (path === undefined) {
        return yield* Effect.fail(new PiCliNotFoundError({ message: "Cannot locate pi-coding-agent CLI" }));
    }
    return path;
});
export function resolvePiCli() {
    const result = Effect.runSync(Effect.either(resolvePiCliEffect));
    if (result._tag === "Left") {
        throw new Error(result.left.message);
    }
    return result.right;
}
