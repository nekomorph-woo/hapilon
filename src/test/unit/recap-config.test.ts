import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecapConfig, RECAP_DEFAULTS } from "../../extensions/hpl-recap/config.js";

describe("hpl-recap 配置", () => {
  let home: string;
  const originalHome = process.env.HAPILON_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-recap-config-"));
    process.env.HAPILON_HOME = home;
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("缺失文件使用默认配置，非法字段逐项回退", () => {
    assert.deepEqual(readRecapConfig(), RECAP_DEFAULTS);
    writeFileSync(join(home, "recap-config.json"), JSON.stringify({
      enabled: "yes",
      idleMinutes: -1,
      maxContextChars: 2.5,
    }));
    assert.deepEqual(readRecapConfig(), RECAP_DEFAULTS);
  });

  it("合法可选字段覆盖默认值", () => {
    writeFileSync(join(home, "recap-config.json"), JSON.stringify({
      enabled: false,
      idleMinutes: 0.5,
      maxContextChars: 1200,
    }));
    assert.deepEqual(readRecapConfig(), {
      enabled: false,
      idleMinutes: 0.5,
      maxContextChars: 1200,
    });
  });
});
