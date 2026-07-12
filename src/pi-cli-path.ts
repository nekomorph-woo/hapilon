import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePiCli(): string {
  const entryUrl = import.meta.resolve(
    "@earendil-works/pi-coding-agent",
  );
  let dir = dirname(fileURLToPath(entryUrl));

  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (
        pkg.name === "@earendil-works/pi-coding-agent" &&
        pkg.bin?.pi
      ) {
        return resolve(dir, pkg.bin.pi);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Cannot locate pi-coding-agent CLI",
      );
    }
    dir = parent;
  }
}
