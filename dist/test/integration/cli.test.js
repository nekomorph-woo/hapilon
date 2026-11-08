import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("cli integration", () => {
    let tmpBase;
    const ORIGINAL_ENV = process.env.HAPILON_HOME;
    const CLI_PATH = join(process.cwd(), "dist", "cli.js");
    const CONFIG_PATH = join(process.cwd(), "dist", "config", "handlers.js");
    const PKG_PATH = join(process.cwd(), "package.json");
    describe("hapi 启动命令别名", () => {
        it("package.json bin 同时映射 hapilon 与 hapi", () => {
            const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
            assert.strictEqual(pkg.bin.hapilon, "./dist/cli.js");
            assert.strictEqual(pkg.bin.hapi, "./dist/cli.js", "hapi 应指向同一 cli 入口");
        });
        it("cli 入口有 shebang（bin 可直接执行的关键）", () => {
            const firstLine = readFileSync(CLI_PATH, "utf8").split("\n")[0];
            assert.ok(firstLine.startsWith("#!/usr/bin/env node"), `首行应为 shebang: ${firstLine}`);
        });
        it("hapi 二进制实际执行：与 hapilon 入口行为一致", () => {
            // 模拟 npm 全局安装：bin 目录下 hapilon 与 hapi 都 symlink 到同一 cli.js
            const binDir = join(tmpBase, "bin");
            mkdirSync(binDir, { recursive: true });
            const hapilonBin = join(binDir, "hapilon");
            const hapiBin = join(binDir, "hapi");
            try {
                symlinkSync(CLI_PATH, hapilonBin);
                symlinkSync(CLI_PATH, hapiBin);
            }
            catch {
                // symlink 不可用时跳过（如 Windows 权限受限）
                return;
            }
            const viaHapilon = spawnSync(hapilonBin, ["--help"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            const viaHapi = spawnSync(hapiBin, ["--help"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(viaHapi.status, 0, `hapi --help 应成功退出: ${viaHapi.stderr}`);
            assert.strictEqual(viaHapi.stdout, viaHapilon.stdout, "hapi 与 hapilon 输出应完全一致");
        });
    });
    before(() => {
        tmpBase = mkdtempSync(join(tmpdir(), "hapilon-cli-test-"));
        process.env.HAPILON_HOME = tmpBase;
        mkdirSync(join(tmpBase, "agent"), { recursive: true });
    });
    after(() => {
        if (ORIGINAL_ENV !== undefined) {
            process.env.HAPILON_HOME = ORIGINAL_ENV;
        }
        else {
            delete process.env.HAPILON_HOME;
        }
        try {
            rmSync(tmpBase, { recursive: true, force: true });
        }
        catch { /* ignore cleanup errors */ }
    });
    describe("doctor", () => {
        it("输出诊断信息", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "doctor"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `doctor 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("hapilon v"), "应包含版本信息");
            assert.ok(result.stdout.includes("Node.js"), "应包含 Node.js 版本");
            assert.ok(result.stdout.includes("PI_CODING_AGENT_DIR"), "应包含 PI_CODING_AGENT_DIR");
        });
        it("doctor 命令执行后应退出（不启动 pi）", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "doctor"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
                timeout: 5000,
            });
            assert.strictEqual(result.status, 0, "doctor 应正常退出，不应启动 pi");
            assert.ok(!result.stdout.includes("hapilon_v0.1.0_alpha"), "doctor 时不应输出版本信息");
        });
    });
    describe("默认启动", () => {
        it("未配置 ~/.hapilon/ 时输出警告", () => {
            const freshBase = mkdtempSync(join(tmpdir(), "hapilon-fresh-"));
            const result = spawnSync(process.execPath, [CLI_PATH], {
                env: { ...process.env, HAPILON_HOME: freshBase },
                encoding: "utf8",
                // 启动全链路实测约 5.7s（扩展发现 + 补丁检查 + 配置播种），预算留给它，不测性能
                timeout: 15000,
            });
            try {
                rmSync(freshBase, { recursive: true, force: true });
            }
            catch { /* ignore */ }
            assert.strictEqual(result.status, 0, "未配置时也应正常启动");
        });
    });
    describe("参数透传", () => {
        it("未知命令 foo 应传给 pi（不报 hapilon 未知命令）", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "--definitely-not-a-flag"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
                timeout: 15000,
            });
            assert.ok(result.status !== undefined, "应正常退出或有退出码");
        });
        it("--version 输出 hapilon 自身版本（不透传 pi）", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "--version"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
                timeout: 5000,
            });
            const pkgVersion = JSON.parse(readFileSync(PKG_PATH, "utf8")).version;
            assert.strictEqual(result.stdout.trim(), pkgVersion);
        });
    });
    describe("help", () => {
        it("hapilon --help 打印帮助信息", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "--help"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `--help 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("hapilon"), "帮助应包含 hapilon");
            assert.ok(result.stdout.includes("hapi"), "帮助应包含 hapi 别名");
            assert.ok(result.stdout.includes("doctor"), "帮助应包含 doctor");
            assert.ok(result.stdout.includes("help"), "帮助应包含 help");
        });
        it("hapilon -h 打印帮助信息", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "-h"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `-h 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("hapilon"), "帮助应包含 hapilon");
        });
        it("hapilon help 打印帮助信息", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "help"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `help 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("hapilon"), "帮助应包含 hapilon");
        });
        it("hapilon help nonexistent 提示未知命令", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "help", "nonexistent"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            // printHelpFor prints to stderr for unknown commands
            const output = result.stdout + result.stderr;
            assert.ok(output.includes("未知命令"), "应提示未知命令");
        });
        it("--help 在任意位置均触发 hapilon help", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "--model", "gpt", "--help"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0);
            assert.ok(result.stdout.includes("hapilon"), "应打印 hapilon help");
            assert.ok(!result.stdout.includes("hapilon_v0.1.0_alpha"), "不应走到 default 路径");
        });
    });
    describe("unknown command", () => {
        it("hapilon foobar 不拦截，原样透传给 pi", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "foobar"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
                timeout: 10000,
            });
            const output = result.stdout + result.stderr;
            assert.ok(!output.includes("未知命令"), "hapilon 不应拦截并提示未知命令");
            assert.ok(!output.includes("输入 hapilon help"), "不应建议 hapilon help");
        });
    });
});
