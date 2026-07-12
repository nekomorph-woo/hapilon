2026-07-12 02:17: Hapilon 最小试验版本（v0.1.0-alpha） —— 构建 hapilon 的最小试验版本，可以，在终端输入 hapilon 命令启动，首先在控制台打印 hapilon_v0.1.0_alpha，然后启动 pi-coding-agent 0.80.6 的 TUI 交互式控制台，保留 Pi 原版 TUI 体验（stdio inherit）
2026-07-12 18:08: ~/.hapilon/ 用户目录 + 多 Provider 基建 —— 在用户 home 目录创建 ~/.hapilon/ 作为 Hapilon 的配置与管理中心，通过 PI_CODING_AGENT_DIR 让 pi 读取 ~/.hapilon/agent/ 而隔离 ~/.pi/agent/，并实现 hapilon setup 交互式引导用户配置多 provider 认证。
2026-07-12 20:46: ~/.hapilon/config.json + 默认模型选择与启动注入 —— 创建 hapilon 自有的 ~/.hapilon/config.json，存储默认 provider 和模型。用户通过交互式选择（从 Pi 运行时获取模型列表）设置默认模型，启动 hapilon 时自动作为 CLI 参数注入 Pi。
2026-07-12 20:46: hapilon config provider 独立管理命令 —— 提供 hapilon config provider 子命令组，独立管理 provider API key 的增删查，不再依赖 hapilon setup 全量重走。
2026-07-12 20:46: hapilon help 帮助命令 —— 为 hapilon CLI 增加 hapilon help / hapilon --help 帮助命令，统一展示所有可用子命令和用法。
