/**
 * tier 自适应选模的落盘边界：事实日志、画像重建、settings 开关、多 provider 配额快照。
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adaptiveEventsPath,
  adaptiveProfilePath,
  appendAdaptiveEvent,
  deriveProfile,
  readAdaptiveEvents,
  readAdaptiveProfile,
  rebuildAdaptiveProfile,
  type AdaptiveEvent,
} from "../../extensions/hpl-model-tiers/adaptive-events.js";
import {
  readTierAdaptiveConfig,
  setTierAdaptiveEnabled,
  setTierAdaptiveSessionOverride,
  tierAdaptiveEnabled,
  fillLearnedThinking,
  planTierSelection,
  resolveExplicitModel,
} from "../../extensions/hpl-model-tiers/adaptive.js";
import { readQuotaSnapshotFor, readQuotaSnapshots, writeQuotaSnapshot } from "../../extensions/hpl-quota-usage/cache.js";
import type { QuotaSnapshot } from "../../extensions/hpl-quota-usage/snapshot.js";

const originalEnv = { home: process.env.HAPILON_HOME, cache: process.env["HAPILON_QUOTA_CACHE"] };
let home: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), "hapilon-tier-adaptive-"));
  process.env.HAPILON_HOME = home;
  process.env["HAPILON_QUOTA_CACHE"] = join(home, "quota-cache.json");
});

after(() => {
  if (originalEnv.home === undefined) delete process.env.HAPILON_HOME;
  else process.env.HAPILON_HOME = originalEnv.home;
  if (originalEnv.cache === undefined) delete process.env["HAPILON_QUOTA_CACHE"];
  else process.env["HAPILON_QUOTA_CACHE"] = originalEnv.cache;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(home, "tier-adaptive"), { recursive: true, force: true });
  rmSync(join(home, "agent"), { recursive: true, force: true });
  rmSync(join(home, "model-tiers-resolved.json"), { force: true });
  rmSync(process.env["HAPILON_QUOTA_CACHE"]!, { force: true });
  setTierAdaptiveSessionOverride(undefined);
});


/** 事件时间戳统一取当前时刻：可信样本有 30 天时效窗口，硬编码日期会过期 */
const recentTs = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

const event = (overrides: Partial<AdaptiveEvent> & { kind: AdaptiveEvent["kind"]; ts: string }): AdaptiveEvent =>
  overrides as AdaptiveEvent;

/** 三个 sonnet 候选：配置顺序 zai > deepseek > openai-codex */
function writeResolvedTiers(): void {
  writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
    opus: [],
    sonnet: [
      { provider: "zai", id: "glm-5.3", thinking: "high", group: 0 },
      { provider: "deepseek", id: "deepseek-flash", group: 1 },
      { provider: "openai-codex", id: "gpt-5", group: 2 },
    ],
    haiku: [],
  }), "utf8");
}

const snapshot = (provider: string, percent: number, now: number): QuotaSnapshot => ({
  provider,
  windows: [{ window: "5h", percent, resetAt: now + 3600_000 }],
  timestamp: now,
});

