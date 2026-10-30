import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions, ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
const extensionPaths = ["hpl-add-dir", "hpl-system-prompt"].map((name) => resolve("dist/extensions", name, "index.js"));
function snapshot(dir) {
    return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [file.slice(dir.length + 1), readFileSync(file).toString("base64")];
    }).sort(([a], [b]) => a.localeCompare(b)));
}
async function setup(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "polaris-add-dir-")));
    const previous = { HOME: process.env.HOME, HAPILON_HOME: process.env.HAPILON_HOME };
    const home = join(root, "home");
    const cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    process.env.HAPILON_HOME = join(home, ".hapilon");
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
    });
    const loaded = await discoverAndLoadExtensions(extensionPaths, cwd, join(home, "agent"));
    const runtime = loaded.runtime;
    assert.deepEqual(loaded.errors, [], "测试接入：真实扩展加载无错误");
    assert.equal(loaded.extensions.length, 2);
    const session = SessionManager.inMemory(cwd);
    runtime.appendEntry = (type, data) => { session.appendCustomEntry(type, data); };
    // 本轮不调用模型；模型注册表不参与被测命令及提示组装。
    const runner = new ExtensionRunner(loaded.extensions, runtime, cwd, session, {});
    const notifications = [];
    runner.setUIContext({
        ...runner.getUIContext(),
        notify: (message, type) => { notifications.push({ message, type }); },
        setWidget: () => { },
    });
    const errors = [];
    runner.onError((error) => errors.push(error));
    await runner.emit({ type: "session_start", reason: "new" });
    function directory(name, files) {
        const dir = join(root, name);
        mkdirSync(dir);
        for (const [relative, content] of Object.entries(files)) {
            const file = join(dir, relative);
            mkdirSync(resolve(file, ".."), { recursive: true });
            writeFileSync(file, content);
        }
        return dir;
    }
    async function command(name, args = "") {
        const registered = runner.getCommand(name);
        assert.ok(registered, `测试接入：命令 ${name} 已注册`);
        const start = notifications.length;
        await registered.handler(args, runner.createCommandContext());
        return notifications.slice(start);
    }
    async function observe() {
        const listing = (await command("dirs")).map((n) => n.message).join("\n");
        const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "查看外部项目" }, { cwd });
        assert.deepEqual(errors, [], "测试接入：扩展事件无错误");
        const prompt = result.systemPromptOptions.forceSystemPrompt;
        assert.ok(prompt, "测试接入：最终提示存在");
        assert.ok(prompt.startsWith("<system_prompt>"), "测试接入：获得最终组装提示，而非回退提示");
        const external = prompt.match(/<external_directories>([\s\S]*?)<\/external_directories>/)?.[1] ?? "";
        t.diagnostic(JSON.stringify({ listing, external }));
        return { listing, prompt, external };
    }
    function check(results) {
        t.diagnostic(JSON.stringify({ checks: results }));
        assert.deepEqual(Object.entries(results).filter(([, passed]) => !passed).map(([name]) => name), [], "业务预期未满足");
    }
    return { cwd, directory, command, observe, check };
}
// bridge 与上下文缓存是模块级状态，场景串行且每次从 session_start 重建。
describe("Polaris：外部目录业务验收", { concurrency: false }, () => {
    it("POL-ADD-DIR-001 添加后模型获得正式约定", async (t) => {
        const given = await setup(t);
        const dir = given.directory("external", { ".hapilon/HAPILON.md": "POLARIS_CANONICAL_001", "data.txt": "保留文件" });
        const before = snapshot(dir);
        await given.command("add-dir", dir);
        const result = await given.observe();
        given.check({
            "列表只出现一次目录路径": result.listing.split(dir).length - 1 === 1,
            "最终上下文含目录": result.external.includes(dir),
            "最终上下文含正式约定": result.external.includes("POLARIS_CANONICAL_001"),
            "外部文件未改变": JSON.stringify(snapshot(dir)) === JSON.stringify(before),
        });
    });
    for (const canonical of [true, false]) {
        it(`POL-ADD-DIR-002/${canonical ? "mixed" : "legacy-only"} 旧位置不注入`, async (t) => {
            const given = await setup(t);
            const files = { "HAPILON.md": "POLARIS_OLD_ROOT_002", ".pi/HAPILON.md": "POLARIS_OLD_PI_002" };
            if (canonical)
                files[".hapilon/HAPILON.md"] = "POLARIS_CANONICAL_002";
            const dir = given.directory("external", files);
            await given.command("add-dir", dir);
            const result = await given.observe();
            given.check({
                "有效目录关联成功": result.listing.includes(dir) && result.external.includes(dir),
                "正式约定按实际文件提供": result.external.includes("POLARIS_CANONICAL_002") === canonical,
                "根目录旧内容未注入": !result.prompt.includes("POLARIS_OLD_ROOT_002"),
                "pi 旧内容未注入": !result.prompt.includes("POLARIS_OLD_PI_002"),
                "无正式文件时无约定段": canonical || !result.external.includes("#### HAPILON.md"),
            });
        });
    }
    it("POL-ADD-DIR-003 没有约定文件仍能添加", async (t) => {
        const given = await setup(t);
        const dir = given.directory("external", { "data.txt": "POLARIS_DATA_003" });
        const before = snapshot(dir);
        await given.command("add-dir", dir);
        const result = await given.observe();
        given.check({
            "列表只出现一次目录路径": result.listing.split(dir).length - 1 === 1,
            "最终上下文含目录": result.external.includes(dir),
            "没有虚构约定段": !result.external.includes("#### HAPILON.md"),
            "普通文件内容没有冒充约定": !result.prompt.includes("POLARIS_DATA_003"),
            "外部文件未改变": JSON.stringify(snapshot(dir)) === JSON.stringify(before),
        });
    });
    for (const variant of ["missing", "duplicate", "cwd"]) {
        it(`POL-ADD-DIR-004/${variant} 拒绝请求保持原状态`, async (t) => {
            const given = await setup(t);
            const dir = given.directory("existing", { "data.txt": "保留文件" });
            await given.command("add-dir", dir);
            const before = await given.observe();
            const files = snapshot(dir);
            const input = variant === "missing" ? join(given.cwd, "missing") : variant === "duplicate" ? dir : given.cwd;
            const feedback = await given.command("add-dir", input);
            const result = await given.observe();
            given.check({
                "请求得到拒绝反馈": feedback.some((item) => item.type === "error"),
                "列表完全不变": result.listing === before.listing,
                "外部上下文完全不变": result.external === before.external,
                "原有关联保持且无重复": result.listing.split(dir).length - 1 === 1,
                "没有创建不存在目录": variant !== "missing" || !existsSync(input),
                "外部文件未改变": JSON.stringify(snapshot(dir)) === JSON.stringify(files),
            });
        });
    }
    it("POL-ADD-DIR-005 移除不再注入且不损坏文件", async (t) => {
        const given = await setup(t);
        const removed = given.directory("removed", { ".hapilon/HAPILON.md": "POLARIS_REMOVED_005", "data.txt": "保留甲" });
        const retained = given.directory("retained", { ".hapilon/HAPILON.md": "POLARIS_RETAINED_005", "data.txt": "保留乙" });
        const files = [snapshot(removed), snapshot(retained)];
        await given.command("add-dir", removed);
        await given.command("add-dir", retained);
        const before = await given.observe();
        await given.command("remove-dir", removed);
        const result = await given.observe();
        given.check({
            "前置两目录已关联": before.listing.includes(removed) && before.listing.includes(retained),
            "前置两份正式约定已注入": before.external.includes("POLARIS_REMOVED_005") && before.external.includes("POLARIS_RETAINED_005"),
            "目标已从列表移除": !result.listing.includes(removed),
            "目标已从外部上下文移除": !result.external.includes(removed) && !result.prompt.includes("POLARIS_REMOVED_005"),
            "另一目录及约定保留": result.listing.includes(retained) && result.external.includes(retained) && result.external.includes("POLARIS_RETAINED_005"),
            "两个目录文件未改变": JSON.stringify([snapshot(removed), snapshot(retained)]) === JSON.stringify(files),
        });
    });
});
