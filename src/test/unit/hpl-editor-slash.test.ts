import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorizeLine, extractNames, isMidTextSlashBefore, midTextSlashFragment, wrapAutocomplete } from "../../extensions/hpl-editor-slash/slash.js";
import type { AutocompleteProviderLike, SuggestionItem } from "../../extensions/hpl-editor-slash/slash.js";

const ABORT = new AbortController().signal;

function makeCurrent(commands: Array<Record<string, string>>, builtin: SuggestionItem[] | null = null) {
	const calls = { suggestions: 0, apply: 0 };
	let lastArgs: { lines: string[]; cursorLine: number; cursorCol: number; force?: boolean } | undefined;
	const current: AutocompleteProviderLike = {
		commands,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			calls.suggestions++;
			lastArgs = { lines, cursorLine, cursorCol, force: options.force };
			return builtin ? { items: builtin, prefix: "/x" } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			calls.apply++;
			return { lines, cursorLine, cursorCol };
		},
	};
	return { current, calls, lastArgs: () => lastArgs };
}

describe("midTextSlashFragment()", () => {
	it("中段(逗号后)识别", () => {
		const before = "接下来是新需求, /design";
		assert.equal(midTextSlashFragment(before, before.length), "design");
	});
	it("片段可为空(/ 后无字符)", () => {
		assert.equal(midTextSlashFragment("看 /", 4), "");
	});
	it("行首片段也识别(委托优先,此处仅报告)", () => {
		assert.equal(midTextSlashFragment("/team", 5), "team");
	});
	it("无 slash 或非空白边界不识别", () => {
		assert.equal(midTextSlashFragment("hello", 5), null);
		assert.equal(midTextSlashFragment("a/b", 3), null);
		assert.equal(midTextSlashFragment("https://x", 9), null);
	});
	it("/ 后跟空白不是片段", () => {
		assert.equal(midTextSlashFragment("/team ", 6), null);
	});
});

describe("wrapAutocomplete()", () => {
	it("内置有结果时原样委托,不重复生成", async () => {
		const builtinItem: SuggestionItem = { value: "quit", label: "quit" };
		const { current, calls } = makeCurrent([{ name: "team" }], [builtinItem]);
		const wrapped = wrapAutocomplete(current);
		const result = await wrapped.getSuggestions(["/q"], 0, 2, { signal: ABORT });
		assert.deepEqual(result?.items, [builtinItem]);
		assert.equal(calls.suggestions, 1);
	});

	it("内置 null 且中段 slash → 借道内置行首分支(改写行文本+force:false)", async () => {
		const { current, calls, lastArgs } = makeCurrent([{ name: "team" }]);
		const wrapped = wrapAutocomplete(current);
		const before = "需求, /te";
		const result = await wrapped.getSuggestions([before], 0, before.length, { signal: ABORT });
		assert.equal(calls.suggestions, 1, "中段委托内置(模糊命中与 skill 裸名语义复用行首)");
		assert.deepEqual(lastArgs(), { lines: ["/te"], cursorLine: 0, cursorCol: 3, force: false });
		assert.equal(result, null, "内置 null 原样透传");
	});

	it("中段 slash 无匹配命令 → 内置 null 透传(不出空弹窗)", async () => {
		const { current } = makeCurrent([{ name: "team" }]);
		const wrapped = wrapAutocomplete(current);
		const before = "需求, /zz";
		const result = await wrapped.getSuggestions([before], 0, before.length, { signal: ABORT });
		assert.equal(result, null);
	});

	it("中段 slash → 内置返回的建议与 prefix 原样透传", async () => {
		const builtinItem: SuggestionItem = { value: "team", label: "team" };
		const { current } = makeCurrent([{ name: "team" }], [builtinItem]);
		const wrapped = wrapAutocomplete(current);
		const before = "需求, /te";
		const result = await wrapped.getSuggestions([before], 0, before.length, { signal: ABORT });
		assert.deepEqual(result, { items: [builtinItem], prefix: "/x" });
	});

	it("空片段(/ 刚打完)同样借道行首分支", async () => {
		const { current, lastArgs } = makeCurrent([{ name: "team" }], []);
		const wrapped = wrapAutocomplete(current);
		await wrapped.getSuggestions(["需求, /"], 0, 6, { signal: ABORT });
		assert.deepEqual(lastArgs(), { lines: ["/"], cursorLine: 0, cursorCol: 1, force: false });
	});

	it("无片段(非 slash 文本)原样委托,不改写参数", async () => {
		const { current, calls, lastArgs } = makeCurrent([{ name: "team" }], []);
		const wrapped = wrapAutocomplete(current);
		await wrapped.getSuggestions(["hello"], 0, 5, { signal: ABORT, force: true });
		assert.equal(calls.suggestions, 1);
		assert.deepEqual(lastArgs(), { lines: ["hello"], cursorLine: 0, cursorCol: 5, force: true });
	});

	it("行首 slash 仍委托内置(原行为不变)", async () => {
		const { current, calls } = makeCurrent([{ name: "team" }]);
		const wrapped = wrapAutocomplete(current);
		await wrapped.getSuggestions(["/te"], 0, 3, { signal: ABORT });
		assert.equal(calls.suggestions, 1);
	});

	it("applyCompletion:中段命令按内置公式插入(斜杠重写+尾随空格)", () => {
		const { current, calls } = makeCurrent([]);
		const wrapped = wrapAutocomplete(current);
		// "需求, " 4 字符 + "/te" 3 字符 → 光标在 7
		const result = wrapped.applyCompletion(["需求, /te"], 0, 7, { value: "team", label: "team" }, "/te");
		assert.equal(result.lines[0], "需求, /team ");
		assert.equal(result.cursorCol, 10);
		assert.equal(calls.apply, 0);
	});

	it("applyCompletion:行首命令委托内置", () => {
		const { current, calls } = makeCurrent([]);
		const wrapped = wrapAutocomplete(current);
		wrapped.applyCompletion(["/te"], 0, 3, { value: "team", label: "team" }, "/te");
		assert.equal(calls.apply, 1);
	});

	it("applyCompletion:含路径分隔的 prefix 委托内置(文件补全)", () => {
		const { current, calls } = makeCurrent([]);
		const wrapped = wrapAutocomplete(current);
		wrapped.applyCompletion(["see /sr/c"], 0, 9, { value: "x", label: "x" }, "/sr/c");
		assert.equal(calls.apply, 1);
	});
});

