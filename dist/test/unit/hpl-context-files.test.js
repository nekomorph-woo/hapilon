/**
 * shared/files.ts 单元测试 — 文件发现函数（原 hpl-context/files.ts，已迁移至 shared/）
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, collectUpward, readHapilonMd, readRules, discoverSkillPaths, } from "../../shared/files.js";
describe("listFiles", () => {
    let dir;
    before(() => { dir = mkdtempSync(join(tmpdir(), "hapilon-files-test-")); });
    after(() => { try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch { } });
    it("正常路径: 匹配文件按字母序返回，不匹配的被忽略", () => {
        mkdirSync(join(dir, "sub"), { recursive: true });
        writeFileSync(join(dir, "HAPILON.md"), "# test");
        writeFileSync(join(dir, "README.md"), "ignore me");
        writeFileSync(join(dir, "sub", "HAPILON.md"), "nested"); // 不递归，不应出现
        const result = listFiles(dir, "HAPILON.md");
        assert.deepEqual(result, [join(dir, "HAPILON.md")]);
    });
    it("边界条件: 目录不存在时返回空数组", () => {
        assert.deepEqual(listFiles("/no/such/dir", "HAPILON.md"), []);
    });
    it("边界条件: 目录存在但无匹配文件", () => {
        mkdirSync(join(dir, "empty"), { recursive: true });
        assert.deepEqual(listFiles(join(dir, "empty"), "*.md"), []);
    });
});
describe("collectUpward", () => {
    let root;
    before(() => { root = mkdtempSync(join(tmpdir(), "hapilon-collect-")); });
    after(() => { try {
        rmSync(root, { recursive: true, force: true });
    }
    catch { } });
    it("正常路径: 从深层向上遍历，收集 .hapilon/HAPILON.md，祖先在前", () => {
        // root/  ───  .hapilon/HAPILON.md
        // root/a/  ─  .hapilon/HAPILON.md
        // root/a/b/  (cwd) — 无 .hapilon
        const r = mkdtempSync(join(tmpdir(), "hapilon-up-"));
        try {
            mkdirSync(join(r, ".hapilon"), { recursive: true });
            writeFileSync(join(r, ".hapilon", "HAPILON.md"), "root md");
            mkdirSync(join(r, "a", ".hapilon"), { recursive: true });
            writeFileSync(join(r, "a", ".hapilon", "HAPILON.md"), "a md");
            const cwd = join(r, "a", "b");
            mkdirSync(cwd, { recursive: true });
            const result = collectUpward(cwd, r, "HAPILON.md");
            assert.equal(result.length, 2);
            assert.ok(result[0].endsWith(join(r, ".hapilon", "HAPILON.md")), "祖先级应在最前");
            assert.ok(result[1].endsWith(join(r, "a", ".hapilon", "HAPILON.md")), "近层级在最后");
        }
        finally {
            rmSync(r, { recursive: true, force: true });
        }
    });
    it("边界条件: 无 .hapilon 目录时返回空数组", () => {
        const empty = mkdtempSync(join(tmpdir(), "hapilon-no-dot-"));
        try {
            assert.deepEqual(collectUpward(empty, "/nonexistent-home", "HAPILON.md"), []);
        }
        finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });
    it("正常路径: 收集 rules 目录（*.md 文件，按字母序）", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-rules-"));
        try {
            mkdirSync(join(dir, ".hapilon", "agents", "rules"), { recursive: true });
            writeFileSync(join(dir, ".hapilon", "agents", "rules", "b-rule.md"), "rule b");
            writeFileSync(join(dir, ".hapilon", "agents", "rules", "a-rule.md"), "rule a");
            const result = collectUpward(dir, "/nonexistent-home", "agents/rules");
            assert.equal(result.length, 1, "应发现 1 个规则目录");
            const rulesDir = result[0];
            const files = listFiles(rulesDir, "*.md");
            assert.equal(files.length, 2);
            assert.ok(files[0].endsWith("a-rule.md"));
            assert.ok(files[1].endsWith("b-rule.md"));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe("readHapilonMd", () => {
    it("正常路径: 读取多个 HAPILON.md 文件，返回路径与内容", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-readmd-"));
        try {
            const f1 = join(dir, "file1.md");
            const f2 = join(dir, "file2.md");
            writeFileSync(f1, "# Hello");
            writeFileSync(f2, "# World");
            const result = readHapilonMd([f1, f2]);
            assert.deepEqual(result, [
                { path: f1, content: "# Hello" },
                { path: f2, content: "# World" },
            ]);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("边界条件: 空路径数组返回空数组", () => {
        assert.deepEqual(readHapilonMd([]), []);
    });
    it("异常路径: 不存在的文件报错（Fail Fast）", () => {
        assert.throws(() => readHapilonMd(["/no/such/HAPILON.md"]));
    });
});
describe("readRules", () => {
    it("正常路径: 读取规则文件，解析 frontmatter alwaysApply", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-readrules-"));
        try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "r1.md"), "---\nalwaysApply: true\n---\n# Rule 1 body");
            writeFileSync(join(dir, "r2.md"), "---\nalwaysApply: false\n---\n# Rule 2 body");
            writeFileSync(join(dir, "r3.md"), "# No frontmatter"); // 默认 alwaysApply: true
            const result = readRules([dir]);
            assert.equal(result.length, 2, "r1(alwaysApply=true) 和 r3(无 frontmatter, 默认 true)；r2 被跳过");
            assert.ok(result.find(r => r.name === "r1"));
            assert.ok(result.find(r => r.name === "r3"));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("边界条件: 空目录返回空数组", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-empty-rules-"));
        try {
            assert.deepEqual(readRules([dir]), []);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("异常路径: 目录不存在时忽略该目录", () => {
        const result = readRules(["/no/such/rules"]);
        assert.deepEqual(result, []);
    });
});
describe("discoverSkillPaths", () => {
    it("正常路径: 扫描技能目录，返回包含 SKILL.md 的子目录", () => {
        const base = mkdtempSync(join(tmpdir(), "hapilon-skills-"));
        try {
            mkdirSync(join(base, ".hapilon", "agents", "skills", "my-skill"), { recursive: true });
            writeFileSync(join(base, ".hapilon", "agents", "skills", "my-skill", "SKILL.md"), "frontmatter here");
            mkdirSync(join(base, ".hapilon", "agents", "skills", "empty-skill"), { recursive: true }); // 无 SKILL.md
            const result = discoverSkillPaths([join(base, ".hapilon", "agents", "skills")]);
            assert.equal(result.length, 1);
            assert.ok(result[0].endsWith(join("my-skill", "SKILL.md")));
        }
        finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
    it("边界条件: 技能目录不存在时忽略", () => {
        assert.deepEqual(discoverSkillPaths(["/no/such/skills"]), []);
    });
    it("边界条件: 空目录无技能", () => {
        const empty = mkdtempSync(join(tmpdir(), "hapilon-empty-skills-"));
        try {
            assert.deepEqual(discoverSkillPaths([empty]), []);
        }
        finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });
});
describe("listFiles — 点文件过滤", () => {
    let dir;
    before(() => { dir = mkdtempSync(join(tmpdir(), "hapilon-dotfiles-")); });
    after(() => { try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch { } });
    it("边界条件: 隐藏文件（以 . 开头）被过滤", () => {
        writeFileSync(join(dir, ".hidden.md"), "hidden");
        writeFileSync(join(dir, "visible.md"), "visible");
        const result = listFiles(dir, "*.md");
        assert.deepEqual(result, [join(dir, "visible.md")], "隐藏文件不应出现在结果中");
    });
});
describe("discoverSkillPaths — 点目录过滤", () => {
    it("边界条件: 隐藏目录（以 . 开头）被跳过", () => {
        const base = mkdtempSync(join(tmpdir(), "hapilon-dotskills-"));
        try {
            mkdirSync(join(base, ".hidden-skill"), { recursive: true });
            writeFileSync(join(base, ".hidden-skill", "SKILL.md"), "hidden");
            mkdirSync(join(base, "visible-skill"), { recursive: true });
            writeFileSync(join(base, "visible-skill", "SKILL.md"), "visible");
            const result = discoverSkillPaths([base]);
            assert.equal(result.length, 1);
            assert.ok(result[0].endsWith(join("visible-skill", "SKILL.md")));
        }
        finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});
describe("readRules — 异常路径补充", () => {
    it("异常路径: 单文件读取失败（权限不足）静默跳过，不抛异常", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-badrule-"));
        try {
            writeFileSync(join(dir, "good.md"), "# good");
            // 用 EISDIR 模拟读取失败场景：目录不可读
            mkdirSync(join(dir, "bad.md")); // 文件名 .md 但是目录，readFileSync 会抛异常
            const result = readRules([dir]);
            assert.equal(result.length, 1, "good.md 应被加载");
            assert.equal(result[0].name, "good");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe("splitFrontmatter — 边界条件（通过 readRules 间接验证）", () => {
    it("边界条件: alwaysApply: \"false\"（YAML 引号写法）正确识别为 false", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-yamlquot-"));
        try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "r1.md"), '---\nalwaysApply: "false"\n---\n# body');
            writeFileSync(join(dir, "r2.md"), '---\nalwaysApply: "true"\n---\n# body');
            const result = readRules([dir]);
            assert.equal(result.length, 1, "alwaysApply: \"false\" 应被跳过");
            assert.equal(result[0].name, "r2", "alwaysApply: \"true\" 应保留");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("边界条件: alwaysApply: false（无引号）正确识别为 false", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-yamlbool-"));
        try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "r1.md"), "---\nalwaysApply: false\n---\n# body");
            const result = readRules([dir]);
            assert.equal(result.length, 0, "alwaysApply: false（无引号）应被跳过");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("边界条件: 未闭合的 frontmatter 正文包含开头的 ---", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-unclosed-"));
        try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "r1.md"), "---\nalwaysApply: true\n# body without closing");
            const result = readRules([dir]);
            assert.equal(result.length, 1, "无前端注释的规则默认 alwaysApply=true，应被包含");
            assert.ok(result[0].content.startsWith("---"), "未闭合前端注释：正文以 --- 开头");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe("collectUpward — 边界条件补充", () => {
    it("边界条件: home 为不存在路径时，遍历到文件系统根终止", () => {
        const dir = mkdtempSync(join(tmpdir(), "hapilon-up-nohome-"));
        try {
            mkdirSync(join(dir, ".hapilon"), { recursive: true });
            writeFileSync(join(dir, ".hapilon", "HAPILON.md"), "test");
            const result = collectUpward(dir, join(dir, "no-such-subdir"), "HAPILON.md");
            assert.equal(result.length, 1, "仍然发现 .hapilon/ 下的文件");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