describe("tier-adaptive 事实日志与画像", () => {
  it("自动分配只进日志，不进任何路由证据（自我强化隔离）", () => {
    for (let i = 0; i < 10; i++) {
      appendAdaptiveEvent(event({
        kind: "pane_assignment",
        ts: recentTs(),
        role: "worker",
        paneId: `w1:p${i}`,
        model: "zai/glm-5.3",
        source: "auto",
        reason: "配置顺序",
      }));
    }
    const profile = readAdaptiveProfile();
    assert.equal(profile.models["zai/glm-5.3"], undefined);
    assert.equal(profile.trustedSamples, 0);
    assert.equal(readAdaptiveEvents().length, 10);
  });

  it("点名/完成/verdict/修复轮各自计入，task 与 verdict 按身份去重", () => {
    const ts = recentTs();
    for (let i = 0; i < 5; i++) {
      appendAdaptiveEvent(event({ kind: "explicit_selection", ts, role: "worker", model: "zai/glm-5.3", source: "arg" }));
    }
    assert.equal(appendAdaptiveEvent(event({
      kind: "task_completed", ts, role: "worker", paneId: "w1:p8", taskId: "3", model: "zai/glm-5.3",
    }), "task:w1:p8:3"), true);
    // 同一 (pane, task) 再来一次：静默跳过，不重复计数
    assert.equal(appendAdaptiveEvent(event({
      kind: "task_completed", ts, role: "worker", paneId: "w1:p8", taskId: "3", model: "zai/glm-5.3",
    }), "task:w1:p8:3"), false);
    for (let i = 0; i < 2; i++) {
      appendAdaptiveEvent(event({
        kind: "review_verdict", ts, model: "zai/glm-5.3", verdict: i === 0 ? "approve" : "fix-then-approve",
      }), `verdict:${i}`);
    }
    const profile = readAdaptiveProfile();
    const evidence = profile.models["zai/glm-5.3"]!;
    assert.deepEqual(
      { ...evidence },
      {
        trustedSamples: 8,
        explicitPicks: 5,
        switchPicks: 0,
        completedTasks: 1,
        approvals: 1,
        fixRounds: 1,
        rejects: 0,
        roles: { worker: 5 },
        switchRoles: {},
        thinkingLevels: {},
      },
    );
    assert.equal(profile.trustedSamples, 8);
    assert.equal(profile.roleLeaders["worker"], "zai/glm-5.3");
  });

  it("画像快照可删可重建，重建结果与事件派生一致", () => {
    const ts = recentTs();
    appendAdaptiveEvent(event({ kind: "explicit_selection", ts, role: "worker", model: "deepseek/deepseek-flash", source: "arg" }));
    const rebuilt = rebuildAdaptiveProfile(recentTs());
    assert.ok(existsSync(adaptiveProfilePath()));
    assert.deepEqual(JSON.parse(readFileSync(adaptiveProfilePath(), "utf8")).models, rebuilt.models);

    rmSync(adaptiveEventsPath(), { force: true });
    // 日志没了：退回快照继续展示，而不是凭空清空历史
    assert.equal(readAdaptiveProfile().trustedSamples, 1);
    assert.deepEqual(rebuildAdaptiveProfile(recentTs()).models, {});
  });

  it("损坏事件行跳过，其余照常派生", () => {
    const ts = recentTs();
    appendAdaptiveEvent(event({ kind: "explicit_selection", ts, role: "worker", model: "zai/glm-5.3", source: "arg" }));
    const raw = readFileSync(adaptiveEventsPath(), "utf8");
    writeFileSync(adaptiveEventsPath(), `{broken json\n${raw}`, "utf8");
    const profile = readAdaptiveProfile();
    assert.equal(profile.models["zai/glm-5.3"]?.explicitPicks, 1);
  });

  it("超出时效窗口的旧样本不进画像，日志仍保留", () => {
    const now = new Date().toISOString();
    const events = [
      event({ kind: "explicit_selection", ts: recentTs(-60), role: "worker", model: "zai/glm-5.3", source: "arg" }),
      event({ kind: "explicit_selection", ts: recentTs(-1), role: "worker", model: "zai/glm-5.3", source: "arg" }),
    ];
    const profile = deriveProfile(events, now);
    assert.equal(profile.models["zai/glm-5.3"]?.explicitPicks, 1);
    assert.equal(profile.trustedSamples, 1);
  });

  it("自动分配次数只统计展示，不进可信样本（自我强化隔离）", () => {
    const ts = recentTs();
    const profile = deriveProfile([
      event({ kind: "pane_assignment", ts, role: "worker", paneId: "w1:p8", model: "zai/glm-5.3", source: "auto", reason: "配置顺序" }),
      event({ kind: "pane_assignment", ts, role: "worker", paneId: "w1:p9", model: "zai/glm-5.3", source: "auto", reason: "配置顺序" }),
    ], new Date().toISOString());
    assert.equal(profile.assignments["zai/glm-5.3"], 2);
    assert.equal(profile.trustedSamples, 0);
    assert.equal(profile.models["zai/glm-5.3"], undefined);
  });

  it("主动切模计入目标模型的可信偏好，旧模型不记负分", () => {
    const ts = recentTs();
    for (let i = 0; i < 5; i++) {
      appendAdaptiveEvent(event({
        kind: "model_switch", v: 1, ts, paneId: `w1:p${i}`, role: "worker",
        previousModel: "zai/glm-5.3", model: "openai-codex/gpt-5", source: "set",
      }));
    }
    const profile = readAdaptiveProfile();
    const target = profile.models["openai-codex/gpt-5"]!;
    assert.equal(target.switchPicks, 5);
    assert.deepEqual(target.switchRoles, { worker: 5 });
    assert.equal(target.explicitPicks, 0, "切模与点名分开计数，便于审计");
    assert.equal(target.trustedSamples, 5);
    assert.equal(profile.models["zai/glm-5.3"], undefined, "旧模型不因被切走记负分");
    assert.equal(profile.roleLeaders["worker"], "openai-codex/gpt-5");
  });

  it("主动切 thinking：按 (role, model, level) 正向累计，旧 level 不负分、不进模型亲和力", () => {
    const ts = recentTs();
    for (let i = 0; i < 5; i++) {
      appendAdaptiveEvent(event({
        kind: "thinking_switch", v: 1, ts, paneId: `w1:p${i}`, role: "worker",
        model: "openai-codex/gpt-5", previousLevel: "medium", level: "high",
      }));
    }
    const profile = readAdaptiveProfile();
    const target = profile.models["openai-codex/gpt-5"]!;
    assert.equal(target.thinkingLevels["medium"], undefined, "旧 level 不留任何负分痕迹");
    assert.deepEqual(target.thinkingLevels, { high: { worker: 5 } });
    assert.equal(target.trustedSamples, 0, "thinking 偏好不进模型 affinity");
    assert.equal(target.switchPicks, 0);
    assert.equal(profile.thinkingSamples, 5);
    assert.equal(profile.trustedSamples, 0, "可信样本总数也不含 thinking 偏好");
  });

  it("thinking 样本同样走 30 天时效窗口", () => {
    const now = new Date().toISOString();
    const profile = deriveProfile([
      event({
        kind: "thinking_switch", v: 1, ts: recentTs(-60), paneId: "w1:p1", role: "worker",
        model: "zai/glm-5.3", previousLevel: "low", level: "high",
      }),
    ], now);
    assert.equal(profile.thinkingSamples, 0);
    assert.equal(profile.models["zai/glm-5.3"], undefined);
  });

  it("deriveProfile 是纯函数：同一事件集恒定输出", () => {
    const ts = recentTs();
    const events = [
      event({ kind: "explicit_selection", ts, role: "worker", model: "a/1", source: "arg" }),
      event({ kind: "provider_limit", ts, provider: "zai", window: "5h", percent: 95 }),
      event({ kind: "provider_failure", ts, provider: "zai", detail: "500" }),
    ];
    const first = deriveProfile(events, new Date().toISOString());
    const second = deriveProfile(events, new Date().toISOString());
    assert.deepEqual(first, second);
    assert.deepEqual(first.providers["zai"], { limits: 1, failures: 1 });
  });
});

