import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 扫描扩展目录，返回所有扩展入口文件的绝对路径。
 *
 * 发现规则（与 Pi 内置一致）：
 *   - extensions/*.js              → 单文件扩展
 *   - extensions/<name>/index.js   → 多文件扩展
 *
 * @param dir 扩展目录路径。默认 `dist/extensions/`（相对于当前模块位置）
 * @returns 排序后的扩展入口文件绝对路径数组；目录不存在则返回 []
 */
export function discoverExtensions(dir?: string): string[] {
  const extDir =
    dir ?? join(dirname(fileURLToPath(import.meta.url)), "extensions");

  if (!existsSync(extDir)) return [];

  const entries = readdirSync(extDir).sort();
  const extensions: string[] = [];

  for (const entry of entries) {
    // 跳过隐藏文件和 .gitkeep
    if (entry.startsWith(".")) continue;

    const fullPath = join(extDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      const indexPath = join(fullPath, "index.js");
      if (existsSync(indexPath)) {
        extensions.push(indexPath);
      }
    } else if (stat.isFile() && entry.endsWith(".js")) {
      extensions.push(fullPath);
    }
  }

  return extensions;
}

/**
 * 从扩展文件路径列表中提取人类可读的扩展名。
 *
 * - `<dir>/index.js` → 取目录名
 * - `<name>.js`      → 取文件名（去 .js 后缀）
 *
 * 用于在启动 header 中展示已加载的扩展列表。
 */
export function extensionNames(paths: string[]): string[] {
  return paths.map((p) => {
    const name = basename(p);
    if (name === "index.js") {
      return basename(dirname(p));
    }
    return name.replace(/\.js$/, "");
  });
}
