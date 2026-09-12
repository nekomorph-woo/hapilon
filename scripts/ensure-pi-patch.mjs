#!/usr/bin/env node
/**
 * hapilon 主题补丁的 CLI 薄壳：锚点表与全部逻辑都在 src/patch/ensure-pi-patch.ts
 * （编译产物 dist/patch/ensure-pi-patch.js），这里只负责人类可读的一行状态。
 *
 * 手动跑：node scripts/ensure-pi-patch.mjs
 * postinstall 也 import 本文件（顶层即执行，无需再写一份调用）。
 * 永不抛错、永不改退出码：补丁失败只是代码块无底色，不该拖垮安装或启动。
 */
try {
  const { ensurePiPatch, warnIfPiPatchStale } = await import("../dist/patch/ensure-pi-patch.js");
  const result = ensurePiPatch();
  warnIfPiPatchStale(result);
  if (result.kind === "patched") {
    console.log(`[hapilon] pi 主题补丁：已重新应用（${result.files.length} 个文件）`);
  } else if (result.kind === "already-patched") {
    console.log("[hapilon] pi 主题补丁：已补丁，跳过（幂等）");
  }
  // stale / unwritable：警告已由 warnIfPiPatchStale 打出一行；pi-not-found：静默
} catch (error) {
  // 未构建（dist 缺失）不该让 npm install 失败
  console.warn(`⚠ hapilon 主题补丁脚本不可用（先跑 npm run build？）：${error instanceof Error ? error.message : String(error)}`);
}
