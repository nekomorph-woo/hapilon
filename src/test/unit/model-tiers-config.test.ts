import { describe, it, beforeEach, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelTiers } from "../../extensions/hpl-model-tiers/config.js";

describe("hpl-model-tiers 配置覆盖", () => {
  let home: string;
  let project: string;
  const originalHome = process.env.HAPILON_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-model-tiers-home-"));
    process.env.HAPILON_HOME = home;
  });

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "hapilon-model-tiers-project-"));
    rmSync(join(home, "model-tiers.json"), { force: true });
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("全局配置与项目配置按档位覆盖，缺档沿用全局", () => {
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify({
      opus: ["anthropic/claude-opus-*"],
      sonnet: ["anthropic/claude-sonnet-*"],
      haiku: ["deepseek-chat"],
    }));
    mkdirSync(join(project, ".hapilon"));
    writeFileSync(join(project, ".hapilon", "model-tiers.json"), JSON.stringify({
      sonnet: ["glm-*"],
    }));

    assert.deepEqual(readModelTiers(project), {
      opus: ["anthropic/claude-opus-*"],
      sonnet: ["glm-*"],
      haiku: ["deepseek-chat"],
    });
  });

  it("档位数组或元素非法时，该档为空且其它档继续", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      writeFileSync(join(home, "model-tiers.json"), JSON.stringify({
        opus: ["ok-*", 42],
        sonnet: "not-an-array",
        haiku: ["valid-*"],
      }));
      const result = readModelTiers(project);
      assert.deepEqual(result, { opus: [], sonnet: [], haiku: ["valid-*"] });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 2);
  });
});
