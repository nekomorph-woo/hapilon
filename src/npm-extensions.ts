import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * npm 扩展接线（#37）：
 *
 * hapilon 通过 `-e` 把 node_modules 里的第三方 pi 扩展注入 pi 内核，
 * 与 hpl-* 内置扩展同一加载通道。不走 `pi install`——那会写
 * `~/.hapilon/settings.json` 的 packages，导致 subagent session 重新发现
 * 并激活这些扩展（pi-subagents 明确要求 subagent 不激活自身）。
 *
 * 入口解析用 createRequire 从 hapilon 自身安装位置出发（不依赖 cwd），
 * 这样用户在任意目录启动 hapilon 都能找到正确版本的扩展。
 */

/** 纳入 hapilon 的第三方扩展（npm 包名 → 包内扩展入口） */
const NPM_EXTENSIONS: readonly [pkg: string, entry: string][] = [
  ["@tintinweb/pi-tasks", "dist/index.js"],
  ["@tintinweb/pi-subagents", "dist/index.js"],
];

/**
 * 解析单个包的扩展入口（导出仅为可测试性）。
 * resolve 返回 undefined 表示包不存在——由调用方决定如何爆。
 */
export function resolveExtensionEntry(
  pkg: string,
  entry: string,
  resolve: (id: string) => string,
): string {
  const pkgJsonPath = resolve(`${pkg}/package.json`);
  const path = join(dirname(pkgJsonPath), entry);
  if (!existsSync(path)) {
    throw new Error(
      `[hapilon] npm 扩展入口缺失：${pkg} 应有 ${entry}，实际路径 ${path} 不存在。` +
        `请重新 npm install，或检查 ${pkg} 的版本（pi.extensions 布局可能已变更）。`,
    );
  }
  return path;
}

/**
 * 解析所有 npm 扩展的绝对入口路径。
 *
 * 包缺失时 fail fast：直接抛错而不是静默跳过——扩展是声明式依赖，
 * 缺了就是安装损坏，应该立刻爆出来（原则：Errors Never Pass Silently）。
 *
 * @returns 入口绝对路径数组（与 NPM_EXTENSIONS 声明顺序一致）
 */
export function resolveNpmExtensionPaths(): string[] {
  // 从本模块位置解析（dist/npm-extensions.js），锚定 hapilon 的 node_modules
  const require = createRequire(import.meta.url);
  return NPM_EXTENSIONS.map(([pkg, entry]) =>
    resolveExtensionEntry(pkg, entry, (id) => require.resolve(id)),
  );
}
