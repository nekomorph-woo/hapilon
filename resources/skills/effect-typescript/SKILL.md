---
name: effect-typescript
description: Guide for writing Effect TypeScript (typed errors, services, layers, Schema). Use when the project uses Effect or when Effect is the chosen architecture for a new TypeScript project.
---

# Effect TypeScript patterns in hapilon

Use these patterns when implementing Effect code. Read `patterns.md` and the cited source before making a substantial change; the examples below are from hapilon itself.

## 1. Typed errors

Represent expected failures with `Data.TaggedError` and `Effect.fail`; do not use bare `throw` inside Effect contexts. See [`src/config/hapilon-home.ts`](../../../src/config/hapilon-home.ts), `HapilonHomeError` and `hapilonHomeEffect`.

## 2. Never-failing degradation

When the public behavior is warning-and-fallback, catch the side effect and expose `Effect<Success, never>`. See [`src/config/config-io.ts`](../../../src/config/config-io.ts), `readHapilonConfigEffect`, and [`src/extensions/hpl-effect-policy/inspector.ts`](../../../src/extensions/hpl-effect-policy/inspector.ts), `inspectProjectEffect`.

## 3. Thin synchronous wrappers

Keep legacy sync signatures as thin `Effect.runSync(Effect.either(...))` wrappers and inspect `_tag`. Translate typed failures to ordinary `Error` only where the legacy API requires it; preserve domain instances where callers use `instanceof`. See [`src/config/hapilon-home.ts`](../../../src/config/hapilon-home.ts), `hapilonHome`, and [`src/mcp/config-store.ts`](../../../src/mcp/config-store.ts).

## 4. Composition

Use `Effect.gen` for sequential workflows, then `try`, `map`, `mapError`, and `catchTag` at the boundary that owns the policy. See [`src/cli/startup.ts`](../../../src/cli/startup.ts), `prepareStartupEffect`.

## 5. Bounded asynchronous work

Wrap callback APIs with `Effect.async`, honor `AbortSignal`, and bound external work with a timeout; kill the child on timeout and return the established fallback. See [`src/extensions/hpl-add-dir/tools.ts`](../../../src/extensions/hpl-add-dir/tools.ts), `searchExternalFilesEffect`.

## 6. Keep pure logic pure

Do not Effect-wrap deterministic decisions. Keep pure functions free of Effect and Node imports, and use Effect only around side effects. See [`src/extensions/hpl-effect-policy/policy.ts`](../../../src/extensions/hpl-effect-policy/policy.ts), `decideEffectMode`.