describe("tierAdaptive 开关", () => {
  it("默认关闭；写入只改 tierAdaptive.enabled，其它键保留", () => {
    const settingsPath = join(home, "agent", "settings.json");
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      theme: "dark",
      gateAuto: { enabled: true, model: "tier:haiku" },
      tierAdaptive: { enabled: false, pinned: "keep" },
    }));

    assert.equal(readTierAdaptiveConfig().enabled, false);
    assert.equal(tierAdaptiveEnabled(), false);

    assert.equal(setTierAdaptiveEnabled(true), true);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(written.theme, "dark");
    assert.deepEqual(written.gateAuto, { enabled: true, model: "tier:haiku" });
    assert.deepEqual(written.tierAdaptive, { enabled: true, pinned: "keep" });
  });

  it("settings 坏了不写盘也不误开", () => {
    const settingsPath = join(home, "agent", "settings.json");
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(settingsPath, "{broken");
    assert.equal(readTierAdaptiveConfig().enabled, false);
    assert.equal(setTierAdaptiveEnabled(true), false);
    assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
  });

  it("本会话切换压过 settings，清空后回落 settings", () => {
    const settingsPath = join(home, "agent", "settings.json");
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ tierAdaptive: { enabled: true } }));
    assert.equal(tierAdaptiveEnabled(), true);
    setTierAdaptiveSessionOverride(false);
    assert.equal(tierAdaptiveEnabled(), false);
    setTierAdaptiveSessionOverride(undefined);
    assert.equal(tierAdaptiveEnabled(), true);
  });
});

