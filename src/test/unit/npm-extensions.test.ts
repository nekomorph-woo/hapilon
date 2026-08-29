import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmExtensionPaths, resolveExtensionEntry } from "../../npm-extensions.js";

describe("resolveNpmExtensionPaths()", () => {
  it("解析出全部 npm 扩展的绝对入口路径", () => {
    const paths = resolveNpmExtensionPaths();
    // 2 个 tintinweb 包 + #43 集成四包 + #49 pi-mcp-adapter
    assert.equal(paths.length, 7);
    for (const p of paths) {
      assert.ok(existsSync(p), `入口文件应存在: ${p}`);
    }
  });

  it("顺序与声明一致：pi-tasks 在前、pi-subagents 在后", () => {
    const [tasks, subagents] = resolveNpmExtensionPaths();
    assert.ok(tasks.includes("@tintinweb/pi-tasks"), `第一个应是 pi-tasks: ${tasks}`);
    assert.ok(subagents.includes("@tintinweb/pi-subagents"), `第二个应是 pi-subagents: ${subagents}`);
  });

  it("#43 四包入口与各自 pi.extensions 声明一致", () => {
    const [, , fff, askUser, btw, webAccess] = resolveNpmExtensionPaths();
    assert.ok(fff.endsWith("@ff-labs/pi-fff/src/index.ts"), `fff: ${fff}`);
    assert.ok(askUser.endsWith("@zhushanwen/pi-ask-user/index.ts"), `ask-user: ${askUser}`);
    assert.ok(btw.endsWith("@narumitw/pi-btw/dist/index.ts"), `btw: ${btw}`);
    assert.ok(webAccess.endsWith("pi-web-access/index.ts"), `web-access: ${webAccess}`);
  });

  it("#49 pi-mcp-adapter 入口与包内 pi.extensions 声明一致", () => {
    const paths = resolveNpmExtensionPaths();
    const adapter = paths[paths.length - 1];
    assert.ok(adapter.endsWith("pi-mcp-adapter/index.ts"), `mcp-adapter: ${adapter}`);
  });

  it("#49 hapilon package.json 未设 piConfig（adapter getAgentDir 依赖此前提）", () => {
    // pi-mcp-adapter 的 agent-dir.ts：若 PI_PACKAGE_DIR manifest 设了 piConfig.name，
    // 它会改找 `${NAME}_CODING_AGENT_DIR`。hapilon 靠 PI_CODING_AGENT_DIR 精确寻址，
    // 一旦未来设置 piConfig.name 而未同步导出新 env var，配置寻址会静默偏移。
    // 此测试把该前提钉死——改名时此处先红，逼实现者同步处理。
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf8"),
    ) as { piConfig?: { name?: string } };
    assert.equal(pkg.piConfig, undefined, "package.json 出现 piConfig 时必须同步处理 pi-mcp-adapter 的 getAgentDir 寻址（见 issue #49）");
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

  it("#49 exports 锁死 package.json 时降级为包主入口寻址", () => {
    // pi-mcp-adapter 的 exports 不含 ./package.json——主路径抛
    // ERR_PACKAGE_PATH_NOT_EXPORTED，应降级到 resolve(包名) 再拼接。
    // 用真实临时文件验证 existsSync 语义（入口必须真实存在）。
    const tmp = mkdtempSync(join(tmpdir(), "hapilon-entry-fallback-"));
    try {
      const mainEntry = join(tmp, "index.ts");
      writeFileSync(mainEntry, "export {};");
      const resolve = (id: string) => {
        if (id === "pi-mcp-adapter/package.json") {
          const err = new Error(`Package subpath './package.json' is not defined by "exports"`) as Error & { code: string };
          err.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
          throw err;
        }
        return mainEntry;
      };
      const path = resolveExtensionEntry("pi-mcp-adapter", "index.ts", resolve);
      assert.equal(path, mainEntry, "降级后从主入口目录拼出同一入口");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("#49 非 exports 锁定的 resolve 错误（包不存在）不降级、向上传播", () => {
    assert.throws(
      () =>
        resolveExtensionEntry("pi-mcp-adapter", "index.ts", () => {
          const err = new Error("Cannot find module 'pi-mcp-adapter/package.json'") as Error & { code: string };
          err.code = "MODULE_NOT_FOUND";
          throw err;
        }),
      /Cannot find module/,
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
