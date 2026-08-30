/**
 * format.ts — hapilon 共享格式化函数
 *
 * 当前仅由 hpl-system-prompt 扩展使用（assemble.ts 直接导入）。
 * 放在 shared/ 供未来扩展复用。
 */
/** XML 最小转义：用于短属性值（rule name、path、skill 字段），防止内容破坏 XML 结构 */
export function xmlEscape(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