describe("planTierSelection 装配", () => {
  it("配额 hot 顺延、thinking 透传、adaptive 关闭时画像不参与", () => {
    writeResolvedTiers();
    const now = Date.now();
    // 快照键是 provider 命名空间（zai 系归并为 glm），轮询写入侧就是这个名字
    writeQuotaSnapshot(snapshot("glm", 95, now));
    writeQuotaSnapshot(snapshot("deepseek", 10, now));
    const ts = recentTs();
    for (let i = 0; i < 6; i++) {
      appendAdaptiveEvent(event({ kind: "explicit_selection", ts, role: "worker", model: "openai-codex/gpt-5", source: "arg" }));
    }

    const off = planTierSelection({ tier: "sonnet", now });
    assert.equal(off.adaptiveEnabled, false);
    assert.equal(off.spec, "deepseek/deepseek-flash");
    assert.equal(off.source, "quota");

    setTierAdaptiveSessionOverride(true);
    const on = planTierSelection({ tier: "sonnet", now });
    assert.equal(on.adaptiveEnabled, true);
    assert.equal(on.spec, "openai-codex/gpt-5");
    assert.equal(on.source, "profile");
  });

  it("点名指代按档位表解析并携带档位 thinking；越界点名回退自动选择并告警", () => {
    writeResolvedTiers();
    const byTier = planTierSelection({ tier: "sonnet", explicitSpec: "tier:sonnet[0]", now: Date.now() });
    assert.equal(byTier.spec, "zai/glm-5.3:high");
    assert.equal(byTier.source, "explicit");

    const concrete = planTierSelection({ tier: "sonnet", explicitSpec: "anthropic/claude-opus-5:low", now: Date.now() });
    assert.equal(concrete.spec, "anthropic/claude-opus-5:low");

    const outOfRange = planTierSelection({ tier: "sonnet", explicitSpec: "tier:sonnet[9]", now: Date.now() });
    assert.equal(outOfRange.spec, "zai/glm-5.3:high");
    assert.match(outOfRange.warnings.join("\n"), /回退自动选择/);

    const malformed = planTierSelection({ tier: "sonnet", explicitSpec: "nonsense", now: Date.now() });
    assert.match(malformed.warnings.join("\n"), /不是合法模型/);
  });

  it("切模证据：4 条仍观察中，5 条达门槛后参与排序（adaptive 开启）", () => {
    writeResolvedTiers();
    const ts = recentTs();
    const addSwitches = (count: number): void => {
      for (let i = 0; i < count; i++) {
        appendAdaptiveEvent(event({
          kind: "model_switch", v: 1, ts, paneId: `w1:p${i}`, role: "worker",
          previousModel: "zai/glm-5.3", model: "openai-codex/gpt-5", source: "set",
        }));
      }
    };

    // adaptive 关闭：切模只记录/展示，不改配置顺序
    addSwitches(5);
    const off = planTierSelection({ tier: "sonnet", now: Date.now() });
    assert.equal(off.spec, "zai/glm-5.3:high");
    assert.ok(off.order.find((candidate) => candidate.key === "openai-codex/gpt-5")!.labels.includes("用户常切换至此"), "关闭时标签仍展示");

    setTierAdaptiveSessionOverride(true);
    const on = planTierSelection({ tier: "sonnet", now: Date.now() });
    assert.equal(on.spec, "openai-codex/gpt-5");
    assert.equal(on.source, "profile");
    assert.ok(on.order[0]!.labels.includes("用户常切换至此"));
    assert.equal(on.order[0]!.labels.includes("用户常点名"), false, "切模不得伪装成点名");
  });

  it("切模样本不足 5 条不参与排序", () => {
    writeResolvedTiers();
    const ts = recentTs();
    for (let i = 0; i < 4; i++) {
      appendAdaptiveEvent(event({
        kind: "model_switch", v: 1, ts, paneId: `w1:p${i}`, role: "worker",
        previousModel: "zai/glm-5.3", model: "openai-codex/gpt-5", source: "set",
      }));
    }
    setTierAdaptiveSessionOverride(true);
    const plan = planTierSelection({ tier: "sonnet", now: Date.now() });
    assert.equal(plan.spec, "zai/glm-5.3:high");
    const target = plan.order.find((candidate) => candidate.key === "openai-codex/gpt-5")!;
    assert.ok(target.labels.includes("观察中"));
    assert.equal(target.profileRank, 0);
  });

  it("负载只在同条目候选中打破同位（entryIndex 来自 resolved 的 group）", () => {
    writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
      opus: [],
      sonnet: [
        { provider: "zai", id: "glm-5.3", group: 0 },
        { provider: "zai", id: "glm-4.7", group: 0 },
      ],
      haiku: [],
    }));
    const plan = planTierSelection({ tier: "sonnet", load: { "zai/glm-5.3": 1 }, now: Date.now() });
    assert.equal(plan.spec, "zai/glm-4.7");
    assert.equal(plan.source, "load");
    assert.deepEqual(plan.candidates.map((candidate) => candidate.entryIndex), [0, 0]);
  });

  it("thinking 画像标签：4 条观察中，5 条出具体 level", () => {
    writeResolvedTiers();
    const ts = recentTs();
    const add = (count: number): void => {
      for (let i = 0; i < count; i++) {
        appendAdaptiveEvent(event({
          kind: "thinking_switch", v: 1, ts, paneId: `w1:p${i}`, role: "worker",
          model: "deepseek/deepseek-flash", previousLevel: "low", level: "high",
        }));
      }
    };
    const labelsOf = (key: string): string[] =>
      planTierSelection({ tier: "sonnet", now: Date.now() }).order.find((candidate) => candidate.key === key)!.labels;

    add(4);
    assert.ok(labelsOf("deepseek/deepseek-flash").includes("thinking 观察中"));
    add(1);
    assert.ok(labelsOf("deepseek/deepseek-flash").includes("Worker 常用 thinking high"));
  });

  it("adaptive 开启时 planTierSelection 的 spec 也补齐；显式/档位后缀优先", () => {
    writeResolvedTiers();
    const now = Date.now();
    writeQuotaSnapshot(snapshot("glm", 95, now)); // 带 :high 的 zai 顺延，选到无后缀的 deepseek
    const ts = recentTs();
    for (let i = 0; i < 5; i++) {
      appendAdaptiveEvent(event({
        kind: "thinking_switch", v: 1, ts, paneId: `w1:p${i}`, role: "worker",
        model: "deepseek/deepseek-flash", previousLevel: "low", level: "high",
      }));
    }

    const off = planTierSelection({ tier: "sonnet", now });
    assert.equal(off.spec, "deepseek/deepseek-flash", "关闭时只展示不应用");

    setTierAdaptiveSessionOverride(true);
    assert.equal(planTierSelection({ tier: "sonnet", now }).spec, "deepseek/deepseek-flash:high");
    // 显式带后缀永远压过学习值；档位条目的后缀同样保留
    assert.equal(planTierSelection({ tier: "sonnet", explicitSpec: "deepseek/deepseek-flash:low", now }).spec, "deepseek/deepseek-flash:low");
    assert.equal(planTierSelection({ tier: "sonnet", explicitSpec: "tier:sonnet[0]", now }).spec, "zai/glm-5.3:high");
  });

  it("fillLearnedThinking：只有 adaptive 开启且无显式后缀时才补齐，显式后缀永远优先", () => {
    const ts = recentTs();
    for (let i = 0; i < 4; i++) {
      appendAdaptiveEvent(event({
        kind: "thinking_switch", v: 1, ts, paneId: `w1:p${i}`, role: "worker",
        model: "deepseek/deepseek-flash", previousLevel: "low", level: "high",
      }));
    }
    assert.equal(fillLearnedThinking("deepseek/deepseek-flash", "worker"), "deepseek/deepseek-flash", "adaptive 关闭时只展示不应用");

    setTierAdaptiveSessionOverride(true);
    assert.equal(fillLearnedThinking("deepseek/deepseek-flash", "worker"), "deepseek/deepseek-flash", "4 条不足门槛");
    appendAdaptiveEvent(event({
      kind: "thinking_switch", v: 1, ts, paneId: "w1:p9", role: "worker",
      model: "deepseek/deepseek-flash", previousLevel: "low", level: "high",
    }));
    assert.equal(fillLearnedThinking("deepseek/deepseek-flash", "worker"), "deepseek/deepseek-flash:high");
    // /team:open 显式后缀与档位条目后缀都已在 spec 里，永不被学习值覆盖
    assert.equal(fillLearnedThinking("deepseek/deepseek-flash:low", "worker"), "deepseek/deepseek-flash:low");
    assert.equal(fillLearnedThinking("zai/glm-5.3:high", "worker"), "zai/glm-5.3:high");
    // 别的角色没有 thinking 样本，不补
    assert.equal(fillLearnedThinking("deepseek/deepseek-flash", "reviewer"), "deepseek/deepseek-flash");
  });

  it("无候选时不给 spec（调用方回落既有解析）", () => {
    const plan = planTierSelection({ tier: "sonnet", now: Date.now() });
    assert.equal(plan.spec, undefined);
    assert.equal(plan.source, "none");
    assert.deepEqual(plan.order, []);
  });
});

