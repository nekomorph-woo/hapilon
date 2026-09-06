/**
 * snapshot.ts — 结构化限额快照（quota-cache 文件通道的数据模型）
 *
 * footer / 浮层共享：providers 原始解析各出一份 snapshot，
 * 落 JSON 文件供其它扩展读取（pi loader 模块隔离，不能走模块状态）。
 */
export function snapshotHot(snapshot) {
    return snapshot.windows.some((w) => w.percent >= 90);
}
/** footer 紧凑双窗口段："18%/5h~2h 76%/mo~9d" / "¥327" */
export function formatFooterSegment(snapshot, now) {
    if (snapshot.balanceCny !== undefined) {
        return `¥${snapshot.balanceCny}`;
    }
    return snapshot.windows
        .map((w) => {
        const base = `${Math.round(w.percent)}%/${w.window}`;
        if (w.resetAt === undefined)
            return base;
        const remainingMs = w.resetAt - now;
        if (remainingMs <= 0)
            return base;
        const minutes = Math.floor(remainingMs / 60000);
        const count = minutes < 60
            ? `${minutes}m`
            : minutes < 60 * 48
                ? `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`
                : `${Math.floor(minutes / 1440)}d`;
        return `${base}~${count}`;
    })
        .join(" ");
}
