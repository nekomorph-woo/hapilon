import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNpmExtensionPaths, resolveExtensionEntry } from "../../npm-extensions.js";

describe("resolveNpmExtensionPaths()", () => {
  it("解析出两个 npm 扩展的绝对入口路径", () => {
    const paths = resolveNpmExtensionPaths();
    assert.equal(paths.length, 2);
    for (const p of paths) {
      assert.ok(p.endsWith("dist/index.js"), `入口应以 dist/index.js 结尾: ${p}`);
      assert.ok(existsSync(p), `入口文件应存在: ${p}`);
    }
  });

  it("顺序与声明一致：pi-tasks 在前、pi-subagents 在后", () => {
    const [tasks, subagents] = resolveNpmExtensionPaths();
    assert.ok(tasks.includes("@tintinweb/pi-tasks"), `第一个应是 pi-tasks: ${tasks}`);
    assert.ok(subagents.includes("@tintinweb/pi-subagents"), `第二个应是 pi-subagents: ${subagents}`);
  });
});

describe("resolveExtensionEntry()（fail fast 分支）", () => {
  const okResolve = (id: string) => "/fake/node_modules/" + id.replace("/", "+");

  it("入口文件存在时返回拼接路径（用真实包验证 join 语义）", () => {
    // 从真实安装位置反推 package.json 路径，验证 dirname+join 拼接语义
    const realEntry = resolveNpmExtensionPaths()[0];
    const pkgDir = dirname(dirname(realEntry)); // <pkg>/dist/index.js → <pkg>
    const path = resolveExtensionEntry(
      "@tintinweb/pi-tasks",
      "dist/index.js",
      () => join(pkgDir, "package.json"),
    );
    assert.equal(path, realEntry);
    assert.ok(existsSync(path));
  });

  it("入口文件缺失时抛错且消息含包名与入口", () => {
    assert.throws(
      () => resolveExtensionEntry("@tintinweb/pi-tasks", "dist/index.js", okResolve),
      (err: Error) =>
        err.message.includes("@tintinweb/pi-tasks") &&
        err.message.includes("dist/index.js") &&
        err.message.includes("npm install"),
    );
  });

  it("resolve 抛错（包不存在）时错误向上传播", () => {
    assert.throws(
      () => resolveExtensionEntry("@ghost/pkg", "dist/index.js", () => {
        throw new Error("Cannot find module '@ghost/pkg/package.json'");
      }),
      /Cannot find module/,
    );
  });
});
