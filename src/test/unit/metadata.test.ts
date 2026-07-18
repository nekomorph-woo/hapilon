/**
 * metadata.ts 单元测试 — hpl-system-prompt 元数据共享模块
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setLastMeta,
  getLastMeta,
  clearLastMeta,
} from "../../extensions/hpl-system-prompt/metadata.js";
import type { SystemPromptMeta } from "../../extensions/hpl-context-viewer/types.js";

describe("metadata", () => {
  beforeEach(() => {
    clearLastMeta();
  });

  const sampleMeta: SystemPromptMeta = {
    assembledAt: 1700000000000,
    cwd: "/test/project",
    sections: {
      roleAndIdentity: 200,
      piDocumentation: 500,
      tools: 300,
      guidelines: 400,
      hapilonInstructions: 0,
      hapilonRules: 800,
      contextFiles: 0,
      skills: 0,
      customToolsNote: 150,
      additionalData: 0,
      environment: 100,
    },
  };

  it("正常路径: setLastMeta 后 getLastMeta 返回相同对象", () => {
    setLastMeta(sampleMeta);
    assert.deepEqual(getLastMeta(), sampleMeta);
  });

  it("边界条件: 未调用 setLastMeta 时 getLastMeta 返回 undefined", () => {
    assert.equal(getLastMeta(), undefined);
  });

  it("边界条件: clearLastMeta 后 getLastMeta 返回 undefined", () => {
    setLastMeta(sampleMeta);
    clearLastMeta();
    assert.equal(getLastMeta(), undefined);
  });

  it("正常路径: 多次 setLastMeta 覆盖上一次", () => {
    setLastMeta(sampleMeta);
    const newMeta: SystemPromptMeta = { ...sampleMeta, assembledAt: 1700000000001 };
    setLastMeta(newMeta);
    assert.equal(getLastMeta()?.assembledAt, 1700000000001);
  });
});
