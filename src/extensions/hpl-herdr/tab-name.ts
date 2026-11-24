/**
 * tab-name.ts — tab 标签的任务命名状态机（issue#75）。
 *
 * 两个时机都自动触发，不再依赖模型自报：生成走进程内独立请求（haiku 档，对标
 * recap 的档位选择策略，不搭 recap 的车）。时机 1 是会话首条任务消息，必定生成；
 * 时机 2 对标 recap 触发（空闲到点且 agent 空闲），用户手动改过名就不生成。
 * 请求失败或输出不合规时回落首行截断（确定性兜底）。
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

import type { ResolvedTierModel, ResolvedTierModels } from "../hpl-model-tiers/resolved.js";

/** 标题显示宽度上限（终端列数）：汉字、全角、emoji 算 2 列，字母数字算 1 列 */
export const TAB_TITLE_MAX_COLUMNS = 24;
/** 时机 2 生成输入保留的近期任务消息条数 */
export const NAMING_RECENT_LIMIT = 3;
const NAMING_INPUT_MAX_CHARS = 300;

// V8 不支持 \p{East_Asian_Width}，按 Script 与全角区段枚举宽字符（半角假名算宽，只会截得更早）
const WIDE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u{FF01}-\u{FF60}\u{FFE0}-\u{FFE6}\u{3000}-\u{303F}]/u;

/** 单个码点占的终端列数：宽字符 2，组合符号 0，其余 1。 */
function charColumns(char: string): number {
	if (/\p{Mark}/u.test(char)) return 0;
	return WIDE_CHAR.test(char) ? 2 : 1;
}

/** 字符串占的终端列数。 */
export function displayWidth(text: string): number {
	let columns = 0;
	for (const char of text) columns += charColumns(char);
	return columns;
}

/** 取首个非空行，剥 markdown 前缀与行内标记，压空白，截到 maxColumns 列（不劈 emoji，英文不劈单词）。 */
export function sanitizeTitle(text: string, maxColumns: number = TAB_TITLE_MAX_COLUMNS): string | undefined {
	// herdr-core 转发的输入带来源包裹（hc send 语义），不剥会进标题
	const unwrapped = text.replace(/^<hc from="[^"]*">/, "").replace(/<\/hc>\s*$/, "");
	const firstLine = unwrapped.split("\n").find((line) => line.trim() !== "") ?? "";
	const cleaned = firstLine
		.replace(/^\s*(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)*/, "")
		.replace(/[`*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned === "") return undefined;
	let columns = 0;
	let out = "";
	for (const char of cleaned) {
		if (columns + charColumns(char) > maxColumns) break;
		out += char;
		columns += charColumns(char);
	}
	// 截断落在英文单词中间时丢掉残词（「Fix tab naming du」→「Fix tab naming」），但结果不能短于 2 列
	if (/^[A-Za-z0-9]/.test(cleaned.slice(out.length))) {
		const whole = out.replace(/\s*\S+$/, "");
		if (displayWidth(whole) >= 2) out = whole;
	}
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

/** 命名请求的提示词：弱模型约束要死，只要一个名字；风格靠例子定住，不靠否定句。 */
export function buildNamingPrompt(texts: readonly string[]): string {
	return "你在给终端会话的标签起名。根据任务内容输出一个主题名词短语作为标签名，最多 10 个字（英文不超过 20 个字母），语言跟任务内容一致。" +
		"例子：标签命名策略、发版冒烟测试、tab title strategy。" +
		"只输出标签名本身：不要解释、不要引号、不要句尾标点。\n任务内容：\n" +
		texts.join("\n---\n");
}

/** recap 同款档位策略：haiku 优先非推理候选，降级 sonnet；两档全空返回 undefined（调用侧回落当前会话模型）。 */
export function pickNamingTier(tiers: ResolvedTierModels): ResolvedTierModel | undefined {
	const pick = (list: ResolvedTierModel[]): ResolvedTierModel | undefined =>
		list.find((entry) => entry.reasoning === false) ?? list[0];
	return pick(tiers.haiku) ?? pick(tiers.sonnet);
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
	/** 生成器（进程内模型请求）；返回 undefined 或抛错时走截断兜底 */
	generate(texts: readonly string[]): Promise<string | undefined>;
	maxColumns?: number;
}): TabNamer {
	const max = deps.maxColumns ?? TAB_TITLE_MAX_COLUMNS;
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
				// 生成异常走截断兜底，生成器侧已告警
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
