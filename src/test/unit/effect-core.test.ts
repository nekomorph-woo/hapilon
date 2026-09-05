import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
