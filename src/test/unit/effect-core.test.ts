import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ensureHapilonDirsEffect, hapilonHome, hapilonHomeEffect } from "../../config/hapilon-home.js";
import { readHapilonConfigEffect, writeHapilonConfigEffect } from "../../config/config-io.js";
import { resolvePiCliEffect } from "../../providers/pi-cli-path.js";
import {
  ensureQuietStartupEffect,
  writeAuthFileNativeEffect,
  writeSkeletonFilesEffect,
} from "../../providers/providers.js";
import { ensureExtensionConfigsEffect } from "../../extensions/ensure-configs.js";
import { removeSafetyExtensionsEffect } from "../../safety/safety-settings.js";
import { bwrapInstalledEffect } from "../../safety/sandbox.js";
import { addMcpServer, addMcpServerEffect, McpConfigError, loadMcpServersEffect } from "../../mcp/config-store.js";

describe("Effect 核心 API", () => {
  let tmpBase: string;
  const originalEnv = process.env.HAPILON_HOME;

  before(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "hapilon-effect-core-"));
    process.env.HAPILON_HOME = tmpBase;
  });

  after(() => {
    if (originalEnv !== undefined) {
      process.env.HAPILON_HOME = originalEnv;
    } else {
      delete process.env.HAPILON_HOME;
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("hapilonHomeEffect 与同步版返回一致", () => {
    assert.equal(Effect.runSync(hapilonHomeEffect), hapilonHome());
  });

  it("相对路径通过 Effect.runSyncExit 失败并保留错误信息", () => {
    process.env.HAPILON_HOME = "relative/path";
    const exit = Effect.runSyncExit(hapilonHomeEffect);
    assert.equal(exit._tag, "Failure");
    assert.match(String(exit), /必须是绝对路径/);
    process.env.HAPILON_HOME = tmpBase;
  });

  it("坏 JSON 的 readHapilonConfigEffect 返回空配置且不失败", () => {
    process.env.HAPILON_HOME = tmpBase;
    writeFileSync(join(tmpBase, "config.json"), "not valid json\n");
    const exit = Effect.runSyncExit(readHapilonConfigEffect);
    assert.equal(exit._tag, "Success");
    assert.deepEqual(Effect.runSync(readHapilonConfigEffect), {});
  });

  it("writeHapilonConfigEffect 失败走 Fail 通道且可被 catchTag 捕获", () => {
    const blocked = join(tmpBase, "blocked");
    writeFileSync(blocked, "file");
    process.env.HAPILON_HOME = blocked;

    const exit = Effect.runSyncExit(writeHapilonConfigEffect({}));
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");

    const caught = Effect.runSync(
      writeHapilonConfigEffect({}).pipe(
        Effect.catchTag("ConfigWriteError", () => Effect.succeed("caught")),
      ),
    );
    assert.equal(caught, "caught");
    process.env.HAPILON_HOME = tmpBase;
  });

  it("ensureHapilonDirsEffect 失败走 Fail 通道且可被 catchTag 捕获", () => {
    const blocked = join(tmpBase, "blocked-dir");
    writeFileSync(blocked, "file");
    process.env.HAPILON_HOME = blocked;

    const exit = Effect.runSyncExit(ensureHapilonDirsEffect);
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");

    const caught = Effect.runSync(
      ensureHapilonDirsEffect.pipe(
        Effect.catchTag("HapilonHomeError", () => Effect.succeed("caught")),
      ),
    );
    assert.equal(caught, "caught");
    process.env.HAPILON_HOME = tmpBase;
  });

  it("providers 的写入 Effects 失败走 AuthWriteError Fail 通道", () => {
    const blocked = join(tmpBase, "blocked-provider");
    writeFileSync(blocked, "file");
    const effects = [
      writeAuthFileNativeEffect(blocked, {}),
      ensureQuietStartupEffect(blocked),
      writeSkeletonFilesEffect(blocked),
    ];

    for (const effect of effects) {
      const exit = Effect.runSyncExit(effect);
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");
      assert.equal(
        Effect.runSync(effect.pipe(Effect.catchTag("AuthWriteError", () => Effect.succeed("caught")))),
        "caught",
      );
    }
  });

  it("ensureExtensionConfigsEffect 失败走 ConfigWriteError Fail 通道", () => {
    const blocked = join(tmpBase, "blocked-config");
    writeFileSync(blocked, "file");
    const exit = Effect.runSyncExit(ensureExtensionConfigsEffect(blocked));
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");
    assert.equal(
      Effect.runSync(
        ensureExtensionConfigsEffect(blocked).pipe(
          Effect.catchTag("ConfigWriteError", () => Effect.succeed("caught")),
        ),
      ),
      "caught",
    );
  });

  it("resolvePiCliEffect 成功返回存在的路径", () => {
    const path = Effect.runSync(resolvePiCliEffect);
    assert.ok(existsSync(path), `路径应存在: ${path}`);
  });

  it("sandbox 探测异常按 never 语义降级为 false", () => {
    const result = Effect.runSync(bwrapInstalledEffect(() => {
      throw new Error("spawn failed");
    }));
    assert.equal(result, false);
  });

  it("removeSafetyExtensionsEffect 写入失败走 Fail 通道", () => {
    const blocked = join(tmpBase, "blocked-safety");
    writeFileSync(blocked, "file");
    const exit = Effect.runSyncExit(removeSafetyExtensionsEffect(blocked));
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");
    assert.equal(
      Effect.runSync(
        removeSafetyExtensionsEffect(blocked).pipe(
          Effect.catchTag("SafetySettingsError", () => Effect.succeed("caught")),
        ),
      ),
      "caught",
    );
  });

  it("MCP 校验失败走 McpConfigError Fail 通道且同步包装保留实例类型", () => {
    const def = { name: "bad/name", type: "stdio" } as { name: string; type: string } & Record<string, unknown>;
    const exit = Effect.runSyncExit(addMcpServerEffect(tmpBase, def));
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");
    assert.equal(
      Effect.runSync(
        addMcpServerEffect(tmpBase, def).pipe(
          Effect.catchTag("McpConfigError", () => Effect.succeed("caught")),
        ),
      ),
      "caught",
    );
    assert.throws(() => addMcpServer(tmpBase, def), McpConfigError);
  });

  it("loadMcpServersEffect 损坏配置走 McpConfigError Fail 通道", () => {
    const dir = join(tmpBase, "mcp-bad");
    const path = join(dir, "mcp.json");
    mkdirSync(dir);
    writeFileSync(path, "bad json");
    const exit = Effect.runSyncExit(loadMcpServersEffect(dir));
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");
  });
});
