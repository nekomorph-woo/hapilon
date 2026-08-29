import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolveNpmExtensionPaths } from "../../npm-extensions.js";

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
