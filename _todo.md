# TODO 清单

> 当前任务

---

## [~] TODO-2：~/.hapilon/config.json + 默认模型选择与启动注入

### 目标

创建 hapilon 自有的 `~/.hapilon/config.json`，存储默认 provider 和模型。用户通过交互式选择（从 Pi 运行时获取模型列表）设置默认模型，启动 hapilon 时自动作为 CLI 参数注入 Pi。

### 实现要点

| 项目 | 内容 |
|------|------|
| 配置文件 | `~/.hapilon/config.json`（hapilon 自有，不操作 Pi settings.json） |
| 存储结构 | `{ "defaultProvider": "deepseek", "defaultModel": "deepseek-chat" }` |
| 模型列表来源 | spawn `pi --list-models` 运行时获取（方案 B），解析表格输出 |
| 启动注入 | `cli.ts` 读 config.json → 用户未传 --model/--provider 时注入默认值 |
| 用户参数优先 | 显式传 `--model` / `--provider` 时覆盖默认 |
| 新增命令 | `hapilon config show`、`hapilon config default --set`、`hapilon config default --unset` |

### 交互流程（hapilon config default --set）

```
已配置 auth 的 Provider:
  1. deepseek   (DeepSeek)
  2. openai     (OpenAI)

选择默认 Provider [1-2]: 1

DeepSeek 可用模型（来自 pi --list-models）:
  1. deepseek-chat
  2. deepseek-reasoner

选择默认模型 [1-2]: 1

✅ 已保存: defaultProvider=deepseek, defaultModel=deepseek-chat
```

### 验收标准

- [ ] `~/.hapilon/config.json` 由 hapilon 管理，Pi 不读写此文件
- [ ] `hapilon config show` 展示当前默认配置
- [ ] `hapilon config default --set` 交互式：列出已配 provider → 选 provider → spawn pi --list-models → 筛选模型 → 选模型 → 保存
- [ ] `hapilon config default --unset` 清除默认配置
- [ ] `hapilon`（无参数）启动时自动注入 `--provider <X> --model <Y>`
- [ ] `hapilon --model gpt-4o` 用户参数覆盖默认，不注入 config 中的 model
- [ ] `hapilon --provider openai` 用户参数覆盖默认 provider
- [ ] 未设置默认时 `hapilon` 行为和现在一致（不注入额外参数）
- [ ] `hapilon setup` 行为不变（仍为初始化引导）

---

## [~] TODO-3：hapilon config provider 独立管理命令

### 目标

提供 `hapilon config provider` 子命令组，独立管理 provider API key 的增删查，不再依赖 `hapilon setup` 全量重走。

### 实现要点

| 项目 | 内容 |
|------|------|
| `hapilon config provider list` | 列出 `auth.json` 中已配置的 provider（key 脱敏显示） |
| `hapilon config provider add <id>` | 交互式输入 API key → 写入 `auth.json`（Pi 原生格式） |
| `hapilon config provider remove <id>` | 从 `auth.json` 删除指定 provider |
| 去重 | add 已存在的 provider 时提示"已配置，将覆盖" |
| 校验 | provider id 必须在 `ALL_PROVIDERS` 中 |
| setup 不变 | `hapilon setup` 保持初始化引导，不耦合 CRUD |

### 验收标准

- [ ] `hapilon config provider list` 列出已配置 provider + 脱敏 key（`sk-a1…xyz9`）
- [ ] `hapilon config provider add deepseek` → 提示输入 key → 写入 auth.json → 权限 0600
- [ ] `hapilon config provider add deepseek`（重复）→ 提示已存在，确认覆盖
- [ ] `hapilon config provider add foo`（无效 id）→ 报错提示未知 provider
- [ ] `hapilon config provider remove deepseek` → 确认后删除 → auth.json 更新
- [ ] `hapilon config provider remove deepseek`（不存在）→ 提示未配置
- [ ] `hapilon setup` 行为不变
- [ ] `hapilon doctor` 仍能正确读取并展示 provider 信息

---

## [~] TODO-4：hapilon help 帮助命令

### 目标

为 hapilon CLI 增加 `hapilon help` / `hapilon --help` 帮助命令，统一展示所有可用子命令和用法。

### 实现要点

| 项目 | 内容 |
|------|------|
| `hapilon --help` / `hapilon -h` | 打印所有 hapilon 子命令概览（简要描述 + 用法） |
| `hapilon help` | 同上 |
| `hapilon help <command>` | 打印指定命令的详细帮助（如 `hapilon help config`、`hapilon help setup`） |
| 未知命令提示 | 输入未知命令时提示 `hapilon help` 而非静默透传给 Pi |
| 命令注册 | 建议提取命令定义到统一注册表，help 和路由共用，避免手动维护 |

### 命令概览示例

```
hapilon — Pi Coding Agent 启动器

用法:
  hapilon [options]                 启动 Pi TUI 交互
  hapilon <command> [args]          执行子命令

命令:
  setup         初始化 ~/.hapilon/ 和 provider 认证
  doctor        诊断 hapilon 配置状态
  config        管理 hapilon 配置（默认模型、provider）
  help          显示帮助信息

选项:
  --help, -h    显示此帮助
  其余选项透传给 Pi Coding Agent
```

### 验收标准

- [ ] `hapilon --help` 和 `hapilon -h` 打印命令概览
- [ ] `hapilon help` 打印命令概览
- [ ] `hapilon help setup` 打印 setup 详细帮助
- [ ] `hapilon help config` 打印 config 子命令树（config show / config default / config provider）
- [ ] `hapilon help doctor` 打印 doctor 详细帮助
- [ ] 输入未知命令（如 `hapilon foobar`）→ 提示"未知命令，输入 hapilon help 查看帮助"
- [ ] help 输出不依赖 Pi（不需要 spawn pi 进程）
