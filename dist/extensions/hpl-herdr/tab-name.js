/**
 * tab-name.ts — tab 标签的任务命名状态机（issue#75）。
 *
 * 两路触发共用一个状态机：底座是会话首条任务消息的首行截断（确定性兜底，
 * 保证每个新任务周期至少有一次像样的名字）；主力是模型经 rename_tab 在换
 * 任务时自报（它有全对话上下文，读得懂「继续昨天那个」是续聊而非新任务）。
 *
 * 写入通道是 ctx.setSessionName：pi 自己会把标题渲染成
 * 「π - <sessionName> - <cwd>」写进 OSC，herdr GUI 的 tab 跟随 OSC 标题，
 * 名字还随 session 文件持久、resume 后仍在——不跟 pi 抢终端标题，也不需要
 * 按宿主派发 pane rename。
 *
 * 保护是硬规则：会话名当前值 ≠ 我们最后一次设的值（用户 /name 等改过）
 * 就永久收手——动态改名踩人工名字是 Claude Code 实锤翻车的形态。
 * session 名随 session 存续，所以人工收手不随 session_start 重置，
 * 只重置「本会话已命名」的一次性标记，并把现有名收编为我们的基线。
 */
export const TAB_TITLE_MAX_CHARS = 6;
/** 取首个非空行，剥 markdown 前缀与行内标记，压空白，截到 maxChars（按码点切，不劈 emoji）。 */
export function sanitizeTitle(text, maxChars = TAB_TITLE_MAX_CHARS) {
    // herdr-core 转发的输入带来源包裹（hc send 语义），不剥会进标题
    const unwrapped = text.replace(/^<hc from="[^"]*">/, "").replace(/<\/hc>\s*$/, "");
    const firstLine = unwrapped.split("\n").find((line) => line.trim() !== "") ?? "";
    const cleaned = firstLine
        .replace(/^\s*(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)*/, "")
        .replace(/[`*_~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (cleaned === "")
        return undefined;
    const chars = [...cleaned];
    if (chars.length <= maxChars)
        return cleaned;
    let out = chars.slice(0, maxChars).join("");
    // 截断落在英文单词中间时丢掉残词（「帮我确认 p」→「帮我确认」），但结果不能短于 2 字
    const partial = out.match(/^(.*\S)\s+[A-Za-z0-9]{1,3}$/);
    if (partial && [...partial[1]].length >= 2)
        out = partial[1];
    return out.trimEnd();
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
    let namedThisSession = false;
    const attempt = (raw) => {
        if (manualOwned)
            return { ok: false, reason: "标签被人工或 orchestra 改过，不再自动改名" };
        const title = sanitizeTitle(raw, max);
        if (title === undefined)
            return { ok: false, reason: "标题为空" };
        if ((deps.sessionName.get() ?? "") !== ourLabel) {
            manualOwned = true;
            return { ok: false, reason: "标签被人工改过（/name），不再自动改名" };
        }
        deps.sessionName.set(title);
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
            // resume/新会话：现有 session 名收编为基线。若是人工起的，后续 divergence 检测照样能拦
            ourLabel = deps.sessionName.get() ?? "";
        },
    };
}
