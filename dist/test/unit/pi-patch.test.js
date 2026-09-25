import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePiPatch, PATCH_RULES } from "../../patch/ensure-pi-patch.js";
/**
 * 用真实规则锚点构造假包结构,锁定 patcher 的两条命脉:
 *  1. 幂等:同文件多批次/重入不产生重复插入(theme.js 曾被双插 function 声明,ESM 直接挂)
 *  2. 派发:pi 主包与 pi-tui 包各自命中
 */
describe("ensurePiPatch()", () => {
    const PI = "@earendil-works/pi-coding-agent";
    const CHUNK_DIR = "dist/bundle/chunks";
    const CHUNK_NAME = "chunk-old.js";
    let base;
    let piDir;
    function fixturePath(rule, chunk = CHUNK_NAME) {
        const pkg = rule.package ?? PI;
        return rule.signature
            ? join(base, "node_modules", pkg, CHUNK_DIR, chunk)
            : join(base, "node_modules", pkg, rule.file);
    }
    function writeChunkFixture(path) {
        const chunkRules = PATCH_RULES.filter((rule) => rule.signature);
        writeFileSync(path, chunkRules.map((rule) => Array(rule.occurrences).fill(rule.find).join("\n")).join("\n") + "\n");
    }
    before(() => {
        base = mkdtempSync(join(tmpdir(), "hapi-patch-"));
        piDir = join(base, "node_modules", PI);
        // 每个非 chunk 目标文件:按规则锚点出现次数拼出假内容
        for (const target of new Set(PATCH_RULES.filter((r) => !r.signature).map((r) => `${r.package ?? PI}::${r.file}`))) {
            const [pkg, file] = [target.split("::")[0], target.split("::")[1]];
            const path = join(base, "node_modules", pkg, file);
            mkdirSync(join(path, ".."), { recursive: true });
            const content = PATCH_RULES
                .filter((r) => !r.signature && (r.package ?? PI) === pkg && r.file === file)
                .map((r) => Array(r.occurrences).fill(r.find).join("\n"))
                .join("\n") + "\n";
            writeFileSync(path, content);
        }
        const chunkPath = join(base, "node_modules", PI, CHUNK_DIR, CHUNK_NAME);
        mkdirSync(join(chunkPath, ".."), { recursive: true });
        writeChunkFixture(chunkPath);
        // pi 包根需要 package.json 供 findPiDir 探测；hapilon 依赖树里的包同理
        writeFileSync(join(piDir, "package.json"), "{}");
        const hapilonPkgDir = join(base, "node_modules", "@nklisch/pi-background-tasks");
        writeFileSync(join(hapilonPkgDir, "package.json"), "{}");
    });
    after(() => rmSync(base, { recursive: true, force: true }));
    it("首跑全部命中:每个锚点替换恰好 occurrences 次,无重复插入", () => {
        const result = ensurePiPatch({ piDir, hapilonRoot: base });
        assert.equal(result.kind, "patched", JSON.stringify(result, null, 2));
        for (const rule of PATCH_RULES) {
            const pkg = rule.package ?? PI;
            const text = readFileSync(fixturePath(rule), "utf8");
            const replaced = text.split(rule.replace).length - 1;
            // 规则间替换产物可能互有包含(如 catch 分支转换含 map(codeBlockLine)),
            // 只断言“至少已应用”;双插防护由混合态用例专责
            assert.ok(replaced >= rule.occurrences, `${pkg}/${rule.file} 的替换产物应 ≥ ${rule.occurrences},实际 ${replaced}`);
        }
    });
    it("再跑幂等:already-patched 且内容不变", () => {
        const before = PATCH_RULES.map((rule) => readFileSync(fixturePath(rule), "utf8"));
        const result = ensurePiPatch({ piDir, hapilonRoot: base });
        assert.equal(result.kind, "already-patched");
        PATCH_RULES.forEach((rule, index) => {
            const text = readFileSync(fixturePath(rule), "utf8");
            assert.equal(text, before[index], `${rule.file} 内容不应变化`);
        });
    });
    it("chunk 签名寻址支持旧/新文件名，并在多命中时 stale", () => {
        const rule = PATCH_RULES.find((candidate) => candidate.signature);
        const oldPath = fixturePath(rule);
        const newPath = fixturePath(rule, "chunk-new.js");
        renameSync(oldPath, newPath);
        writeChunkFixture(newPath);
        assert.equal(ensurePiPatch({ piDir, hapilonRoot: base }).kind, "patched");
        renameSync(newPath, oldPath);
        assert.equal(ensurePiPatch({ piDir, hapilonRoot: base }).kind, "already-patched");
        const duplicatePath = fixturePath(rule, "chunk-duplicate.js");
        writeFileSync(duplicatePath, rule.signature);
        const stale = ensurePiPatch({ piDir, hapilonRoot: base });
        assert.equal(stale.kind, "stale", JSON.stringify(stale));
        assert.match(JSON.stringify(stale), /命中 2 个文件/);
        rmSync(duplicatePath);
    });
    it("混合态重入不双插(旧批次已补+新批次未补,theme.js 事故回归)", () => {
        // 取同一文件上分两批落的规则:旧批次(marker=mdCodeBlockBg)+新批次(slash 触发门)
        const rules = PATCH_RULES.filter((r) => r.signature);
        const oldRules = rules.filter((r) => r.marker === undefined);
        const newRules = rules.filter((r) => r.marker !== undefined && r.marker !== "mdCodeBlockBg");
        assert.ok(oldRules.length > 0 && newRules.length > 0, "该文件应有新旧两批规则");
        // 旧批次已应用(替换产物在场),新批次只有锚点、产物缺席——正是当年炸掉 theme 的形态
        let content = oldRules
            .map((r) => Array(r.occurrences).fill(r.replace).join("\n"))
            .join("\n");
        content += "\n" + newRules.map((r) => Array(r.occurrences).fill(r.find).join("\n")).join("\n");
        const path = fixturePath(rules[0]);
        writeFileSync(path, content);
        const result = ensurePiPatch({ piDir, hapilonRoot: base });
        assert.ok(result.kind === "patched" || result.kind === "already-patched", JSON.stringify(result));
        // 字节级断言:旧批次区域原样不动(不得重入双插),新批次锚点恰好转为替换产物
        const oldSeed = oldRules
            .map((r) => Array(r.occurrences).fill(r.replace).join("\n"))
            .join("\n");
        const text = readFileSync(path, "utf8");
        assert.ok(text.startsWith(oldSeed + "\n"), "旧批次区域必须原样保留");
        for (const r of newRules) {
            assert.equal(text.split(r.replace).length - 1, r.occurrences, "新批次应恰好转为替换产物");
        }
        for (const r of oldRules) {
            assert.ok(text.split(r.replace).length - 1 >= r.occurrences, `旧批次替换产物不得翻倍: ${r.find.slice(0, 40)}`);
        }
    });
    it("Windows shell 修复落在后台任务插件（hapilon 依赖树，不在 pi 包里）", () => {
        const text = readFileSync(join(base, "node_modules", "@nklisch/pi-background-tasks", "extensions/background-tasks.ts"), "utf8");
        assert.ok(text.includes('import { getShellConfig } from "@earendil-works/pi-coding-agent";'), "应注入 pi 的平台 shell 解析");
        assert.ok(text.includes('commandTransport === "stdin"'), "应识别 pi 的 stdin shell transport");
        assert.ok(text.includes("stdin shell transport is unsupported by pi-background-tasks"), "stdin 环境必须显式失败");
        assert.equal(text.split("shell: hapiShell(),").length - 1, 1, "background 的 spawn 应改走 hapiShell()");
        assert.equal(text.split("pi.exec!(hapiShell(),").length - 1, 1, "monitor 的 pi.exec 应改走 hapiShell()");
        // spawn 站点的写死 shell 不得残留（helper 内部的 POSIX 分支是另一回事）
        assert.equal(text.includes('      shell: "/bin/sh",'), false);
        assert.equal(text.includes('pi.exec!("/bin/sh"'), false);
    });
});
