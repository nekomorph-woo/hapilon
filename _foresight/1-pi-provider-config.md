# Pi Coding Agent 项目级 Provider 配置

> 一句话概括：如何在项目根目录配置 pi 的 provider（模型供应商），而不使用 `~/.pi/agent` 全局目录，让每个项目的模型配置相互隔离。

## 核心概念

### Pi 的配置分层

Pi 有两层配置：

| 层级 | 路径 | 作用域 |
|------|------|--------|
| 全局 | `~/.pi/agent/` | 所有项目 |
| 项目级 | `.pi/`（项目根目录下）| 仅当前项目 |

全局路径由环境变量 `PI_CODING_AGENT_DIR` 控制。**改掉这个变量，就能把「全局」目录指向项目本地**。

### 关键环境变量

```
PI_CODING_AGENT_DIR     →  agent 目录（默认 ~/.pi/agent）
PI_CODING_AGENT_SESSION_DIR →  会话目录（默认 ~/.pi/agent/sessions）
```

### Provider 是什么

Provider 就是一个「模型供应商」。Pi 内置支持 Anthropic、OpenAI、DeepSeek、Google Gemini、xAI 等 30+ 个 provider。你要做的就是把它们的 API Key 告诉 pi，不管用什么方式。

## 主流方案对比

| 方案 | 隔离性 | 复杂度 | 适用场景 |
|------|--------|--------|----------|
| **方案 A：PI_CODING_AGENT_DIR 指向项目目录** | ✅ 好 | 🟢 低 | 单个项目，一两个 provider |
| **方案 B：Extension 编程注册 provider** | ✅ 最好 | 🟡 中 | 多 provider，需要完全自定义 |
| **方案 C：.pi/settings.json 设默认值** | ⚠️ 仅默认值 | 🟢 低 | 只设 defaultProvider/defaultModel |

## 方案 A：环境变量隔离（推荐入门）

通过 Hapilon 启动器把 `PI_CODING_AGENT_DIR` 指向项目目录。

### 思路

pi 的 `getAgentDir()` 函数逻辑是：

```
如果设置了 PI_CODING_AGENT_DIR → 用它
否则 → ~/.pi/agent
```

### 配置步骤

**1. 在项目根创建 agent 目录结构：**

```
.hapilon/agent/
├── models.json      # provider 定义
├── auth.json        # API Key 存储
└── settings.json    # 全局设置（可选）
```

**2. 在 `models.json` 里定义 provider：**

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek V4 Pro",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 16384,
          "cost": { "input": 0.5, "output": 2.0, "cacheRead": 0.1, "cacheWrite": 0.5 }
        }
      ]
    },
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "apiKey": "$OPENAI_API_KEY",
      "models": [
        {
          "id": "gpt-5.1",
          "name": "GPT-5.1",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 16384,
          "cost": { "input": 1.5, "output": 8.0, "cacheRead": 0.3, "cacheWrite": 1.8 }
        }
      ]
    }
  }
}
```

**3. 在 `auth.json` 里存 API Key：**

```json
{
  "deepseek": { "type": "api_key", "key": "sk-your-deepseek-key" },
  "openai": { "type": "api_key", "key": "sk-your-openai-key" }
}
```

**4. Hapilon 启动时注入环境变量：**

在 `src/cli.ts` 的 `main()` 中设置：

```typescript
const child = spawn(process.execPath, [piCli, ...forwarded], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: join(process.cwd(), ".hapilon", "agent"),
  },
});
```

### API Key 的高级写法

`models.json` 和 `auth.json` 中的 `apiKey` 支持三种写法：

```json
// 1. 环境变量引用（推荐）
"apiKey": "$DEEPSEEK_API_KEY"

// 2. 命令行提取（如 macOS Keychain、1Password CLI）
"apiKey": "!security find-generic-password -ws 'deepseek'"
"apiKey": "!op read 'op://vault/item/credential'"

