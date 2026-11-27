const pad2 = (n) => String(n).padStart(2, "0");
/** 本地时间 MM-DD HH:mm:ss；年份对会话内的消息没有信息量 */
export function formatMessageTime(ts) {
    const d = new Date(ts);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/**
 * 时间戳行：暗色、与消息左缩进对齐、补满整行（Container 的行都是定宽）。
 * 流式期间建的组件没有 timestamp，回落消息对象上的；两者都没有就不出这一行。
 */
export function messageTimeLine(comp, width, theme) {
    const ts = comp.timestamp ?? comp.lastMessage?.timestamp;
    if (ts === undefined)
        return undefined;
    return theme.fg("dim", " ".repeat(comp.outputPad).concat(formatMessageTime(ts)).padEnd(width));
}
// 每条 user / assistant 消息上方一行时间戳。钩子由补丁在两个消息组件的 render 里调用；
// 钩子缺席（裸 pi、print 模式、settings.messageTime=false）时补丁回落原样。
export default function messageTime(pi) {
    pi.on("session_start", (_event, ctx) => {
        const theme = ctx.ui?.theme;
        const enabled = pi.getSettings().messageTime !== false;
        const g = globalThis;
        g.__hapiMessageTime = enabled && theme?.fg
            ? (comp, width) => messageTimeLine(comp, width, theme)
            : undefined;
    });
}
