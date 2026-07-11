#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

console.log("hapilon_v0.1.0_alpha");

function resolvePiCli(): string {
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

function main(): void {
  const piCli = resolvePiCli();
  const forwarded = process.argv.slice(2);
  const child = spawn(
    process.execPath,
    [piCli, ...forwarded],
    { stdio: "inherit", cwd: process.cwd() },
  );

  child.on("error", (err) => {
    console.error(`Failed to start Hapilon: ${err.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

try {
  main();
} catch (err) {
  const msg =
    err instanceof Error ? err.message : String(err);
  console.error(`Hapilon startup failed: ${msg}`);
  process.exitCode = 1;
}
