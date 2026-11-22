/**
 * tab-name.ts — herdr pane 标签的任务命名状态机（issue#75）。
 *
 * 两路触发共用一个状态机：底座是会话首条任务消息的首行截断（确定性兜底，
 * 保证每个新任务周期至少有一次像样的名字）；主力是模型经 rename_tab 在换
 * 任务时自报（它有全对话上下文，读得懂「继续昨天那个」是续聊而非新任务）。
 *
 * 保护是硬规则：标签当前值 ≠ 我们最后一次设的值（人工或 orchestra 改过）
 * 就永久收手——动态改名踩人工名字是 Claude Code 实锤翻车的形态；改名/查询
 * 通道一次失败也收手（herdr-app 不认 pane id，重试只会空转）。pane 标签
 * 跨会话存续，所以人工收手与通道收手不随 session_start 重置，只重置
 * 「本会话已命名」的一次性标记。
 */
export const TAB_TITLE_MAX_CHARS = 24;
/** 取首个非空行，剥 markdown 前缀与行内标记，压空白，截到 maxChars（按码点切，不劈 emoji）。 */
export function sanitizeTitle(text, maxChars = TAB_TITLE_MAX_CHARS) {
    const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "";
    const cleaned = firstLine
        .replace(/^\s*(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)*/, "")
        .replace(/[`*_~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (cleaned === "")
        return undefined;
    return [...cleaned].slice(0, maxChars).join("");
}
/** 底座命名的输入过滤：交互式、非排队续跑、非命令的首条用户输入才算任务消息。 */
export function qualifyingTaskInput(text, source, streamingBehavior) {
    if (source !== "interactive")
        return false;
    if (streamingBehavior !== undefined)
        return false;
    if (text.startsWith("/") || text.startsWith("!!"))
        return false;
    return true;
}
export function createTabNamer(deps) {
    const max = deps.maxChars ?? TAB_TITLE_MAX_CHARS;
    let ourLabel = "";
    let manualOwned = false;
    let broken = false;
    let namedThisSession = false;
    const attempt = (raw) => {
        if (manualOwned)
            return { ok: false, reason: "标签被人工或 orchestra 改过，不再自动改名" };
        if (broken)
            return { ok: false, reason: "改名通道不可用" };
        const title = sanitizeTitle(raw, max);
        if (title === undefined)
            return { ok: false, reason: "标题为空" };
        const pane = deps.readPane();
        if (pane === undefined) {
            broken = true;
            return { ok: false, reason: "查询不到本 pane，改名通道不可用" };
        }
        const current = pane.label ?? "";
        if (current !== ourLabel) {
            manualOwned = true;
            return { ok: false, reason: "标签被人工或 orchestra 改过，不再自动改名" };
        }
        if (!deps.rename(title)) {
            broken = true;
            return { ok: false, reason: "herdr 拒绝了改名" };
        }
        ourLabel = title;
        return { ok: true, label: title };
    };
    return {
        onUserInput(text) {
            if (namedThisSession)
                return;
            if (attempt(text).ok)
                namedThisSession = true;
        },
        renameTo(title) {
            return attempt(title);
        },
        resetSession() {
            namedThisSession = false;
        },
    };
}
