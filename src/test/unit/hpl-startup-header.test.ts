// startup header 纯函数测试：路径缩短 + 解析 + 布局构建
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shortenWorkspacePath,
  parseExtensionsEnv,
  hapilonLogo,
  currentLayoutIndex,
  buildLayoutB,
  type HeaderData,
} from "../../extensions/hpl-startup-header/content.js";

describe("shortenWorkspacePath", () => {
  it("home 直接返回 ~", () => {
    assert.equal(shortenWorkspacePath("/Users/alice", "/Users/alice"), "~");
  });

  it("home 下短路径保留完整", () => {
    assert.equal(shortenWorkspacePath("/Users/alice/proj", "/Users/alice"), "~/proj");
  });

  it("home 下长路径压缩首末段", () => {
    assert.equal(
      shortenWorkspacePath("/Users/alice/a/b/c/d/e", "/Users/alice"),
      "~/a/…/d/e",
    );
  });

  it("非 home 绝对路径保留前两段与末段", () => {
    assert.equal(
      shortenWorkspacePath("/Volumes/M2/a/b/c/hapilon", "/Users/alice"),
      "/Volumes/M2/…/hapilon",
    );
  });
});

describe("parseExtensionsEnv", () => {
  it("JSON 数组解析为 string[]", () => {
    assert.deepEqual(parseExtensionsEnv('["a","b"]'), ["a", "b"]);
  });

  it("undefined / 非 JSON / 非数组返回 undefined", () => {
    assert.equal(parseExtensionsEnv(undefined), undefined);
    assert.equal(parseExtensionsEnv("not json"), undefined);
    assert.equal(parseExtensionsEnv('{"a":1}'), undefined);
  });
});

describe("logo 与布局随机", () => {
  it("logo 返回 10 行非空字符串", () => {
    const logo = hapilonLogo();
    assert.equal(logo.length, 10);
    assert.ok(logo.every((l) => typeof l === "string"));
  });

  it("布局索引为 0 或 1（A/B）", () => {
    const idx = currentLayoutIndex();
    assert.ok(idx === 0 || idx === 1, `layout index: ${idx}`);
  });
});

describe("buildLayoutB", () => {
  const data: HeaderData = {
    version: "0.0.0",
    piVersion: "1.0.0",
    modelProvider: "zai",
    modelName: "glm-test",
    cwd: "/tmp/proj",
    homeDir: "/home/u",
    extensions: [],
    piUpdate: undefined,
  };

  it("collapsed 首屏含排队与引导快捷键提示行", () => {
    const lines = buildLayoutB(data, false, 100);
    const hints = lines.find((l) => l.includes("queue"));
    assert.ok(hints, "应有快捷键提示行");
    assert.match(
      hints!,
      /enter steer · mac\/linux> alt\+enter queue, alt\+up edit queue · win> ctrl\+q queue, alt\+q edit queue/,
    );
  });

  it("collapsed 提示行在 status 行下方", () => {
    const lines = buildLayoutB(data, false, 100);
    const statusIdx = lines.findIndex((l) => l.includes("hapilon v"));
    const hintsIdx = lines.findIndex((l) => l.includes("queue"));
    assert.ok(statusIdx >= 0 && hintsIdx === statusIdx + 1, `status=${statusIdx} hints=${hintsIdx}`);
  });

  it("expanded 不含快捷键提示行", () => {
    const lines = buildLayoutB(data, true, 100);
    assert.ok(!lines.some((l) => l.includes("edit queue")));
  });
});
