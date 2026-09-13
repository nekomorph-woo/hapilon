/**
 * derive-allow.ts — 从命令推导保守的通配 allow 建议
 *
 * confirm 弹窗"通配允许"入口的默认值：取复合命令最后一段的前两个 token 加 `*`。
 * 纯函数，仅作建议——用户可在弹窗内编辑。
 */
/**
 * 推导前缀通配建议。
 *   `git push origin main`      → `git push*`
 *   `cd /proj && npm install x` → `npm install*`
 *   `git push\ngit push origin` → `git push*`（换行/分号视作复合分隔）
 */
export function deriveAllowPattern(command) {
    const lastSegment = command
        .split(/&&|;|\n/)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .pop() ?? "";
    const tokens = lastSegment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return "";
    return `${tokens.slice(0, 2).join(" ")}*`;
}
