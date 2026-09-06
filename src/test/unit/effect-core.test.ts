import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
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
import { listModelsForProvider, listModelsForProviderEffect, PiListingError } from "../../providers/pi-listing.js";
import { readProjectConfigEffect, writeProjectLocalConfigEffect } from "../../config/project-config.js";
import { prepareStartupEffect } from "../../cli/startup.js";
import {
  collectUpwardEffect,
  discoverSkillPathsEffect,
  listFilesEffect,
  readHapilonMdEffect,
  readRulesEffect,
} from "../../shared/files.js";
import { ECON_DEFAULTS, writeEconSettingsEffect } from "../../extensions/hpl-econ/settings.js";
import { config as popConfig } from "../../extensions/hpl-panel-viewer/shared.js";
import { loadPopConfigEffect, savePopConfigEffect } from "../../extensions/hpl-panel-viewer/config.js";
import { searchExternalFilesEffect } from "../../extensions/hpl-add-dir/tools.js";
import { resolveTargetEffect } from "../../extensions/hpl-protected-paths/classifier.js";

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

  afterEach(() => {
    // 每个测试结束都恢复临时 home，避免断言失败或新增测试泄漏全局环境。
    process.env.HAPILON_HOME = tmpBase;
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

  it("listModelsForProviderEffect 非法 HAPILON_HOME 走 Fail 通道", async () => {
    process.env.HAPILON_HOME = "relative/path";
    const exit = Effect.runSyncExit(listModelsForProviderEffect("openai"));
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");
    await assert.rejects(listModelsForProvider("openai"), (err: unknown) => {
      assert.ok(err instanceof PiListingError);
      assert.match(err.message, /无法启动 pi:/);
      return true;
    });
    process.env.HAPILON_HOME = tmpBase;
  });

  it("readProjectConfigEffect 完成三级合并，写入失败降级为 Success", () => {
    const project = join(tmpBase, "project");
    const projectHapilon = join(project, ".hapilon");
    mkdirSync(projectHapilon, { recursive: true });
    writeFileSync(join(tmpBase, "config.json"), JSON.stringify({ defaultProvider: "user", defaultModel: "base" }));
    writeFileSync(join(projectHapilon, "config.json"), JSON.stringify({ defaultProvider: "shared" }));
    writeFileSync(join(projectHapilon, "config.local.json"), JSON.stringify({ defaultModel: "local" }));
    process.env.HAPILON_HOME = tmpBase;
    assert.deepEqual(Effect.runSync(readProjectConfigEffect(project)), {
      defaultProvider: "shared",
      defaultModel: "local",
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const blocked = join(tmpBase, "project-file");
      writeFileSync(blocked, "file");
      const exit = Effect.runSyncExit(writeProjectLocalConfigEffect({ defaultModel: "ignored" }, blocked));
      assert.equal(exit._tag, "Success");
      assert.ok(warnings.some((warning) => warning.includes("写入项目级配置失败:")));
    } finally {
      console.warn = originalWarn;
    }
  });

  it("Effect.async 中断后迟到的 resume 不产生 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const delayed = Effect.async<void, never>((resume) => {
        setTimeout(() => resume(Effect.succeed(undefined)), 25);
      });
      const result = await Effect.runPromise(
        delayed.pipe(
          Effect.timeout("1 millis"),
          Effect.catchAll(() => Effect.succeed("interrupted")),
        ),
      );
      assert.equal(result, "interrupted");
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("prepareStartupEffect 组装完整 PiLaunchPlan", async () => {
    process.env.HAPILON_HOME = tmpBase;
    const plan = await Effect.runPromise(prepareStartupEffect(["--print", "--no-safety", "--sandbox"]));
    assert.ok(existsSync(plan.piCli));
    assert.equal(plan.isNonInteractive, true);
    assert.equal(plan.useSandbox, true);
    assert.ok(plan.piArgs.includes("--no-context-files"));
    assert.ok(plan.piArgs.includes("--no-skills"));
    assert.ok(!plan.piArgs.includes("--no-safety"));
    assert.ok(plan.extensionFlags.includes("-e"));
    assert.equal(plan.piEnv.PI_CODING_AGENT_DIR, join(tmpBase, "agent"));
  });

  it("readHapilonMdEffect 读取失败走 ReadHapilonMdError Fail 通道", () => {
    const missing = join(tmpBase, "missing-HAPILON.md");
    const exit = Effect.runSyncExit(readHapilonMdEffect([missing]));
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") assert.equal(exit.cause._tag, "Fail");
    assert.equal(
      Effect.runSync(
        readHapilonMdEffect([missing]).pipe(
          Effect.catchTag("ReadHapilonMdError", () => Effect.succeed("caught")),
        ),
      ),
      "caught",
    );
  });

  it("规则和目录扫描 Effects 保持 warn 降级并以 Success 返回", () => {
    const rulesDir = join(tmpBase, "effect-rules");
    const skillsDir = join(tmpBase, "effect-skills");
    mkdirSync(rulesDir, { recursive: true });
    mkdirSync(join(skillsDir, "demo"), { recursive: true });
    writeFileSync(join(rulesDir, "always.md"), "---\nalwaysApply: true\n---\n正文\n", { flag: "w" });
    writeFileSync(join(rulesDir, "skip.md"), "---\nalwaysApply: false\n---\n跳过\n");
    writeFileSync(join(skillsDir, "demo", "SKILL.md"), "# demo\n");

    const rules = Effect.runSync(readRulesEffect([rulesDir]));
    assert.deepEqual(rules, [{ name: "always", content: "正文\n" }]);
    assert.equal(Effect.runSync(listFilesEffect(join(tmpBase, "not-there"), "*.md")).length, 0);
    assert.deepEqual(Effect.runSync(discoverSkillPathsEffect([skillsDir])), [
      join(skillsDir, "demo", "SKILL.md"),
    ]);
    assert.deepEqual(Effect.runSync(collectUpwardEffect(tmpBase, tmpBase, "rules")), []);
  });

  it("hpl-econ 与 panel 配置写入失败走 Fail 通道", () => {
    const blocked = join(tmpBase, "blocked-extension-config");
    writeFileSync(blocked, "file");
    const econExit = Effect.runSyncExit(writeEconSettingsEffect(blocked, ECON_DEFAULTS));
    assert.equal(econExit._tag, "Failure");
    if (econExit._tag === "Failure") assert.equal(econExit.cause._tag, "Fail");
    assert.equal(
      Effect.runSync(writeEconSettingsEffect(blocked, ECON_DEFAULTS).pipe(
        Effect.catchTag("EconConfigError", () => Effect.succeed("caught")),
      )),
      "caught",
    );

    process.env.HAPILON_HOME = blocked;
    const popExit = Effect.runSyncExit(savePopConfigEffect());
    assert.equal(popExit._tag, "Failure");
    if (popExit._tag === "Failure") assert.equal(popExit.cause._tag, "Fail");
    assert.equal(
      Effect.runSync(savePopConfigEffect().pipe(
        Effect.catchTag("PopConfigError", () => Effect.succeed("caught")),
      )),
      "caught",
    );
    process.env.HAPILON_HOME = tmpBase;
    Effect.runSync(loadPopConfigEffect);
    assert.ok(Array.isArray(popConfig.keys));
  });

  it("hpl-add-dir searchExternalFilesEffect 使用 Effect.async 返回文件", async () => {
    const dir = join(tmpBase, "search-root");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "needle.txt"), "found");
    const files = await Effect.runPromise(searchExternalFilesEffect(
      dir,
      [dir, "-name", "needle.txt", "-type", "f"],
    ));
    assert.deepEqual(files, [join(dir, "needle.txt")]);
  });

  it("hpl-add-dir 搜索超时 kill 子进程并返回空结果", async () => {
    const started = Date.now();
    const files = await Effect.runPromise(searchExternalFilesEffect(
      tmpBase,
      [],
      undefined,
      (_command, _args, options) => childProcess.spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 1000)"],
        { ...options, stdio: ["ignore", "pipe", "pipe"] },
      ),
      10,
    ));
    assert.deepEqual(files, []);
    assert.ok(Date.now() - started < 500, "超时后不应继续等待子进程");
  });

  it("hpl-protected-paths resolveTargetEffect 对不存在路径降级为绝对路径", () => {
    const target = join(tmpBase, "not-created", "secret.txt");
    assert.equal(Effect.runSync(resolveTargetEffect(target, tmpBase)), target);
  });
});
