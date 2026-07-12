# TODO 清单

> 当前任务

---

## [ ] TODO-1：~/.hapilon/ 用户目录 + 多 Provider 基建

### 目标

在用户 home 目录创建 `~/.hapilon/` 作为 Hapilon 的配置与管理中心，通过 `PI_CODING_AGENT_DIR` 让 pi 读取 `~/.hapilon/agent/` 而隔离 `~/.pi/agent/`，并实现 `hapilon setup` 交互式引导用户配置多 provider 认证。

### 实现要点

| 项目 | 内容 |
|------|------|
| 用户目录 | `~/.hapilon/`（由 `HAPILON_HOME` 控制） |
| Agent 目录 | `~/.hapilon/agent/` → 设为 `PI_CODING_AGENT_DIR` |
| Provider 策略 | 依赖 Pi 内置 33 个 provider，不重复定义模型 |
| 认证策略 | `auth.json` 字面量 + Pi 原生 OAuth `/login`（hapilon 不读 shell env） |
| 命令 | `hapilon setup`（交互式引导）+ `hapilon setup --quick`（仅创建骨架） |
| 启动检测 | `~/.hapilon/agent/` 不存在时输出引导但不阻止启动 |

### 认证策略

hapilon 不读也不写用户 shell 环境变量，所有凭证通过 `auth.json` 管理——隔离彻底。

| 认证方式 | 配置方式 | 适用场景 |
|----------|----------|----------|
| `auth.json` 字面量 | `hapilon setup` 交互式输入 | **hapilon 方案**，持久化到文件 |
| OAuth `/login` | Pi 内置交互式登录（在 pi TUI 中操作） | Codex / Claude Pro / GitHub Copilot |
| CLI `--api-key` | `hapilon --api-key sk-xxx` | 单次运行临时覆盖 |

### 验收标准

- [ ] `hapilon setup`（交互）能引导配置 3+ provider
- [ ] `hapilon setup --quick` 创建骨架目录不询问
- [ ] spawn pi 时 `PI_CODING_AGENT_DIR` 指向 `~/.hapilon/agent/`
- [ ] Pi TUI 中 `/model` 能看到已配 provider 的模型
- [ ] OAuth provider 可通过 `/login` 正常认证
- [ ] `auth.json` 中的 key 为字面量，无 `$ENV_VAR` 引用
- [ ] 不 setup 也能 `hapilon` 启动（只是无已配 provider）
- [ ] `~/.pi/agent/` 不受 Hapilon 影响
