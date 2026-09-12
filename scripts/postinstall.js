#!/usr/bin/env node
/**
 * postinstall — Windows 沙箱轻量预检
 *
 * 只检测、不安装、零 UAC：Windows 上提示沙箱可用与首次启用的装机路径。
 * 任何失败都静默退出——postinstall 绝不让 npm install 报错。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

function main() {
  try {
    if (process.platform !== "win32") return;

    const srtWin = join(
      process.cwd(), "node_modules", "@anthropic-ai", "sandbox-runtime",
      "vendor", "srt-win", process.arch === "arm64" ? "arm64" : "x64", "srt-win.exe",
    );
    // 全局安装（npm i -g）时 process.cwd() 不是包目录；存在性检查尽力而为
    const found = existsSync(srtWin) || existsSync(
      join(process.execPath, "..", "..", "node_modules", "@anthropic-ai", "sandbox-runtime",
        "vendor", "srt-win", process.arch === "arm64" ? "arm64" : "x64", "srt-win.exe"),
    );

    console.log("");
    console.log("  hapilon Windows 沙箱预检：");
    console.log(
      found
        ? "  ✔ srt-win helper 就绪（随依赖分发）"
        : "  ⚠ 未定位到 srt-win helper（不影响普通使用）",
    );
    console.log("  沙箱默认关闭。首次 `hapi --sandbox` 时会引导一次性装机（需一次 UAC 授权）。");
    console.log("  也可提前执行：hapi --sandbox --setup-windows");
    console.log("");
  } catch {
    // 预检失败不影响安装
  }
}

main();
