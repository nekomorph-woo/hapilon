import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../../commands.js";

describe("commands", () => {
  it("所有命令有 name 和 description", () => {
    for (const cmd of COMMANDS) {
      assert.ok(cmd.name && cmd.name.length > 0, `${cmd.name}: 应有 name`);
      assert.ok(cmd.description && cmd.description.length > 0, `${cmd.name}: 应有 description`);
    }
  });

  it("无重复 name", () => {
    const names = COMMANDS.map((c) => c.name);
    const unique = new Set(names);
    assert.strictEqual(unique.size, names.length, "命令 name 应唯一");
  });

  it("setup/doctor/config/help 均已注册", () => {
    const nameSet = new Set(COMMANDS.map((c) => c.name));
    assert.ok(nameSet.has("setup"), "应包含 setup");
    assert.ok(nameSet.has("doctor"), "应包含 doctor");
    assert.ok(nameSet.has("config"), "应包含 config");
    assert.ok(nameSet.has("help"), "应包含 help");
  });

  it("config 有 show/default/provider 子命令", () => {
    const config = COMMANDS.find((c) => c.name === "config");
    assert.ok(config, "应存在 config 命令");
    assert.ok(config!.subcommands, "config 应有子命令");

    const subNames = config!.subcommands!.map((s) => s.name);
    assert.ok(subNames.includes("show"), "config 应有 show 子命令");
    assert.ok(subNames.includes("default"), "config 应有 default 子命令");
    assert.ok(subNames.includes("provider"), "config 应有 provider 子命令");
  });

  it("子命令也有 description", () => {
    for (const cmd of COMMANDS) {
      if (cmd.subcommands) {
        for (const sub of cmd.subcommands) {
          assert.ok(sub.name && sub.name.length > 0, `${cmd.name} > ${sub.name}: 应有 name`);
          assert.ok(sub.description && sub.description.length > 0, `${cmd.name} > ${sub.name}: 应有 description`);
        }
      }
    }
  });
});
