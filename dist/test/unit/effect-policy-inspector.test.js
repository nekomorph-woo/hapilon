import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { inspectProject, inspectProjectEffect } from "../../extensions/hpl-effect-policy/inspector.js";
function repo(packageJson = {}) {
    const dir = mkdtempSync(join(tmpdir(), "hpl-effect-inspector-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson));
    return dir;
}
function clean(dir) {
    rmSync(dir, { recursive: true, force: true });
}
describe("inspectProjectEffect", () => {
    it("完整 TypeScript + Effect 项目收集 required 信号", () => {
        const dir = repo({ dependencies: { effect: "^3.22.1" } });
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        writeFileSync(join(dir, "src", "x.ts"), 'import { Effect } from "effect";');
        const result = inspectProject(dir);
        assert.deepEqual(result, { language: "typescript", effectInstalled: true, effectImportsFound: true, packageManager: undefined, hasAgentsMd: false, isGreenfield: false, isScriptTask: false });
        clean(dir);
    });
    it("普通 TypeScript 项目无 Effect", () => {
        const dir = repo({});
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        assert.equal(inspectProject(dir).effectInstalled, false);
        assert.equal(inspectProject(dir).effectImportsFound, false);
        clean(dir);
    });
    it("无 tsconfig 的 package 项目判定为 JavaScript", () => {
        const dir = repo({});
        assert.equal(inspectProject(dir).language, "javascript");
        clean(dir);
    });
    it("无 package.json 降级为 other 且所有信号保守", () => {
        const dir = mkdtempSync(join(tmpdir(), "hpl-effect-inspector-"));
        assert.deepEqual(inspectProject(dir), { language: "other", effectInstalled: false, effectImportsFound: false, packageManager: undefined, hasAgentsMd: false, isGreenfield: false, isScriptTask: false });
        clean(dir);
    });
    it("lockfile 按 npm > pnpm > yarn > bun 优先，单个分别识别", () => {
        for (const [file, expected] of [["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"]]) {
            const dir = repo({});
            writeFileSync(join(dir, file), "");
            assert.equal(inspectProject(dir).packageManager, expected);
            clean(dir);
        }
        const dir = repo({});
        for (const file of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"])
            writeFileSync(join(dir, file), "");
        assert.equal(inspectProject(dir).packageManager, "npm");
        const empty = repo({});
        assert.equal(inspectProject(empty).packageManager, undefined);
        clean(dir);
        clean(empty);
    });
    it("AGENTS.md 或 CLAUDE.md 存在即 hasAgentsMd", () => {
        const agents = repo({});
        writeFileSync(join(agents, "AGENTS.md"), "rules");
        assert.equal(inspectProject(agents).hasAgentsMd, true);
        clean(agents);
        const claude = repo({});
        writeFileSync(join(claude, "CLAUDE.md"), "rules");
        assert.equal(inspectProject(claude).hasAgentsMd, true);
        clean(claude);
    });
    it("import 扫描只到两层：src/x 与 src/b/c 扫到，src/b/c/d 不扫", () => {
        const dir = repo({});
        mkdirSync(join(dir, "src", "b", "c"), { recursive: true });
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        writeFileSync(join(dir, "src", "a.ts"), 'import { Effect } from "effect";');
        writeFileSync(join(dir, "src", "b", "c", "d.ts"), 'import { Effect } from "effect";');
        assert.equal(inspectProject(dir).effectImportsFound, true);
        clean(dir);
        const deep = repo({});
        mkdirSync(join(deep, "src", "b", "c"), { recursive: true });
        writeFileSync(join(deep, "tsconfig.json"), "{}");
        writeFileSync(join(deep, "src", "b", "c", "d.ts"), 'import { Effect } from "effect";');
        // src/b/c/d.ts is depth three from src and must not be read.
        assert.equal(inspectProject(deep).effectImportsFound, false);
        clean(deep);
    });
    it("src 不存在时扫描根下两层脚本仓库", () => {
        const dir = repo({});
        mkdirSync(join(dir, "scripts"));
        writeFileSync(join(dir, "scripts", "run.ts"), 'const x = require("effect");');
        assert.equal(inspectProject(dir).effectImportsFound, true);
        clean(dir);
    });
    it("greenfield 区分空扫描、lockfile、源码和扫描失败", () => {
        const empty = repo({});
        assert.equal(inspectProject(empty).isGreenfield, true);
        clean(empty);
        const locked = repo({});
        writeFileSync(join(locked, "package-lock.json"), "{}");
        assert.equal(inspectProject(locked).isGreenfield, false);
        clean(locked);
        const source = repo({});
        mkdirSync(join(source, "src"));
        writeFileSync(join(source, "src", "main.ts"), "export {};");
        assert.equal(inspectProject(source).isGreenfield, false);
        clean(source);
        const failed = repo({});
        chmodSync(failed, 0o000);
        try {
            assert.equal(inspectProject(failed).isGreenfield, false);
        }
        finally {
            chmodSync(failed, 0o700);
            clean(failed);
        }
    });
    it("坏 package.json 降级为 other 且不抛出", () => {
        const dir = repo({});
        writeFileSync(join(dir, "package.json"), "{broken");
        assert.doesNotThrow(() => Effect.runSync(inspectProjectEffect(dir)));
        assert.equal(inspectProject(dir).language, "other");
        clean(dir);
    });
    it("深层目录读取失败跳过并继续，不失败", () => {
        const dir = repo({});
        mkdirSync(join(dir, "src", "ok"), { recursive: true });
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        writeFileSync(join(dir, "src", "ok", "ok.ts"), 'import { Effect } from "effect";');
        const blocked = join(dir, "src", "blocked");
        mkdirSync(blocked);
        chmodSync(blocked, 0o000);
        try {
            assert.doesNotThrow(() => inspectProject(dir));
            assert.equal(inspectProject(dir).effectImportsFound, true);
        }
        finally {
            chmodSync(blocked, 0o700);
            clean(dir);
        }
    });
});
