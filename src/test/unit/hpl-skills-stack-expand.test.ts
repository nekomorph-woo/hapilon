/**
 * stack-expand.ts 单元测试 — /skill: 多技能展开纯逻辑
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

  it("头部堆叠: 两个 skill + 尾部参数 → 全部展开，参数拼在末尾一次", () => {
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

  it("头部堆叠: 两个 skill 无参数 → 仅两块拼接", () => {
    const result = expandSkillStack("/skill:a /skill:b", resolve);
    assert.ok(result?.startsWith("<skill name=\"a\""));
    assert.ok(result?.endsWith('References are relative to /skills/b.\n\nBODY_B\n</skill>'));
  });

  it("交还原生: 开头恰好单个 skill 且别处没有 → null（pi 原生单展开接管）", () => {
    assert.equal(expandSkillStack("/skill:a 修个 bug", resolve), null);
    assert.equal(expandSkillStack("/skill:a", resolve), null);
  });

  it("交还原生: 普通文本与空输入 → null", () => {
    assert.equal(expandSkillStack("干点活", resolve), null);
    assert.equal(expandSkillStack("", resolve), null);
    assert.equal(expandSkillStack("/skill:", resolve), null);
  });

  it("交还原生: 头部单个 + 中段未知名 → null（未知名按字面交原生路径）", () => {
    assert.equal(expandSkillStack("/skill:a 修 /skill:nope 一下", resolve), null);
  });

  it("中段展开: 开头是正文，/skill: 在中间也展开为块", () => {
    const result = expandSkillStack("帮我 /skill:a 看看", resolve);
    assert.ok(result?.startsWith('<skill name="a"'));
    assert.ok(result?.endsWith("帮我 看看"));
  });

  it("中段展开: 未知名按字面保留，不挡后面的可解析 token", () => {
    const result = expandSkillStack("先 /skill:nope 再 /skill:b 收尾", resolve);
    assert.ok(result?.startsWith('<skill name="b"'));
    assert.ok(result?.endsWith("先 /skill:nope 再 收尾"));
  });

  it("上限: 超过 MAX_STACK 个 → 只展开前 MAX_STACK 个，其余落尾部字面", () => {
    const result = expandSkillStack("/skill:a /skill:b /skill:c /skill:d 尾部", resolve);
    assert.ok(result?.includes('name="a"'));
    assert.ok(result?.includes('name="b"'));
    assert.ok(result?.includes('name="c"'));
    assert.ok(!result?.includes('name="d" location'));
    assert.ok(result?.endsWith("/skill:d 尾部"));
  });

  it("去重: 重复堆叠同一 skill 只展开一次，token 不残留", () => {
    const result = expandSkillStack("/skill:a /skill:a /skill:b", resolve);
    assert.equal(result?.match(/<skill name="a"/g)?.length, 1);
    assert.equal(result?.match(/<skill name="b"/g)?.length, 1);
  });

  it("herdr 包裹: <hc from=…> 内层展开后重新包回，尾部保留", () => {
    const result = expandSkillStack('<hc from="t23">/skill:a /skill:b 修个 bug</hc>', resolve);
    assert.ok(result?.startsWith('<hc from="t23"><skill name="a"'));
    assert.ok(result?.endsWith("修个 bug</hc>"));
  });

  it("herdr 包裹: 中段 token 与普通消息", () => {
    const wrapped = expandSkillStack('<hc from="t23">帮我 /skill:a 看看</hc>', resolve);
    assert.ok(wrapped?.startsWith('<hc from="t23"><skill name="a"'));
    assert.ok(wrapped?.endsWith("帮我 看看</hc>"));
    assert.equal(expandSkillStack('<hc from="t23">普通消息</hc>', resolve), null);
    assert.equal(expandSkillStack('<hc from="t23">/skill:a 参数</hc>', resolve), null);
  });
});
