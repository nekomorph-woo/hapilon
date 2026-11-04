---
name: effect-typescript
description: Effect TypeScript 写法指南（typed errors、services、layers、Schema）。项目使用 Effect、或新 TypeScript 项目选定 Effect 架构时使用。
---

# Effect TypeScript 实战模式

写 Effect 代码时遵循这些模式。做实质性改动前先读 `patterns.md` 与其引用的源码；下面的例子全部取自 hapilon 本体。

## 1. 类型化错误

用 `Data.TaggedError` + `Effect.fail` 表达可预期的失败；Effect 上下文里不裸 throw。见 [`src/config/hapilon-home.ts`](../../../src/config/hapilon-home.ts) 的 `HapilonHomeError` 与 `hapilonHomeEffect`。

## 2. 永不失败的降级

对外行为是「警告并回落」时，接住副作用、暴露 `Effect<Success, never>`。见 [`src/config/config-io.ts`](../../../src/config/config-io.ts) 的 `readHapilonConfigEffect`，与 [`src/extensions/hpl-effect-policy/inspector.ts`](../../../src/extensions/hpl-effect-policy/inspector.ts) 的 `inspectProjectEffect`。

## 3. 薄同步包装

遗留同步签名保留为 `Effect.runSync(Effect.either(...))` 的薄包装并检查 `_tag`。仅在遗留 API 强制时把类型化失败翻译成普通 `Error`；调用方用 `instanceof` 的地方保留领域实例。见 [`src/config/hapilon-home.ts`](../../../src/config/hapilon-home.ts) 的 `hapilonHome` 与 [`src/config/project-config.ts`](../../../src/config/project-config.ts)。

## 4. 组合

顺序流程用 `Effect.gen`；`try`、`map`、`mapError`、`catchTag` 放在拥有策略的边界上。见 [`src/cli/startup.ts`](../../../src/cli/startup.ts) 的 `prepareStartupEffect`。

## 5. 有界异步

回调 API 用 `Effect.async` 包装，尊重 `AbortSignal`，外部工作用超时封界；超时杀掉子进程并返回既定回落值。见 [`src/extensions/hpl-add-dir/tools.ts`](../../../src/extensions/hpl-add-dir/tools.ts) 的 `searchExternalFilesEffect`。

## 6. 纯逻辑保持纯净

确定性决策不做 Effect 包装。纯函数不引 Effect 与 Node 依赖，Effect 只裹副作用。见 [`src/extensions/hpl-effect-policy/policy.ts`](../../../src/extensions/hpl-effect-policy/policy.ts) 的 `decideEffectMode`。
