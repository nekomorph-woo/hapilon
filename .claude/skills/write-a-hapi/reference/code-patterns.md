# 核心代码模式

> 来源: `doc/pi-wiki.md` 第 6 章。每个模式可直接复制修改使用。

---

## 模式 1: 注册自定义 Tool

> 参考: pi-wiki.md §6.2, §9.2

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",                    // 唯一标识，LLM 用此名调用
    label: "My Tool",                   // TUI 显示名
    description: "What this tool does", // LLM 看到的描述

    // 可选：出现在 "Available tools" 中的一行摘要
    promptSnippet: "Do something useful",

    // 可选：追加到 system prompt Guidelines 的提示
    // ⚠️ 必须明确命名工具：写 "Use my_tool when..." 而非 "Use this tool when..."
    promptGuidelines: [
      "Use my_tool when the user asks to do X instead of direct file edits."
    ],

    // 参数 schema —— 枚举必须用 StringEnum（Google 兼容）
    parameters: Type.Object({
      action: StringEnum(["list", "add", "remove"] as const),
      text: Type.Optional(Type.String({ description: "操作文本" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // 检查取消
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "已取消" }] };
      }

      // 流式进度更新
      onUpdate?.({
        content: [{ type: "text", text: "处理中..." }],
      });

      // 核心逻辑
      const result = `执行了 ${params.action}`;

      // content → 发给 LLM；details → 渲染 + 状态持久化
      return {
        content: [{ type: "text", text: result }],
        details: { action: params.action },
        // terminate: true,  // 可选：跳过后续 LLM 调用
      };
    },

    // 可选：自定义 TUI 渲染
    // renderCall(args, theme, context) { ... },
    // renderResult(result, options, theme, context) { ... },
  });
}
```

**要点**：
- 错误 = throw Error（不要 return 带错误信息）
- 文件修改工具用 `withFileMutationQueue()` 参与并行执行文件锁
- `prepareArguments(args)` 可用于兼容旧 session 的 schema 变更

---

## 模式 2: 订阅 before_agent_start 注入上下文

> 参考: pi-wiki.md §4.3 Agent 事件

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    // 读取项目文档注入为 LLM 上下文
    const readmePath = join(ctx.cwd, "README.md");
    if (existsSync(readmePath)) {
      const content = readFileSync(readmePath, "utf8").slice(0, 2000);
      return {
        message: {
          customType: "project-context",
          content: `项目 README 摘要:\n${content}`,
          display: true,    // TUI 中可见
        },
      };
    }

    // 也可以修改 system prompt（链式）
    // return {
    //   systemPrompt: event.systemPrompt + "\n\n额外的规则...",
    // };
  });
}
```

**要点**：
- `message` 会被持久化到 session，参与 LLM 上下文
- `systemPrompt` 的修改是链式的（后续 handler 可见）
- 用 `ctx.isProjectTrusted()` 判断是否可读项目文件

---

## 模式 3: 订阅 tool_call 拦截工具

> 参考: pi-wiki.md §4.3 Tool 事件

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // 拦截危险 bash 命令
    if (isToolCallEventType("bash", event)) {
      // 可原地修改参数
      event.input.command = `source ~/.profile\n${event.input.command}`;

      // 阻止危险操作
      const dangerous = ["rm -rf /", "sudo rm", "> /dev/sda"];
      if (dangerous.some((d) => event.input.command.includes(d))) {
        return { block: true, reason: "危险命令已阻止" };
      }
    }

    // 拦截文件读取，记录日志
    if (isToolCallEventType("read", event)) {
      console.log(`[audit] 读取文件: ${event.input.path}`);
    }

    // 拦截文件写入（自定义工具也可类型安全拦截）
    // if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    //   event.input.someField = "modified";
    // }
  });
}
```

---

## 模式 4: 注册 /slash 命令

> 参考: pi-wiki.md §6.6

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("mycmd", {
    description: "执行某个操作",

    // 可选：参数自动补全
    getArgumentCompletions: (prefix: string) => {
      const options = ["dev", "staging", "prod"];
      const filtered = options.filter((o) => o.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((v) => ({ value: v, label: v }))
        : null;
    },

    handler: async (args, ctx) => {
      // ctx 是 ExtensionCommandContext，比普通 ctx 多了 session 控制方法
      ctx.ui.notify(`执行命令，参数: ${args || "无"}`, "info");

      // 可以等待 Agent 空闲
      await ctx.waitForIdle();

      // 可以创建新 session
      // await ctx.newSession({ ... });

      // 可以触发 reload
      // await ctx.reload();
    },
  });
}
```

**要点**：
- 同名命令冲突时自动加数字后缀（`/review:1`, `/review:2`）
- ExtensionCommandContext 的方法（newSession/fork/reload）只能在 command handler 中用

---

## 模式 5: 注册 Provider

> 参考: pi-wiki.md §7.4

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  // async factory：启动时 fetch 远程模型列表
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = await response.json();

  pi.registerProvider("local-llm", {
    name: "Local LLM",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_LLM_API_KEY",  // 环境变量引用
    api: "openai-completions",
    models: payload.data.map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window ?? 128000,
      maxTokens: m.max_tokens ?? 4096,
    })),
  });

  // 也可以仅覆盖已有 provider 的 baseUrl：
  // pi.registerProvider("anthropic", {
  //   baseUrl: "https://proxy.example.com"
  // });
}
```

**要点**：
- async factory 确保模型在启动时立即可用
- `apiKey` 支持 `$ENV_VAR`、`${ENV_VAR}`、`` `!command` `` 三种格式
- `pi.unregisterProvider(name)` 移除并恢复内置模型

---

## 模式 6: 注册 Flag + 快捷键

> 参考: pi-wiki.md §6.4

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 注册 CLI flag
  pi.registerFlag("my-feature", {
    description: "启用某个功能",
    type: "boolean",
    default: false,
  });

  // 注册快捷键
  pi.registerShortcut("ctrl+shift+m", {
    description: "触发自定义操作",
    handler: async (ctx) => {
      ctx.ui.notify("快捷键已触发！", "info");
    },
  });

  // 在事件中使用 flag
  pi.on("session_start", (_event, _ctx) => {
    if (pi.getFlag("my-feature")) {
      console.log("功能已启用");
    }
  });
}
```
