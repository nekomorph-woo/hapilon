/**
 * stack-expand.ts 单元测试 — /skill: 头部堆叠展开纯逻辑
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandSkillStack,
  MAX_STACK,
  type ResolvedSkill,
} from "../../extensions/hpl-skills-discover/stack-expand.js";

/** 构造测试用 resolver：files 表 name → body，未列出的名字不可解析 */
const mkResolver = (files: Record<string, string>) => {
  const byName = new Map(Object.entries(files));
  return (name: string): ResolvedSkill | null =>
    byName.has(name) ? { filePath: `/skills/${name}/SKILL.md`, body: byName.get(name)! } : null;
};

describe("expandSkillStack", () => {
  const resolve = mkResolver({ a: "BODY_A", b: "BODY_B", c: "BODY_C", d: "BODY_D" });

  it("正常路径: 两个 skill + 尾部参数 → 全部展开，参数拼在末尾一次", () => {
    const result = expandSkillStack("/skill:a /skill:b 修个 bug", resolve);
    assert.equal(
      result,
      "<skill name=\"a\" location=\"/skills/a/SKILL.md\">\n" +
        "References are relative to /skills/a.\n\nBODY_A\n</skill>\n\n" +
        "<skill name=\"b\" location=\"/skills/b/SKILL.md\">\n" +
        "References are relative to /skills/b.\n\nBODY_B\n</skill>\n\n" +
        "修个 bug",
    );
  });

  it("正常路径: 两个 skill 无参数 → 仅两块拼接", () => {
    const result = expandSkillStack("/skill:a /skill:b", resolve);
    assert.ok(result?.startsWith("<skill name=\"a\""));
    assert.ok(result?.includes("<skill name=\"b\""));
    assert.ok(!result?.includes("BODY_B\n</skill>\n\n  "));
  });

  it("交还原生: 单个 skill → null（pi 原生单展开接管）", () => {
    assert.equal(expandSkillStack("/skill:a 修个 bug", resolve), null);
  });

  it("交还原生: 非 /skill: 开头 → null", () => {
    assert.equal(expandSkillStack("干点活 /skill:b", resolve), null);
  });

  it("交还原生: 第二个名字不可解析 → null（原生展开首个，未知名按字面传）", () => {
    assert.equal(expandSkillStack("/skill:a /skill:nope 参数", resolve), null);
  });

  it("上限: 超过 MAX_STACK 个 → 只展开前 MAX_STACK 个，其余落尾部字面", () => {
    const result = expandSkillStack("/skill:a /skill:b /skill:c /skill:d 尾部", resolve);
    assert.ok(result?.includes('name="a"'));
    assert.ok(result?.includes('name="b"'));
    assert.ok(result?.includes('name="c"'));
    assert.ok(!result?.includes('name="d" location'));
    assert.ok(result?.endsWith("尾部")); // 尾部含字面 /skill:d
    assert.ok(result?.includes("/skill:d"));
  });

  it("去重: 重复堆叠同一 skill 只展开一次", () => {
    const result = expandSkillStack("/skill:a /skill:a /skill:b", resolve);
    assert.equal(result?.match(/<skill name="a"/g)?.length, 1);
    assert.equal(result?.match(/<skill name="b"/g)?.length, 1);
  });

  it("中段 mention 不展开: 尾部里的 /skill: 保持字面", () => {
    const result = expandSkillStack("/skill:a /skill:b 顺带看下 /skill:c", resolve);
    assert.ok(result?.endsWith("顺带看下 /skill:c"));
    assert.ok(!result?.includes('name="c"'));
  });

  it("空输入与纯前缀: 不炸、返回 null", () => {
    assert.equal(expandSkillStack("", resolve), null);
    assert.equal(expandSkillStack("/skill:", resolve), null);
  });

  it("herdr 包裹: <hc from=…> 内层堆叠展开后重新包回，尾部保留", () => {
    const result = expandSkillStack('<hc from="t23">/skill:a /skill:b 修个 bug</hc>', resolve);
    assert.ok(result?.startsWith('<hc from="t23"><skill name="a"'));
    assert.ok(result?.endsWith("修个 bug</hc>"));
    assert.ok(result?.includes('name="b"'));
  });

  it("herdr 包裹: 普通消息与单 skill 仍返回 null", () => {
    assert.equal(expandSkillStack('<hc from="t23">普通消息</hc>', resolve), null);
    assert.equal(expandSkillStack('<hc from="t23">/skill:a 参数</hc>', resolve), null);
  });
});
