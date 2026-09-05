#!/usr/bin/env node
import { main } from "./cli/main.js";
try {
    await main();
}
catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Hapilon 运行错误: ${msg}`);
    process.exitCode = 1;
}
