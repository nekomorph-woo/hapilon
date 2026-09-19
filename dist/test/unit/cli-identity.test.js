import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCliIdentity, isSourceCheckout } from "../../cli/identity.js";
const ORIGINAL_HOME = process.env.HAPILON_HOME;
afterEach(() => {
    if (ORIGINAL_HOME === undefined)
        delete process.env.HAPILON_HOME;
    else
        process.env.HAPILON_HOME = ORIGINAL_HOME;
});
describe("deriveCliIdentity", () => {
    it("默认目录使用 hapilon 和短路径文案", () => {
        delete process.env.HAPILON_HOME;
        assert.deepEqual(deriveCliIdentity(), {
            isDev: false,
            cliName: "hapilon",
            homeDisplay: "~/.hapilon",
        });
    });
    it("开发目录使用 devhapi 和实际解析路径", () => {
        process.env.HAPILON_HOME = "~/.hapilon-dev";
        assert.deepEqual(deriveCliIdentity(), {
            isDev: true,
            cliName: "devhapi",
            homeDisplay: join(homedir(), ".hapilon-dev"),
        });
    });
    it("显式指定默认目录仍视为正式模式", () => {
        process.env.HAPILON_HOME = join(homedir(), ".hapilon");
        assert.equal(deriveCliIdentity().isDev, false);
    });
});
describe("isSourceCheckout", () => {
    const root = mkdtempSync(join(tmpdir(), "hapilon-identity-"));
    after(() => {
        rmSync(root, { recursive: true, force: true });
    });
    afterEach(() => {
        rmSync(join(root, "src"), { recursive: true, force: true });
    });
    it("包根存在 src/ 时为源码检出", () => {
        mkdirSync(join(root, "src"), { recursive: true });
        assert.equal(isSourceCheckout(join(root, "dist", "cli.js")), true);
    });
    it("包根无 src/ 时为安装包（发布 tarball 不含 src）", () => {
        assert.equal(isSourceCheckout(join(root, "dist", "cli.js")), false);
    });
});
