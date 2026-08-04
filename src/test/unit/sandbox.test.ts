/**
 * sandbox.ts 单元测试 — Linux bwrap 预检（issue #5）
 *
 * spawnFn 依赖注入测试：ESM namespace 属性不可配置，无法用 mock.method
 * 替换 named import，改用注入 fake spawnFn 保持纯函数可测。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bwrapInstalled, bwrapInstallHint } from "../../sandbox.js";

describe("bwrapInstalled", () => {
  it("spawnSync 返回 status 0 → true", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeSpawn = (() => ({ status: 0 })) as any;
    assert.equal(bwrapInstalled(fakeSpawn), true);
  });

  it("spawnSync 返回非 0 → false", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeSpawn = (() => ({ status: 1 })) as any;
    assert.equal(bwrapInstalled(fakeSpawn), false);
  });

  it("spawnSync 抛错（bwrap 不在 PATH）→ false", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeSpawn = (() => { throw new Error("ENOENT"); }) as any;
    assert.equal(bwrapInstalled(fakeSpawn), false);
  });
});

describe("bwrapInstallHint", () => {
  it("含 Debian/Ubuntu apt 安装命令", () => {
    const hint = bwrapInstallHint().join("\n");
    assert.ok(hint.includes("apt install bubblewrap"), "应含 apt 提示");
  });

  it("含 Fedora/RHEL dnf 安装命令", () => {
    const hint = bwrapInstallHint().join("\n");
    assert.ok(hint.includes("dnf install bubblewrap"), "应含 dnf 提示");
  });

  it("含 Arch pacman 安装命令", () => {
    const hint = bwrapInstallHint().join("\n");
    assert.ok(hint.includes("pacman -S bubblewrap"), "应含 pacman 提示");
  });
});
