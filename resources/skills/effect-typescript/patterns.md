# Effect TypeScript pattern references

These excerpts are intentionally tied to hapilon source paths so they can be read alongside the live implementation.

## Typed errors and Fail

Source: `src/config/hapilon-home.ts`.

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

## Never-failing degradation

Source: `src/config/config-io.ts` and `src/extensions/hpl-effect-policy/inspector.ts`.

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

## Thin wrappers

Source: `src/config/hapilon-home.ts` and `src/mcp/config-store.ts`.

```ts
export function hapilonHome(): string {
  const result = Effect.runSync(Effect.either(hapilonHomeEffect));
  if (result._tag === "Left") throw new Error(result.left.message);
  return result.right;
}
```

MCP config wrappers deliberately rethrow the `McpConfigError` instance because callers test its domain type; do not blindly translate every typed error to a plain `Error`.

## Composition and catchTag

Source: `src/cli/startup.ts`.

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

## Bounded `Effect.async`

Source: `src/extensions/hpl-add-dir/tools.ts` (`searchExternalFilesEffect`). The implementation registers an abort handler, kills the child process on abort, and applies `Effect.timeout("10 seconds")` so a stuck `find` cannot hang the tool.

## Pure logic

Source: `src/extensions/hpl-effect-policy/policy.ts`.

```ts
export function decideEffectMode(signals: ProjectSignals): EffectMode {
  if (signals.language !== "typescript") return "disabled";
  if (signals.effectInstalled || signals.effectImportsFound) return "required";
  if (signals.hasAgentsMd) return "respect-project";
  if (signals.isGreenfield) return "prefer";
  return "respect-project";
}
```
