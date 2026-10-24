# Effect TypeScript 模式参考

以下摘录刻意钉在 hapilon 源码路径上，便于对照活实现阅读。

## 类型化错误与 Fail

来源：`src/config/hapilon-home.ts`。

```ts
export class HapilonHomeError extends Data.TaggedError("HapilonHomeError")<{
  message: string;
}> {}

export const hapilonHomeEffect: Effect.Effect<string, HapilonHomeError> = Effect.gen(function* () {
  const env = yield* Effect.sync(() => process.env.HAPILON_HOME);
  if (env && env.length > 0 && !isAbsolute(expandTilde(env))) {
    return yield* Effect.fail(new HapilonHomeError({
      message: `HAPILON_HOME 必须是绝对路径（收到 "${env}"）。`,
    }));
  }
  return env && env.length > 0 ? expandTilde(env) : join(homedir(), ".hapilon");
});
```

## 永不失败的降级

来源：`src/config/config-io.ts` 与 `src/extensions/hpl-effect-policy/inspector.ts`。

```ts
export const readHapilonConfigEffect: Effect.Effect<HapilonConfig, never> = Effect.sync(() => {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HapilonConfig;
  } catch (err) {
    console.warn(`Warning: config.json 读取或解析失败 (${String(err)})，将以空配置处理`);
    return {};
  }
});

export const inspectProjectEffect = (
  cwd: string,
): Effect.Effect<ProjectSignals, never> => Effect.sync(() => inspectProjectSync(cwd));
```

## 薄包装

来源：`src/config/hapilon-home.ts` 与 `src/mcp/config-store.ts`。

```ts
export function hapilonHome(): string {
  const result = Effect.runSync(Effect.either(hapilonHomeEffect));
  if (result._tag === "Left") throw new Error(result.left.message);
  return result.right;
}
```

MCP 配置的包装刻意重抛 `McpConfigError` 实例——调用方按领域类型判定；不要盲目把每个类型化错误都翻译成普通 `Error`。

## 组合与 catchTag

来源：`src/cli/startup.ts`。

```ts
export const prepareStartupEffect = (args: string[]) => Effect.gen(function* () {
  const home = yield* hapilonHomeEffect.pipe(Effect.mapError(toStartupError));
  const config = yield* readHapilonConfigEffect;
  yield* writeHapilonConfigEffect(config).pipe(
    Effect.catchTag("ConfigWriteError", () => Effect.sync(() => {
      console.warn("无法写入安全提示状态到配置文件（权限不足？）");
    })),
  );
  return { home, config };
});
```

## 有界的 `Effect.async`

来源：`src/extensions/hpl-add-dir/tools.ts`（`searchExternalFilesEffect`）。实现注册了 abort 处理器，中止时杀掉子进程，并用 `Effect.timeout("10 seconds")` 封界——卡死的 `find` 拖不挂工具。

## 纯逻辑

来源：`src/extensions/hpl-effect-policy/policy.ts`。

```ts
export function decideEffectMode(signals: ProjectSignals): EffectMode {
  if (signals.language !== "typescript") return "disabled";
  if (signals.effectInstalled || signals.effectImportsFound) return "required";
  if (signals.hasAgentsMd) return "respect-project";
  if (signals.isGreenfield) return "prefer";
  return "respect-project";
}
```