describe("colorizeLine()", () => {
	const names = new Set(["team", "team:open", "exit"]);
	const style = (text: string) => `[[${text}]]`;

	it("已知命令染色,未知不染", () => {
		assert.equal(colorizeLine("跑 /team 和 /nope 一下", names, style), "跑 [[/team]] 和 /nope 一下");
	});

	it("行首命令染色", () => {
		assert.equal(colorizeLine("/exit now", names, style), "[[/exit]] now");
	});

	it("URL 与路径不被误染", () => {
		assert.equal(colorizeLine("see https://x.com/a/b", names, style), "see https://x.com/a/b");
	});

	it("ANSI 转义区不受影响", () => {
		const line = "\x1b[7m \x1b[0m /team 剩余";
		const result = colorizeLine(line, names, style);
		assert.ok(result.includes("\x1b[7m \x1b[0m"), "光标反显保留");
		assert.ok(result.includes("[[/team]]"), "后续 token 染色");
	});

	it("无 slash 或空命令表原样返回", () => {
		assert.equal(colorizeLine("plain text", names, style), "plain text");
		assert.equal(colorizeLine("a /team", new Set(), style), "a /team");
	});
});

describe("isMidTextSlashBefore()", () => {
	it("中段 slash 片段为 true", () => {
		assert.equal(isMidTextSlashBefore("需求, /te"), true);
		assert.equal(isMidTextSlashBefore("看 /"), true);
	});
	it("非片段为 false", () => {
		assert.equal(isMidTextSlashBefore("hello"), false);
		assert.equal(isMidTextSlashBefore("a/b"), false);
		assert.equal(isMidTextSlashBefore("https://x"), false);
	});
});

describe("extractNames()", () => {

  it("数组空洞（补丁移除内置命令条目留下的 elision）不崩、跳过空槽", () => {
    // eslint-disable-next-line no-sparse-arrays
    const withHole = [{ name: "settings" }, undefined, { value: "x" }, null];
    const names = extractNames(withHole as never);
    assert.ok(names.has("settings"));
    assert.ok(names.has("x"));
  });

	it("SlashCommand 取 name,AutocompleteItem 取 value", () => {
		const names = extractNames([{ name: "team" }, { value: "exit" }, {}, { name: "" }]);
		assert.deepEqual([...names].sort(), ["exit", "team"]);
	});
});