// 3. 直接写（仅本地开发）
"apiKey": "sk-abc123..."
```

## 方案 B：Extension 编程注册（最灵活）

如果你想要更细的控制——比如动态获取模型列表、定制请求头、或者不想手动维护 JSON——可以用 Extension。

### 思路

在 Hapilon 的 extension 里调用 `pi.registerProvider()` 注册 provider，这样 provider 和项目代码绑定在一起。

### 示例：在 `src/extension.ts` 中注册

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hapilonExtension(pi: ExtensionAPI) {
  // 用环境变量隔离，避免 commit API Key
  pi.registerProvider("deepseek", {
    name: "DeepSeek (via API)",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    apiKey: "$DEEPSEEK_API_KEY",
    models: [
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 16384,
        cost: { input: 0.5, output: 2.0, cacheRead: 0.1, cacheWrite: 0.5 },
      },
    ],
  });

  pi.registerProvider("glm-plan", {
    name: "GLM Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    apiKey: "$ZAI_API_KEY",
    models: [
      {
        id: "glm-x",
        name: "GLM-X",
        reasoning: true,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
```

启动命令加上 `-e` 参数加载 extension：

```bash
hapilon -e ./dist/extension.js
```

### 内置 provider 代理

如果只是想给内置 provider 换个代理地址（不改模型列表），最简单：

```typescript
pi.registerProvider("anthropic", {
  baseUrl: "https://my-proxy.example.com",  // 只改地址
});
```

## 方案 C：.pi/settings.json 设默认值

这是补充方案，只设默认 provider/model，不注册新 provider：

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-pro",
  "defaultThinkingLevel": "medium"
}
```

放在项目根目录 `.pi/settings.json`（不需要 `PI_CODING_AGENT_DIR`）。

## 与本项目 Hapilon 的关系

PRD 第 9 章规划和 pi 的实际能力对应关系：

| PRD 规划 | Pi 实际机制 |
|----------|------------|
| Provider Registry | `models.json` + `pi.registerProvider()` |
| Provider 认证 | `auth.json` + 环境变量 + OAuth |
| Hapilon Home (`~/.hapilon/`) | `PI_CODING_AGENT_DIR` 指向 `.hapilon/agent/` |
| 多 Provider 配置 | 多个 provider 块共存 |
| 运行时不改全局配置 | 方案 A 完全隔离 |

## 入门路线图

1. **先决定：你用哪个方案？**
   - 一两个 provider + 简单配置 → 方案 A
   - 多 provider + 需要定制逻辑 → 方案 B
   - 只改默认模型 → 方案 C

2. **准备好 API Key**
   - 注册对应服务的 API Key
   - 存为环境变量（`.env` 文件，不要 commit）

3. **创建配置文件**
   - 方案 A：创建 `.hapilon/agent/models.json`
   - 方案 B：在 `src/extension.ts` 中注册

4. **在 Hapilon 启动器注入 `PI_CODING_AGENT_DIR`**（方案 A）

5. **启动验证**：`hapilon` → TUI 中输入 `/model` 看 provider 是否出现

## 常见陷阱

- **API Key 不要写死在 JSON 里 commit 到 Git**
  - 用 `$ENV_VAR` 引用环境变量
  - 或用 `!command` 从 Keychain/1Password 获取

- **`models` 字段会替换已有模型**
  - 给内置 provider（如 `anthropic`）加 `models` 会覆盖其内置模型列表
  - 只想代理不改模型 → 只设 `baseUrl`，不设 `models`

- **`auth.json` 权限**
  - pi 会自动设 `0600`（仅 owner 读写）
  - 不要手动改权限

- **`api` 字段选错**
  - OpenAI 兼容 → `openai-completions`
  - Anthropic 兼容 → `anthropic-messages`
  - Google → `google-generative-ai`
  - 确认你的 provider 用的是哪种 API

- **Ollama/LM Studio 等本地模型也需要 `apiKey`**
  - 填一个 dummy 值（如 `"ollama"`），否则 `/model` 中不显示

## 参考资源

- [Pi Provider 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Pi Custom Provider 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
- [Pi Models 配置文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Pi Settings 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)
- [Pi 环境变量源码](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/env-api-keys.ts)
- [Hapilon PRD 第 9.2 节 Profile 与目录](./Hapilon-PRD-v1.1.md)（第 839~878 行）
- [Hapilon PRD 第 9.3 节 Provider Registry](./Hapilon-PRD-v1.1.md)（第 879~909 行）
