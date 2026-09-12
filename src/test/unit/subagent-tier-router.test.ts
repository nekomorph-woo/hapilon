import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  routeTierEffect,
  readResolvedTiersEffect,
  type TierModel,
  type TierRouteRequest,
  type TierRouterContext,
} from "../../subagent/tier-router.js";

describe("subagent tier-router", { concurrency: false }, () => {
  let home: string;
  let project: string;
  const originalHome = process.env.HAPILON_HOME;

  const opus: TierModel = { provider: "anthropic", id: "claude-opus-4", reasoning: true };
  const sonnet: TierModel = { provider: "anthropic", id: "claude-sonnet-4" };
  const haiku: TierModel = { provider: "anthropic", id: "claude-haiku-3" };
  const available = [opus, sonnet, haiku];

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-tier-router-home-"));
    project = mkdtempSync(join(tmpdir(), "hapilon-tier-router-project-"));
    mkdirSync(join(project, ".hapilon"), { recursive: true });
    process.env.HAPILON_HOME = home;
    writeFileSync(join(home, "task-tier-map.json"), "{}\n");
    writeFileSync(join(project, ".hapilon", "task-tier-map.json"), "{}\n");
    writeResolved();
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function writeResolved(overrides: Partial<Record<"opus" | "sonnet" | "haiku", TierModel[]>> = {}): void {
    writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
      opus: overrides.opus ?? [opus],
      sonnet: overrides.sonnet ?? [sonnet],
      haiku: overrides.haiku ?? [haiku],
    }));
  }

  function request(overrides: Partial<TierRouteRequest> = {}): TierRouteRequest {
    return {
      taskPrompt: "请处理这个任务",
      available,
      ...overrides,
    };
  }

  function context(
    complete: TierRouterContext["modelRegistry"]["complete"] = async () => ({ content: [{ type: "text", text: "sonnet" }] }),
  ): TierRouterContext {
    return {
      cwd: project,
      modelRegistry: { complete },
    };
  }

  function assistantText(text: string): { content: Array<{ type: "text"; text: string }> } {
    return { content: [{ type: "text", text }] };
  }

  it("explicit 档位最高优先，跳过映射和分类器", async () => {
    writeFileSync(join(home, "task-tier-map.json"), JSON.stringify({ review: "opus" }));
    let calls = 0;
    const result = await Effect.runPromise(routeTierEffect(
      request({ explicitTier: "haiku", taskType: "review" }),
      context(async () => {
        calls++;
        return assistantText("opus");
      }),
    ));

    assert.deepEqual(result, { tier: "haiku", model: haiku, source: "explicit" });
    assert.equal(calls, 0);
  });

  it("task-type-map 支持全局+项目覆盖，非法值跳过", async () => {
    writeFileSync(join(home, "task-tier-map.json"), JSON.stringify({ review: "opus", summary: "haiku" }));
    writeFileSync(join(project, ".hapilon", "task-tier-map.json"), JSON.stringify({
      review: "sonnet",
      summary: "not-a-tier",
      impl: "haiku",
    }));

    const overridden = await Effect.runPromise(routeTierEffect(request({ taskType: "review" }), context()));
    assert.deepEqual(overridden, { tier: "sonnet", model: sonnet, source: "task-type-map" });

    const global = await Effect.runPromise(routeTierEffect(request({ taskType: "summary" }), context()));
    assert.deepEqual(global, { tier: "haiku", model: haiku, source: "task-type-map" });

    const projectValid = await Effect.runPromise(routeTierEffect(request({ taskType: "impl" }), context()));
    assert.deepEqual(projectValid, { tier: "haiku", model: haiku, source: "task-type-map" });
  });

  it("映射未命中时用 haiku 分类器，并接受大小写档名", async () => {
    for (const answer of ["haiku", "SONNET", "opus"]) {
      const result = await Effect.runPromise(routeTierEffect(
        request({ taskType: "unmapped" }),
        context(async (_model, _context, options) => {
          assert.equal(options.maxTokens, 8);
          assert.equal(options.reasoning, "off");
          assert.ok(options.signal instanceof AbortSignal);
          return assistantText(answer);
        }),
      ));
      const expected = answer.toLowerCase() as "haiku" | "sonnet" | "opus";
      assert.equal(result?.tier, expected);
      assert.equal(result?.source, "classifier");
    }
  });

  it("分类器抛错或超时后 fallback 到 sonnet", async () => {
    const failed = await Effect.runPromise(routeTierEffect(
      request(),
      context(async () => {
        throw new Error("network down");
      }),
    ));
    assert.deepEqual(failed, { tier: "sonnet", model: sonnet, source: "fallback" });

    const originalTimeout = AbortSignal.timeout;
    let timeoutMs = 0;
    AbortSignal.timeout = ((milliseconds: number) => {
      timeoutMs = milliseconds;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1);
      return controller.signal;
    }) as typeof AbortSignal.timeout;
    try {
      const timedOut = await Effect.runPromise(routeTierEffect(
        request(),
        context(async (_model, _context, options) => await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })),
      ));
      assert.equal(timeoutMs, 5_000);
      assert.deepEqual(timedOut, { tier: "sonnet", model: sonnet, source: "fallback" });
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  it("sonnet、opus、haiku 依次 fallback，全空返回 undefined", async () => {
    writeResolved({ sonnet: [], opus: [opus], haiku: [haiku] });
    const opusFallback = await Effect.runPromise(routeTierEffect(request(), context()));
    assert.deepEqual(opusFallback, { tier: "opus", model: opus, source: "fallback" });

    writeResolved({ sonnet: [], opus: [], haiku: [haiku] });
    const haikuFallback = await Effect.runPromise(routeTierEffect(request(), context()));
    assert.deepEqual(haikuFallback, { tier: "haiku", model: haiku, source: "fallback" });

    writeResolved({ sonnet: [], opus: [], haiku: [] });
    const empty = await Effect.runPromise(routeTierEffect(request(), context()));
    assert.equal(empty, undefined);
  });

  it("resolved 文件损坏时按空档降级且不炸", async () => {
    writeFileSync(join(home, "model-tiers-resolved.json"), "{broken json");
    const resolved = await Effect.runPromise(readResolvedTiersEffect);
    assert.deepEqual(resolved, { opus: [], sonnet: [], haiku: [] });

    const result = await Effect.runPromise(routeTierEffect(request(), context()));
    assert.equal(result, undefined);
  });

  it("resolved 文件缺失同样按空档处理", async () => {
    assert.ok(existsSync(join(home, "model-tiers-resolved.json")));
    unlinkSync(join(home, "model-tiers-resolved.json"));
    const result = await Effect.runPromise(routeTierEffect(request(), context()));
    assert.equal(result, undefined);
    writeResolved();
  });
});
