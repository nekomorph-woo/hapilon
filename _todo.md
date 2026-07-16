# TODO 清单

> 当前任务：OS 沙箱集成（macOS 优先）

---

## [ ] TODO-12：hapilon --sandbox — macOS Seatbelt 沙箱集成

### 目标

集成 `@anthropic-ai/sandbox-runtime` 为 hapilon 提供 `--sandbox` 选项。macOS 用 Seatbelt 内核级隔离，Linux 用 bubblewrap，Windows 暂不处理（依赖现有 safety-gate + protected-paths 两层防护）。

### 实现要点

| 项目 | 内容 |
|------|------|
| npm 依赖 | `@anthropic-ai/sandbox-runtime` |
| CLI flag | `--sandbox` |
| 集成位置 | `cli.ts` — spawn pi 前用 `SandboxManager.wrapWithSandbox()` 包裹命令 |
| 配置文件 | 复用 `~/.srt-settings.json` 或 hapilon 内置默认沙箱策略 |
| macOS | Seatbelt（系统内置，零安装） |
| Linux | bubblewrap（需 `apt-get install bubblewrap socat ripgrep`） |
| Windows | 不启动沙箱，打印提示 "Windows 暂不支持 --sandbox，使用命令+文件策略保护" |
| 沙箱策略 | 默认 denyWrite 除项目目录 + /tmp；denyRead 保护 ~/.ssh/~/.aws/~/.netrc；网络全允许 |
| 与现有安全层 | 独立——`--sandbox` 是内核层兜底，safety-gate + protected-paths 是扩展层拦截，两层可叠加 |

### 验收标准

- [ ] `npm install @anthropic-ai/sandbox-runtime` 成功
- [ ] `hapilon --sandbox` 在 macOS 上以 Seatbelt 沙箱启动 Pi
- [ ] 沙箱内 Agent 尝试 `cat ~/.ssh/id_rsa` → Operation not permitted
- [ ] 沙箱内 Agent 正常读写项目目录文件
- [ ] `hapilon`（不加 --sandbox）行为不变
- [ ] Linux 上 `hapilon --sandbox` 用 bubblewrap（需预先安装依赖）
- [ ] Windows 上 `hapilon --sandbox` 打印提示并降级为无沙箱运行
- [ ] 与 `--no-safety` 独立——可以同时或单独使用
