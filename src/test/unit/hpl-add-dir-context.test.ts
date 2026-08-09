/**
 * hpl-add-dir context.ts 单元测试 — 目录上下文扫描与注入构建纯函数
 *
 * 核心验收（#29）：只注入 HAPILON.md（目录根 + .pi/ 子目录），
 * AGENTS.md / CLAUDE.md 存在但不注入——符合 hapilon 受控上下文设计。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  scanDirContext,
  buildContextInjection,
  invalidateContextCache,
} from "../../extensions/hpl-add-dir/context.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpl-add-dir-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  invalidateContextCache();
});

describe("scanDirContext — 只读 HAPILON.md", () => {
  it("目录根 HAPILON.md 被读取", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "HAPILON.md"), "# 外部规则\n内容A");
    const ctx = scanDirContext(dir);
    assert.equal(ctx.hapilonMd, "# 外部规则\n内容A");
  });

  it("AGENTS.md / CLAUDE.md 存在但被忽略（hapilon 设计）", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents 注入");
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "claude 注入");
    const ctx = scanDirContext(dir);
    assert.equal(ctx.hapilonMd, null);
  });

  it(".pi/ 子目录 HAPILON.md 与根合并", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "HAPILON.md"), "根内容");
    fs.mkdirSync(path.join(dir, ".pi"));
    fs.writeFileSync(path.join(dir, ".pi", "HAPILON.md"), "子内容");
    const ctx = scanDirContext(dir);
    assert.ok(ctx.hapilonMd?.includes("根内容"));
    assert.ok(ctx.hapilonMd?.includes("子内容"));
  });

  it("无 HAPILON.md 时返回 null（不抛错）", () => {
    const dir = makeTmpDir();
    const ctx = scanDirContext(dir);
    assert.equal(ctx.hapilonMd, null);
  });
});

describe("buildContextInjection — 注入构建", () => {
  it("空目录列表 → 空注入", () => {
    assert.equal(buildContextInjection([]), "");
  });

  it("注入 HAPILON.md 全文 + 标题结构", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "HAPILON.md"), "外部目录约定");
    const injection = buildContextInjection([
      { absolutePath: dir, label: "ext-proj", addedAt: 0 },
    ]);

    assert.ok(injection.includes("## External Directories"));
    assert.ok(injection.includes("### 📁 ext-proj"));
    assert.ok(injection.includes("#### HAPILON.md (from ext-proj)"));
    assert.ok(injection.includes("外部目录约定"));
  });

  it("AGENTS.md / CLAUDE.md 内容不进入注入", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents 秘密内容");
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "claude 秘密内容");
    const injection = buildContextInjection([
      { absolutePath: dir, label: "ext-proj", addedAt: 0 },
    ]);

    // 内容不注入（Top-level contents 只列文件名，不算注入内容）
    assert.ok(!injection.includes("agents 秘密内容"));
    assert.ok(!injection.includes("claude 秘密内容"));
    assert.ok(!injection.includes("#### AGENTS.md"));
    assert.ok(!injection.includes("#### CLAUDE.md"));
  });

  it("目录不存在 → 跳过不抛错", () => {
    const injection = buildContextInjection([
      { absolutePath: "/nonexistent/hpl-add-dir-test", label: "ghost", addedAt: 0 },
    ]);
    // 目录不存在：标题结构仍在（pi-add-dir 原行为），但内容部分跳过不崩
    assert.ok(typeof injection === "string");
  });

  it("缓存：相同目录列表复用结果", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "HAPILON.md"), "缓存内容");
    const dirs = [{ absolutePath: dir, label: "ext-proj", addedAt: 0 }];

    const first = buildContextInjection(dirs);
    // 修改文件后不重扫（缓存命中）
    fs.writeFileSync(path.join(dir, "HAPILON.md"), "变了但缓存不重扫");
    const second = buildContextInjection(dirs);
    assert.equal(second, first);

    // invalidate 后重扫
    invalidateContextCache();
    const third = buildContextInjection(dirs);
    assert.ok(third.includes("变了但缓存不重扫"));
  });
});