describe("tier-adaptive 兼容读取", () => {
  it("点名解析：tier 指代取档位表 thinking，具体 id 原样采信，非法格式拒绝", () => {
    const resolved = {
      opus: [],
      sonnet: [{ provider: "zai", id: "glm-5.3", thinking: "high" as const }],
      haiku: [],
    };
    assert.deepEqual(resolveExplicitModel("tier:sonnet[0]", resolved).model, {
      spec: "zai/glm-5.3:high",
      provider: "zai",
      id: "glm-5.3",
      thinking: "high",
    });
    assert.deepEqual(resolveExplicitModel("deepseek/deepseek-flash:low", resolved).model, {
      spec: "deepseek/deepseek-flash:low",
      provider: "deepseek",
      id: "deepseek-flash",
      thinking: "low",
    });
    assert.equal(resolveExplicitModel("deepseek-flash", resolved).model, undefined);
    assert.match(resolveExplicitModel("tier:sonnet[3]", resolved).warning!, /解析失败/);
  });

  it("旧单快照格式仍可读；写只有 v2，不残留 .tmp", () => {
    const path = process.env["HAPILON_QUOTA_CACHE"]!;
    const now = Date.now();
    mkdirSync(join(home), { recursive: true });
    writeFileSync(path, JSON.stringify(snapshot("glm", 30, now)), "utf8");
    assert.equal(readQuotaSnapshotFor("zai-coding-cn", now)?.provider, "glm");
    assert.equal(readQuotaSnapshots(now).length, 1);

    writeQuotaSnapshot(snapshot("deepseek", 40, now));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.version, 2);
    assert.deepEqual(Object.keys(onDisk.providers).sort(), ["deepseek", "glm"]);
    assert.equal(existsSync(`${path}.tmp`), false);
  });

  it("多 provider 各自独立 TTL：一个过期不影响另一个，写入时顺便清掉过期条目", () => {
    const path = process.env["HAPILON_QUOTA_CACHE"]!;
    const now = Date.now();
    writeQuotaSnapshot(snapshot("glm", 30, now));
    writeQuotaSnapshot(snapshot("deepseek", 40, now));
    // 把 glm 的时间戳改到 20 分钟前（模拟它早已超过 15min TTL）
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.providers.glm.timestamp = now - 20 * 60 * 1000;
    writeFileSync(path, JSON.stringify(file), "utf8");

    assert.equal(readQuotaSnapshotFor("glm", now), undefined);
    assert.equal(readQuotaSnapshotFor("zai", now), undefined);
    assert.equal(readQuotaSnapshotFor("deepseek", now)?.provider, "deepseek");
    assert.deepEqual(readQuotaSnapshots(now).map((entry) => entry.provider), ["deepseek"]);

    writeQuotaSnapshot(snapshot("openai-codex", 50, now));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(onDisk.providers).sort(), ["deepseek", "openai-codex"]);
  });

  it("损坏快照文件读为空，写入从零恢复且不抛", () => {
    const path = process.env["HAPILON_QUOTA_CACHE"]!;
    const now = Date.now();
    writeFileSync(path, "{broken json", "utf8");
    assert.deepEqual(readQuotaSnapshots(now), []);
    writeQuotaSnapshot(snapshot("glm", 30, now));
    assert.equal(readQuotaSnapshotFor("glm", now)?.windows[0]?.percent, 30);
  });
});
