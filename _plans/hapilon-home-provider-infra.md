# TODO-1 实现计划：~/.hapilon/ 用户目录 + 多 Provider 基建

## Context

当前 hapilon 是裸启动器。本轮在 `~/.hapilon/` 建立**完全隔离**的配置目录：hapilon 管理所有 provider 凭证，不读用户 shell 环境变量，不依赖 `~/.pi/agent/`。

## 核心原则

**hapilon 提供一切。** 用户通过 `hapilon setup` 输入 API Key，写入 `auth.json`（pi 原生格式），spawn pi 时注入 `PI_CODING_AGENT_DIR` 指向 `~/.hapilon/agent/`。环境变量不再参与 provider 认证链。

## 实现方案

### 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `src/cli.ts` | 命令路由 + PI_CODING_AGENT_DIR 注入 |
| 新增 | `src/hapilon-home.ts` | `~/.hapilon/` 路径解析与目录创建 |
| 新增 | `src/setup.ts` | setup 交互 + quick + doctor |

### 1. src/cli.ts — 命令路由

main() 改为 async，首参识别：

```
hapilon          → 打印版本 → 检测 ~/.hapilon/ → spawn pi（注入 PI_CODING_AGENT_DIR）
hapilon setup    → 交互式 provider 配置
hapilon setup --quick → 创建骨架，跳过问答
hapilon doctor   → 诊断
hapilon [other]  → 原样传给 pi
```

关键点：
- `PI_CODING_AGENT_DIR` 始终注入，指向 `~/.hapilon/agent/`
- 不注入任何 API_KEY 环境变量——所有凭证走 `auth.json`
- `~/.hapilon/agent/` 不存在时打印警告但不阻止启动
- setup/doctor 用 `await import()` 懒加载

### 2. src/hapilon-home.ts — 路径解析

```typescript
hapilonHome()       → process.env.HAPILON_HOME ?? ~/.hapilon
ensureHapilonDirs() → 创建 {base, agent, sessions, logs, cache}，0700
```

### 3. src/setup.ts — 交互式 setup + doctor

**交互式流程：**

```
1. 逐个问常见 provider（DeepSeek, OpenAI, Anthropic, xAI, Google, Groq, Mistral, OpenRouter, ZAI）
   "你有 DeepSeek API Key？(y/N) " → y 则输入 key
2. "还有其他 provider？" → 列出剩余 provider，按 ID 添加
3. 写入 ~/.hapilon/agent/auth.json（pi 原生格式，所有 key 为字面量）
4. 打印摘要 + OAuth 提醒（`/login` 在 pi TUI 中操作）
```

**auth.json 写入规则：** 所有 key 都是字面量，无 env var 引用。

| 用户行为 | auth.json |
|----------|-----------|
| 输入 `sk-xxx` | `"deepseek": {"type": "api_key", "key": "sk-xxx"}` |
| 输入 `!op read ...` | 原样写入（pi 支持从 Keychain 获取） |
| 跳过（说 N） | 不写入 |
| 检测已有环境变量 | ❌ 不做——hapilon 不读 shell env |

**doctor 检查项：**
- Hapilon 版本
- Node.js >= 22.19
- `~/.hapilon/` 目录存在性
- `auth.json` 已配 provider 数和各 key 状态
- `PI_CODING_AGENT_DIR` 目标存在
- pi binary 可解析

## 验证步骤

```bash
# 1. 编译
npm run build

# 2. 快速 setup（创建空骨架）
rm -rf ~/.hapilon && node dist/cli.js setup --quick

# 3. 交互式 setup（配几个 provider）
node dist/cli.js setup

# 4. 正常启动→pi 使用 ~/.hapilon/agent/auth.json
node dist/cli.js

# 5. 诊断
node dist/cli.js doctor

# 6. 参数透传
node dist/cli.js --model deepseek -p "hello"

# 7. 隔离验证：未配 provider 在 /model 中应显示"不可用"
node dist/cli.js  # 进 TUI → /model

# 8. 权限检查
ls -la ~/.hapilon/agent/auth.json  # 应是 -rw------- (0600)
```
