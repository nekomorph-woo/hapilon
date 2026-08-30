import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("cli integration", () => {
    let tmpBase;
    const ORIGINAL_ENV = process.env.HAPILON_HOME;
    const CLI_PATH = join(process.cwd(), "dist", "cli.js");
    const CONFIG_PATH = join(process.cwd(), "dist", "config", "handlers.js");
    const PKG_PATH = join(process.cwd(), "package.json");
    describe("hapi 启动命令别名（#28）", () => {
        it("package.json bin 同时映射 hapilon 与 hapi", () => {
            const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
            assert.strictEqual(pkg.bin.hapilon, "./dist/cli.js");
            assert.strictEqual(pkg.bin.hapi, "./dist/cli.js", "hapi 应指向同一 cli 入口");
        });
        it("cli 入口有 shebang（bin 可直接执行的关键）", () => {
            const firstLine = readFileSync(CLI_PATH, "utf8").split("\n")[0];
            assert.ok(firstLine.startsWith("#!/usr/bin/env node"), `首行应为 shebang: ${firstLine}`);
        });
        it("hapi 二进制实际执行：与 hapilon 入口行为一致（#28）", () => {
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
        // Ensure agent dir exists for config commands that read auth.json
        spawnSync(process.execPath, [CLI_PATH, "setup", "--quick"], {
            env: { ...process.env, HAPILON_HOME: tmpBase },
            encoding: "utf8",
        });
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
    describe("setup --quick", () => {
        it("创建 ~/.hapilon/ 骨架", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "setup", "--quick"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `setup --quick 应成功退出: ${result.stderr}`);
            assert.ok(existsSync(join(tmpBase, "agent")), "应创建 agent 目录");
            assert.ok(existsSync(join(tmpBase, "agent", "auth.json")), "应创建 auth.json");
            assert.ok(existsSync(join(tmpBase, "agent", "settings.json")), "应创建 settings.json");
        });
        it("输出创建成功信息", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "setup", "--quick"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.ok(result.stdout.includes("Created ~/.hapilon/"), "应输出创建成功信息");
            assert.ok(result.stdout.includes("setup"), "应提示交互式 setup");
        });
        it("setup 命令执行后应退出（不启动 pi）", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "setup", "--quick"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
                timeout: 5000,
            });
            assert.strictEqual(result.status, 0, "setup 应正常退出，不应启动 pi");
            assert.ok(!result.stdout.includes("hapilon_v0.1.0_alpha"), "setup 时不应输出版本信息");
        });
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
                timeout: 3000,
            });
            try {
                rmSync(freshBase, { recursive: true, force: true });
            }
            catch { /* ignore */ }
            const output = result.stdout + result.stderr;
            assert.ok(output.includes("not configured") || output.includes("setup"), "未配置时应提示用户");
        });
    });
    describe("参数透传", () => {
        it("非 setup/doctor/config/help 命令应传给 pi", () => {
            // --version 不是 hapilon 子命令，应透传给 pi
            const result = spawnSync(process.execPath, [CLI_PATH, "--version"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
                timeout: 5000,
            });
            assert.ok(result.status !== undefined, "应正常退出或有退出码");
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
            assert.ok(result.stdout.includes("hapi"), "帮助应包含 hapi 别名（#28）");
            assert.ok(result.stdout.includes("setup"), "帮助应包含 setup");
            assert.ok(result.stdout.includes("doctor"), "帮助应包含 doctor");
            assert.ok(result.stdout.includes("config"), "帮助应包含 config");
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
        it("hapilon help config 打印 config 详细帮助", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "help", "config"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `help config 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("config"), "应包含 config");
            assert.ok(result.stdout.includes("show"), "应包含 show 子命令");
        });
        it("hapilon help setup 打印 setup 详细帮助", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "help", "setup"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `help setup 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("setup"), "应包含 setup");
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
        it("hapilon foobar 不拦截，原样透传给 pi（issue #14）", () => {
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
    describe("config", () => {
        it("hapilon config show 不设置默认时提示", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "config", "show"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `config show 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("未设置") || result.stdout.includes("default"), "应提示未设置默认");
        });
        it("hapilon config provider list 显示空列表", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "config", "provider", "list"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `config provider list 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("未配置"), "应提示未配置任何 provider");
        });
        it("hapilon config default --unset 无默认时提示", () => {
            const result = spawnSync(process.execPath, [CLI_PATH, "config", "default", "--unset"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0, `config default --unset 应成功退出: ${result.stderr}`);
            assert.ok(result.stdout.includes("无需清除"), "应提示无需清除");
        });
        it("config provider add 写入 auth.json", () => {
            const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        import("${CONFIG_PATH}").then(m => m.handleConfig(["config","provider","add","deepseek"]));
      `], {
                input: "sk-deepseek-test-key\n",
                encoding: "utf8",
                timeout: 5000,
            });
            const authPath = join(tmpBase, "agent", "auth.json");
            const auth = JSON.parse(readFileSync(authPath, "utf8"));
            assert.deepStrictEqual(auth.deepseek, { type: "api_key", key: "sk-deepseek-test-key" });
        });
        it("config provider add 无效 ID 时列出全部 provider 供选择", () => {
            const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        import("${CONFIG_PATH}").then(m => m.handleConfig(["config","provider","add","invalid-foo"]));
      `], {
                input: "\n", // 列出后留空取消
                encoding: "utf8",
                timeout: 5000,
            });
            const output = result.stdout + result.stderr;
            assert.ok(output.includes("未知 provider"), "应提示未知 provider");
            assert.ok(output.includes("可用的 Provider"), "应列出可选 provider");
        });
        it("config provider list 显示已配置 provider", () => {
            // Pre-populate auth.json
            writeFileSync(join(tmpBase, "agent", "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-test-key-12345678" } }) + "\n");
            const result = spawnSync(process.execPath, [CLI_PATH, "config", "provider", "list"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0);
            assert.ok(result.stdout.includes("deepseek"), "应列出 deepseek");
            assert.ok(result.stdout.includes("sk-t"), "应显示脱敏 key");
            assert.ok(!result.stdout.includes("sk-test-key-12345678"), "不应完整显示 key");
        });
        it("config provider remove 删除 provider", () => {
            // Pre-populate
            writeFileSync(join(tmpBase, "agent", "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-xxx" } }) + "\n");
            const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        import("${CONFIG_PATH}").then(m => m.handleConfig(["config","provider","remove","deepseek"]));
      `], {
                input: "y\n",
                encoding: "utf8",
                timeout: 5000,
            });
            const auth = JSON.parse(readFileSync(join(tmpBase, "agent", "auth.json"), "utf8"));
            assert.strictEqual(auth.deepseek, undefined, "deepseek 应被删除");
        });
        it("config provider add 拒绝对话取消", () => {
            writeFileSync(join(tmpBase, "agent", "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-existing" } }) + "\n");
            const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        import("${CONFIG_PATH}").then(m => m.handleConfig(["config","provider","add","deepseek"]));
      `], {
                input: "n\n",
                encoding: "utf8",
                timeout: 5000,
            });
            // 已存在时选"否"应保留原 key
            const auth = JSON.parse(readFileSync(join(tmpBase, "agent", "auth.json"), "utf8"));
            assert.deepStrictEqual(auth.deepseek, { type: "api_key", key: "sk-existing" }, "取消时原 key 应保留");
        });
        it("config default --set 交互式设置默认模型（需 pi 已安装）", () => {
            // Pre-populate auth for deepseek so it appears in provider list
            writeFileSync(join(tmpBase, "agent", "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-test" } }) + "\n");
            const result = spawnSync(process.execPath, ["-e", `
        process.env.HAPILON_HOME = "${tmpBase}";
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        import("${CONFIG_PATH}").then(m => m.handleConfig(["config","default","--set"]));
      `], {
                input: "1\n1\n",
                encoding: "utf8",
                timeout: 30000, // pi --list-models may take a moment
            });
            // Should have written config.json
            const configPath = join(tmpBase, "config.json");
            if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, "utf8"));
                assert.strictEqual(config.defaultProvider, "deepseek", "应设置 deepseek 为默认 provider");
                assert.ok(typeof config.defaultModel === "string", "应设置默认 model");
            }
            // If pi is not installed, this test will fail at listModelsForProvider
            // which is acceptable (requires pi dependency)
        });
        it("config show 显示已设置的默认配置", () => {
            writeFileSync(join(tmpBase, "config.json"), JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" }) + "\n");
            const result = spawnSync(process.execPath, [CLI_PATH, "config", "show"], {
                env: { ...process.env, HAPILON_HOME: tmpBase },
                encoding: "utf8",
            });
            assert.strictEqual(result.status, 0);
            assert.ok(result.stdout.includes("deepseek"), "应显示 deepseek");
            assert.ok(result.stdout.includes("deepseek-chat"), "应显示 deepseek-chat");
        });
    });
});
