/**
 * 内置扩展全集加载 smoke。
 *
 * 走 pi 真实的 resource loader（与 `node dist/cli.js` 同一条路径），加载 dist/extensions
 * 下全部内置扩展到临时 agentDir/cwd，捕获三类只在真实加载时才会暴露的问题：
 *   - 重复 flag/tool：loader 报错，启动直接失败（R1 里 reviewer pane 起不来的原因）；
 *   - 重复 command：loader 不报错，只把重名命令静默改成 `name:1`，用户点不到原命令；
 *   - 扩展入口缺失/加载失败：errors 非空。
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { discoverExtensions } from "../../extensions/loader.js";

describe("内置扩展全集加载", () => {
  let cwd: string;
  let agentDir: string;
  let paths: string[] = [];
  let result: LoadExtensionsResult;

  before(async () => {
    paths = discoverExtensions();
    cwd = mkdtempSync(join(tmpdir(), "hapilon-ext-smoke-"));
    agentDir = mkdtempSync(join(tmpdir(), "hapilon-ext-smoke-agent-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: paths,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    result = loader.getExtensions();
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("发现的扩展全部加载成功，零注册冲突", () => {
    assert.ok(paths.length > 0, "dist/extensions 下没发现任何扩展，测试失去意义");
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, paths.length);
  });

  it("同名 command / flag 只由一个扩展注册", () => {
    const duplicates: string[] = [];
    for (const kind of ["command", "flag"] as const) {
      const owners = new Map<string, string>();
      for (const ext of result.extensions) {
        const names = kind === "command" ? ext.commands.keys() : ext.flags.keys();
        for (const name of names) {
          const owner = owners.get(name);
          if (owner && owner !== ext.path) duplicates.push(`${kind} ${name}: ${owner} + ${ext.path}`);
          else owners.set(name, ext.path);
        }
      }
    }
    assert.deepEqual(duplicates, []);
  });

  it("关键扩展确实在加载集合里", () => {
    const loaded = result.extensions.map((ext) => ext.path);
    for (const name of ["hpl-model-tiers", "hpl-orchestra", "hpl-quota-usage"]) {
      assert.ok(
        loaded.some((path) => path.endsWith(join(name, "index.js"))),
        `${name} 未加载`,
      );
    }
  });
});
