#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── Command routing ──────────────────────────────────────────────

  const command = args[0];

  if (command === "setup") {
    const isQuick =
      args.includes("--quick") || args.includes("-q");
    const mod = await import("./setup.js");
    if (isQuick) {
      mod.setupQuick();
    } else {
      await mod.setupInteractive();
    }
    return;
  }

  if (command === "doctor") {
    const mod = await import("./setup.js");
    mod.doctor();
    return;
  }

  // ── Default: launch pi ───────────────────────────────────────────

  console.log("hapilon_v0.1.0_alpha");

  const piCli = resolvePiCli();
  const { hapilonHome } = await import(
    "./hapilon-home.js"
  );
  const home = hapilonHome();
  const agentDir = join(home, "agent");

  if (!existsSync(agentDir)) {
    console.warn(
      "~/.hapilon/ not configured. Run `hapilon setup` to configure providers.",
    );
  }

  const child = spawn(
    process.execPath,
    [piCli, ...args],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
      },
    },
  );

  child.on("error", (err) => {
    console.error(
      `Failed to start Hapilon: ${err.message}`,
    );
    process.exitCode = 1;
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

try {
  await main();
} catch (err) {
  const msg =
    err instanceof Error ? err.message : String(err);
  console.error(`Hapilon startup failed: ${msg}`);
  process.exitCode = 1;
}
