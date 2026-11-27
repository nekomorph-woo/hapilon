import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  applyCompressPresetEffect,
  COMPRESS_PRESETS,
  presetSummary,
  tierFor,
  withCompressPreset,
  type CompressModel,
} from "../../extensions/hpl-fast-hapilon-setup/compress.js";

const [balanced, loose, tight] = COMPRESS_PRESETS;
const models: CompressModel[] = [
  { provider: "zai", id: "glm-5.3-flash", contextWindow: 1_000_000 },
  { provider: "openai-codex", id: "gpt-6.1-terra", contextWindow: 500_000 },
  { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 272_000 },
  { provider: "probe", id: "mystery", contextWindow: 0 },
];

test("tierFor：按窗口从高往低匹配，匹配不到或窗口未知返回 undefined", () => {
  assert.deepEqual(tierFor(balanced, 1_000_000), { above: 1_000_000, growth: 150_000, hard: 0.6 });
  assert.deepEqual(tierFor(balanced, 2_000_000), balanced.tiers[0]);
  assert.deepEqual(tierFor(balanced, 500_000), { above: 500_000, growth: 100_000, hard: 0.7 });
  assert.equal(tierFor(balanced, 272_000), undefined);
  assert.equal(tierFor(balanced, 0), undefined);
  assert.equal(tierFor(tight, 1_000_000), undefined);
});

test("withCompressPreset：每个模型按窗口写入条目，保留其余键并加上 preserveRecentTools", () => {
  const next = withCompressPreset({ delegate: { enabled: false }, compress: { nudgeGrowthTokens: 50_000 } }, balanced, models);
  assert.deepEqual(next, {
    delegate: { enabled: false },
    preserveRecentTools: ["read"],
    compress: {
      nudgeGrowthTokens: 50_000,
      providers: {
        zai: { models: { "glm-5.3-flash": { nudgeGrowthTokens: 150_000, maxContextLimit: 0.6 } } },
        "openai-codex": {
          models: {
            "gpt-6.1-terra": { nudgeGrowthTokens: 100_000, maxContextLimit: 0.7 },
          },
        },
        probe: { models: {} },
      },
    },
  });
});

test("withCompressPreset：匹配不到档的模型删掉旧条目，手写的其他供应商条目不动", () => {
  const current = {
    compress: {
      providers: {
        "openai-codex": { nudgeGrowthTokens: 120_000, models: { "gpt-5.6-luna": { nudgeGrowthTokens: 90_000 } } },
        anthropic: { models: { "claude-sonnet-4-5": { nudgeGrowthTokens: 1 } } },
      },
    },
  };
  const next = withCompressPreset(current, tight, models) as { compress: { providers: Record<string, { models?: Record<string, unknown> }> } };
  assert.deepEqual(next.compress.providers.anthropic, { models: { "claude-sonnet-4-5": { nudgeGrowthTokens: 1 } } });
  assert.deepEqual(next.compress.providers["openai-codex"], { nudgeGrowthTokens: 120_000, models: {} });
});

test("withCompressPreset：没有 compress 键也能写；272k 窗口不在宽松档的最低档内", () => {
  const next = withCompressPreset({}, loose, [models[2], { provider: "anthropic", id: "claude", contextWindow: 400_000 }]) as {
    compress: { providers: Record<string, { models: Record<string, unknown> }> };
  };
  assert.deepEqual(next.compress.providers.anthropic.models, { claude: { nudgeGrowthTokens: 75_000, maxContextLimit: 0.8 } });
  assert.deepEqual(next.compress.providers["openai-codex"].models, {});
});

test("presetSummary：按档列出窗口、模型数与取值", () => {
  assert.equal(presetSummary(balanced, models), "≥1000k×1: 150k / 60% · ≥500k×1: 100k / 70%");
  assert.equal(presetSummary(tight, models), "全部模型按插件默认");
});

test("applyCompressPresetEffect：写回文件；文件损坏时报错且不覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hapi-compress-preset-"));
  try {
    const path = join(dir, "acp.json");
    writeFileSync(path, JSON.stringify({ delegate: { enabled: false } }));
    await Effect.runPromise(applyCompressPresetEffect(path, balanced, models));
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      delegate?: unknown;
      compress: { providers: Record<string, { models: Record<string, unknown> }> };
    };
    assert.deepEqual(written.compress.providers.zai.models, { "glm-5.3-flash": { nudgeGrowthTokens: 150_000, maxContextLimit: 0.6 } });
    assert.deepEqual(written.delegate, { enabled: false });

    writeFileSync(path, "{ broken");
    const result = await Effect.runPromise(applyCompressPresetEffect(path, balanced, models).pipe(Effect.either));
    assert.equal(result._tag, "Left");
    assert.equal(readFileSync(path, "utf8"), "{ broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
