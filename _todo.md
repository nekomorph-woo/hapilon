# TODO 清单

> 当前任务：Pi 启动画面自定义 — Claude Code 风格头部

---

## [~] TODO-19：cli.ts 启动画面清理

### 目标

移除 hapilon 版本打印、屏蔽 Pi 自带版本检查/更新通知、设置静默启动。

### 实现要点

| 项目 | 内容 |
|------|------|
| 移除 console.log | 删除 `cli.ts:78` 的 `console.log("hapilon_v0.1.0_alpha")` |
| 跳过 Pi 版本检查 | spawn 时注入 `PI_SKIP_VERSION_CHECK=1` 环境变量 |
| 静默启动 | 通过 hapilon config-io 设置 Pi settings `quietStartup: true`（写入 `~/.hapilon/agent/settings.json`） |
| 扩展路径传递 | 将 `discoverExtensions()` 结果通过 env var 或文件传递给 header 扩展 |
| 安全提示 | 安全提示保留（`--no-safety` 仍然可见） |

### 验收标准

- [ ] 启动 hapilon 后不再看到 `hapilon_v0.1.0_alpha` 打印
- [ ] 启动后不再看到 Pi 的 `pi v0.80.8` 版本头和快捷键提示
- [ ] 启动后不再看到 `[Extensions]` 等加载资源列表
- [ ] 启动后不再看到 `Update Available` 通知
- [ ] cli.ts 修改不破坏 `--mode` / `--print` 非交互模式

---

## [~] TODO-20：hpl-startup-header — Claude Code 风格自定义头部

### 目标

新建 `hpl-startup-header` 扩展，在 Pi 启动时通过 `ctx.ui.setHeader()` 展示 Hapilon 品牌头部。

### 实现要点

| 项目 | 内容 |
|------|------|
| 注册方式 | `pi.on("session_start", ...)` + `ctx.ui.setHeader(factory)` |
| 参考实现 | `hpl-footer/index.ts` 的 `setFooter` 模式 + Pi 官方 `custom-header.ts` 示例 |
| Header 布局 | Claude Code 风格：Hapilon 名称+版本 → Welcome back → Provider+Model → workspace 全路径 → Pi 版本更新（可选）→ 扩展列表 |
| Provider+Model 来源 | `ctx.model?.id` + `ctx.model?.name` |
| workspace 来源 | `ctx.cwd` |
| 扩展列表来源 | cli.ts 通过环境变量 `HAPILON_EXTENSIONS` 传递（JSON 数组） |
| Pi 版本检查 | 自行请求 `https://pi.dev/api/latest-version`（或省略此部分保持简洁） |
| 文件结构 | `src/extensions/hpl-startup-header/index.ts` + `content.ts`（header 组件） |

### 验收标准

- [ ] 启动 hapilon 后看到 Hapilon 品牌 header（名称 + 版本号）
- [ ] header 包含 "Welcome back!" 问候语
- [ ] header 包含当前 provider 名称 + model 名称
- [ ] header 包含当前 workspace 全路径
- [ ] header 包含已加载的 hapilon 扩展列表
- [ ] 非 TUI 模式（`--print` / `--mode`）下不崩溃
- [ ] 单元测试覆盖 header 渲染逻辑
