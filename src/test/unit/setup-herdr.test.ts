import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { iconFileName, mergePrograms, shimScript } from "../../cli/setup-herdr.js";

describe("setup-herdr 纯函数", () => {
  it("shim 写死 cliPath 与 HAPILON_HOME", () => {
    const s = shimScript("/opt/hapilon/dist/cli.js", "/home/u/.hapilon-dev");
    assert.match(s, /^#!\/bin\/sh\n/);
    assert.match(s, /HAPILON_HOME="\/home\/u\/\.hapilon-dev" exec node "\/opt\/hapilon\/dist\/cli\.js" "\$@"\n$/);
  });

  it("Windows shim 产 .cmd 形态，参数透传 %*", () => {
    const s = shimScript("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\hapilon\\dist\\cli.js", "C:\\Users\\u\\.hapilon", true);
    assert.match(s, /^@echo off\n/);
    assert.match(s, /set "HAPILON_HOME=C:\\Users\\u\\.hapilon"\n/);
    assert.match(s, /node "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\hapilon\\dist\\cli\.js" %\*\n$/);
  });

  it("icon 文件名由内容 hash 决定，同内容稳定、异内容换名", () => {
    const a = iconFileName("<svg>a</svg>");
    assert.match(a, /^hapilon-[0-9a-f]{8}\.svg$/);
    assert.equal(a, iconFileName("<svg>a</svg>"));
    assert.notEqual(a, iconFileName("<svg>b</svg>"));
  });

  it("programs.json 不存在时新建外壳", () => {
    const out = JSON.parse(mergePrograms(null, { name: "Hapilon" }));
    assert.deepEqual(out, { programs: { hapilon: { name: "Hapilon" } } });
  });

  it("合并保留其他条目，hapilon 条目整条更新", () => {
    const raw = JSON.stringify({ programs: { pi: { name: "Pi" }, hapilon: { name: "旧" } }, other: 1 });
    const out = JSON.parse(mergePrograms(raw, { name: "Hapilon", run: ["hapilon"] })) as {
      programs: Record<string, unknown>;
      other: unknown;
    };
    assert.deepEqual(out.programs.pi, { name: "Pi" });
    assert.deepEqual(out.programs.hapilon, { name: "Hapilon", run: ["hapilon"] });
    assert.equal(out.other, 1);
  });

  it("programs.json 损坏时明确报错，不静默重建", () => {
    assert.throws(() => mergePrograms("{oops", {}), /不是合法 JSON/);
  });
});
