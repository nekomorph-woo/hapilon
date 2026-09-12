#!/usr/bin/env node
/**
 * postinstall — Windows 沙箱轻量预检 + pi 主题补丁
 *
 * 沙箱部分：只检测、不安装、零 UAC，失败静默退出——绝不让 npm install 报错。
 * 主题部分：交给 scripts/ensure-pi-patch.mjs 自补丁器（pi 的 dist 有代码块底色
 * 才有 mdCodeBlockBg，见 src/patch/ensure-pi-patch.ts）。它自带“升级就只警告”的
 * 韧性，因此不需要 patch-package，也不需要 devDeps——tarball/全局安装同样跑得通。
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

// 主题自补丁：内部永不抛错（锚点失配只警告），import 即执行
await import("./ensure-pi-patch.mjs");

main();
