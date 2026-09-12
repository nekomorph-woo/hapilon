import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePiPatch } from "../../patch/ensure-pi-patch.js";

/**
 * 锚点漂移（pi 升级）在启动链上只会打一行警告，容易被忽略；这里把它变成红灯，
 * 强制升级 pi 的一方来更新 src/patch/ensure-pi-patch.ts 的锚点。
 */
test("ensurePiPatch：对本仓库安装的 pi 定位成功且锚点不失配，且幂等", () => {
  const first = ensurePiPatch();
  assert.notEqual(first.kind, "pi-not-found", "应当能定位到 node_modules/@earendil-works/pi-coding-agent");
  assert.notEqual(first.kind, "stale", JSON.stringify(first, null, 2));
  assert.notEqual(first.kind, "unwritable", JSON.stringify(first, null, 2));
  assert.equal(ensurePiPatch().kind, "already-patched", "第二次调用必须走已补丁幂等路径");
});
