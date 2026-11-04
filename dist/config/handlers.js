/**
 * config/handlers.ts — config 子命令处理（show）
 *
 * provider/model 配置已交给 pi 原生（TUI /login、/model 与 auth.json 管理），
 * 本命令只剩一句指路说明。
 */
export function handleConfig(_args) {
    console.log("默认 provider/model 由 Pi 原生 agent/settings.json 管理，请在 Pi 的 /model 中使用 Ctrl+S 保存。");
}
