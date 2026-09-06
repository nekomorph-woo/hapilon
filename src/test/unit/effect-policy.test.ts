import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideEffectMode, type ProjectSignals } from "../../extensions/hpl-effect-policy/policy.js";

const signals = (overrides: Partial<ProjectSignals> = {}): ProjectSignals => ({
  language: "typescript",
  effectInstalled: false,
  effectImportsFound: false,
  packageManager: undefined,
  hasAgentsMd: false,
  isGreenfield: false,
  isScriptTask: false,
  ...overrides,
});

describe("decideEffectMode 决策表", () => {
  it("非 TypeScript 项目始终 disabled", () => {
    assert.equal(decideEffectMode(signals({ language: "javascript", effectInstalled: true, isGreenfield: true })), "disabled");
    assert.equal(decideEffectMode(signals({ language: "other", effectImportsFound: true, hasAgentsMd: true })), "disabled");
  });

  it("已安装 Effect 的 TypeScript 项目 required", () => {
    assert.equal(decideEffectMode(signals({ effectInstalled: true })), "required");
    assert.equal(decideEffectMode(signals({ effectInstalled: true, hasAgentsMd: false, isGreenfield: false })), "required");
  });

  it("检测到 Effect import 即 required，独立于安装信号", () => {
    assert.equal(decideEffectMode(signals({ effectImportsFound: true })), "required");
  });

  it("Effect 安装与 import 同时存在仍 required", () => {
    assert.equal(decideEffectMode(signals({ effectInstalled: true, effectImportsFound: true })), "required");
  });

  it("AGENTS.md 优先于 greenfield，返回 respect-project", () => {
    assert.equal(decideEffectMode(signals({ hasAgentsMd: true, isGreenfield: true })), "respect-project");
  });

  it("无 AGENTS.md 的全新 TypeScript 项目 prefer", () => {
    assert.equal(decideEffectMode(signals({ isGreenfield: true })), "prefer");
  });

  it("普通 TypeScript 项目默认 respect-project", () => {
    assert.equal(decideEffectMode(signals()), "respect-project");
  });

  it("无关信号不改变默认决策", () => {
    assert.equal(decideEffectMode(signals({ packageManager: "pnpm", isScriptTask: true })), "respect-project");
  });
});
