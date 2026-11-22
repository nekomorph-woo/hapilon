/**
 * tab-name.ts — tab 标签的任务命名状态机（issue#75）。
 *
 * 两个时机都自动触发，不再依赖模型自报：生成走独立的 hapi -p 子进程（haiku
 * 档，对标 recap 的档位选择策略，但独立请求、不搭 recap 的车）。时机 1 是
 * 会话首条任务消息，必定生成；时机 2 对标 recap 触发（空闲到点且 agent 空闲），
 * 用户手动改过名就不生成。子进程失败或输出不合规时回落首行截断（确定性兜底）。
 *
 * 写入通道是 ctx.setSessionName：pi 自己会把标题渲染成
 * 「π - <sessionName> - <cwd>」写进 OSC，herdr GUI 的 tab 跟随 OSC 标题，
 * 名字还随 session 文件持久、resume 后仍在——不跟 pi 抢终端标题，也不需要
 * 按宿主派发 pane rename。
 *
 * 保护是硬规则：会话名当前值 ≠ 我们最后一次设的值（用户 /name 等改过）
 * 就永久收手——动态改名踩人工名字是 Claude Code 实锤翻车的形态。
 * session 名随 session 存续，所以人工收手不随 session_start 重置，
 * 只重置「本会话已命名」的一次性标记与近期任务 ring，并把现有名收编为基线。
 */

import type { ResolvedTierModels } from "../hpl-model-tiers/resolved.js";

export const TAB_TITLE_MAX_CHARS = 6;
/** 时机 2 生成输入保留的近期任务消息条数 */
export const NAMING_RECENT_LIMIT = 3;
const NAMING_INPUT_MAX_CHARS = 300;

/** 取首个非空行，剥 markdown 前缀与行内标记，压空白，截到 maxChars（按码点切，不劈 emoji）。 */
export function sanitizeTitle(text: string, maxChars: number = TAB_TITLE_MAX_CHARS): string | undefined {
	// herdr-core 转发的输入带来源包裹（hc send 语义），不剥会进标题
	const unwrapped = text.replace(/^<hc from="[^"]*">/, "").replace(/<\/hc>\s*$/, "");
	const firstLine = unwrapped.split("\n").find((line) => line.trim() !== "") ?? "";
	const cleaned = firstLine
		.replace(/^\s*(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)*/, "")
		.replace(/[`*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned === "") return undefined;
	const chars = [...cleaned];
	if (chars.length <= maxChars) return cleaned;
	let out = chars.slice(0, maxChars).join("");
	// 截断落在英文单词中间时丢掉残词（「帮我确认 p」→「帮我确认」），但结果不能短于 2 字
	const partial = out.match(/^(.*\S)\s+[A-Za-z0-9]{1,3}$/);
	if (partial && [...partial[1]].length >= 2) out = partial[1];
	return out.trimEnd();
}

/** 底座命名的输入过滤：交互式、非排队续跑、非命令的首条用户输入才算任务消息。 */
export function qualifyingTaskInput(
	text: string,
	source: string,
	streamingBehavior: string | undefined,
): boolean {
	if (source !== "interactive") return false;
	if (streamingBehavior !== undefined) return false;
	if (text.startsWith("/") || text.startsWith("!!")) return false;
	return true;
}

/** 命名子进程的提示词：弱模型约束要死，只要一个名字。 */
export function buildNamingPrompt(texts: readonly string[]): string {
	return "你在给终端会话的标签起名。根据任务内容输出一个 3-6 个字的标签名，概括当前正在做的任务。" +
		"只输出标签名本身：不要解释、不要引号、不要句尾标点。\n任务内容：\n" +
		texts.join("\n---\n");
}

/** recap 同款档位策略：haiku 优先非推理候选，降级 sonnet；两档全空返回 undefined（子进程用 pi 默认模型）。 */
export function namingModelRef(tiers: ResolvedTierModels): string | undefined {
	const pick = (list: ResolvedTierModels["haiku"]): ResolvedTierModels["haiku"][number] | undefined =>
		list.find((entry) => entry.reasoning === false) ?? list[0];
	const model = pick(tiers.haiku) ?? pick(tiers.sonnet);
	if (!model) return undefined;
	return `${model.provider}/${model.id}${model.thinking ? `:${model.thinking}` : ""}`;
}

export interface TabNamer {
	/** 时机 1：会话首条任务消息——本会话只此一次（成败都不重来） */
	onUserInput(text: string): Promise<void>;
	/** 时机 2：recap 触发时刻——人工改过名或正在生成时不生成 */
	onRecapFire(): Promise<void>;
	/** 会话边界：重置一次性标记与近期 ring，人工收手不重置，现有名收编为基线 */
	resetSession(): void;
}

export function createTabNamer(deps: {
	/** 读写 session 名（pi.ExtensionAPI）；读写都走同一处，divergence 才有单一定义 */
	sessionName: {
		get(): string | undefined;
		set(name: string): void;
	};
	/** 生成器（hapi -p 子进程）；返回 undefined 或抛错时走截断兜底 */
	generate(texts: readonly string[]): Promise<string | undefined>;
	maxChars?: number;
}): TabNamer {
	const max = deps.maxChars ?? TAB_TITLE_MAX_CHARS;
	let ourLabel = "";
	let manualOwned = false;
	let namedThisSession = false;
	let inFlight = false;
	const recent: string[] = [];

	const pushRecent = (text: string): void => {
		recent.push([...text].slice(0, NAMING_INPUT_MAX_CHARS).join(""));
		if (recent.length > NAMING_RECENT_LIMIT) recent.shift();
	};

	// 生成失败/不合规 → 截断兜底；两路都空就放弃（时机 2 还会再试）
	const applyTitle = (raw: string | undefined): boolean => {
		const title = sanitizeTitle(raw ?? "", max);
		if (title === undefined) return false;
		if ((deps.sessionName.get() ?? "") !== ourLabel) {
			manualOwned = true;
			return false;
		}
		deps.sessionName.set(title);
		ourLabel = title;
		return true;
	};

	const runGeneration = async (texts: readonly string[]): Promise<void> => {
		if (inFlight || manualOwned || texts.length === 0) return;
		inFlight = true;
		try {
			let generated: string | undefined;
			try {
				generated = await deps.generate(texts);
			} catch {
				// 生成异常走截断兜底，子进程侧已告警
			}
			if (!applyTitle(generated)) applyTitle(texts[texts.length - 1]);
		} finally {
			inFlight = false;
		}
	};

	return {
		async onUserInput(text) {
			pushRecent(text);
			if (namedThisSession) return;
			namedThisSession = true;
			await runGeneration([text]);
		},
		async onRecapFire() {
			await runGeneration([...recent]);
		},
		resetSession() {
			namedThisSession = false;
			recent.length = 0;
			// resume/新会话：现有 session 名收编为基线。若是人工起的，divergence 检测照样能拦
			ourLabel = deps.sessionName.get() ?? "";
		},
	};
}
