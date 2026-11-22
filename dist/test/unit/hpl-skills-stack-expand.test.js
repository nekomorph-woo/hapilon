/**
 * stack-expand.ts 单元测试 — /skill: 多技能展开纯逻辑
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandSkillStack, } from "../../extensions/hpl-skills-discover/stack-expand.js";
/** 构造测试用 resolver：files 表 name → body，未列出的名字不可解析 */
const mkResolver = (files) => {
    const byName = new Map(Object.entries(files));
    return (name) => byName.has(name) ? { filePath: `/skills/${name}/SKILL.md`, body: byName.get(name) } : null;
};
describe("expandSkillStack", () => {
    const resolve = mkResolver({ a: "BODY_A", b: "BODY_B", c: "BODY_C", d: "BODY_D" });
    it("头部堆叠: 两个 skill + 尾部参数 → 全部展开，原位占位", () => {
        const result = expandSkillStack("/skill:a /skill:b 修个 bug", resolve);
        assert.equal(result, '<skill name="a" location="/skills/a/SKILL.md">\n' +
            "References are relative to /skills/a.\n\nBODY_A\n</skill>\n\n" +
            '<skill name="b" location="/skills/b/SKILL.md">\n' +
            "References are relative to /skills/b.\n\nBODY_B\n</skill>\n\n" +
            "[skill:a] [skill:b] 修个 bug");
    });
    it("单个 skill 在开头也展开并占位（不再交还 pi 原生挖空）", () => {
        const result = expandSkillStack("/skill:a 修个 bug", resolve);
        assert.ok(result?.startsWith('<skill name="a"'));
        assert.ok(result?.endsWith("[skill:a] 修个 bug"));
        const bare = expandSkillStack("/skill:a", resolve);
        assert.ok(bare?.endsWith("BODY_A\n</skill>\n\n[skill:a]"));
    });
    it("普通文本与空输入 → null", () => {
        assert.equal(expandSkillStack("干点活", resolve), null);
        assert.equal(expandSkillStack("", resolve), null);
        assert.equal(expandSkillStack("/skill:", resolve), null);
    });
    it("未知名按字面保留，不挡后面的可解析 token", () => {
        const result = expandSkillStack("先 /skill:nope 再 /skill:b 收尾", resolve);
        assert.ok(result?.startsWith('<skill name="b"'));
        assert.ok(result?.endsWith("先 /skill:nope 再 [skill:b] 收尾"));
    });
    it("上限: 超过 MAX_STACK 个 → 只展开前 MAX_STACK 个，其余落尾部字面", () => {
        const result = expandSkillStack("/skill:a /skill:b /skill:c /skill:d 尾部", resolve);
        assert.ok(result?.includes('name="a"'));
        assert.ok(result?.includes('name="b"'));
        assert.ok(result?.includes('name="c"'));
        assert.ok(!result?.includes('name="d" location'));
        assert.ok(result?.endsWith("[skill:a] [skill:b] [skill:c] /skill:d 尾部"));
    });
    it("去重: 重复 token 只展开一次，原位都留占位符", () => {
        const result = expandSkillStack("/skill:a /skill:a /skill:b", resolve);
        assert.equal(result?.match(/<skill name="a"/g)?.length, 1);
        assert.equal(result?.match(/<skill name="b"/g)?.length, 1);
        assert.ok(result?.endsWith("[skill:a] [skill:a] [skill:b]"));
        const mid = expandSkillStack("帮我 /skill:a 再 /skill:a 一下", resolve);
        assert.equal(mid?.match(/<skill name="a"/g)?.length, 1);
        assert.ok(mid?.endsWith("帮我 [skill:a] 再 [skill:a] 一下"));
    });
    it("herdr 包裹: <hc from=…> 内层展开后重新包回", () => {
        const result = expandSkillStack('<hc from="t23">/skill:a /skill:b 修个 bug</hc>', resolve);
        assert.ok(result?.startsWith('<hc from="t23"><skill name="a"'));
        assert.ok(result?.endsWith("[skill:a] [skill:b] 修个 bug</hc>"));
    });
    it("herdr 包裹: 中段 token 与普通消息", () => {
        const wrapped = expandSkillStack('<hc from="t23">帮我 /skill:a 看看</hc>', resolve);
        assert.ok(wrapped?.startsWith('<hc from="t23"><skill name="a"'));
        assert.ok(wrapped?.endsWith("帮我 [skill:a] 看看</hc>"));
        assert.equal(expandSkillStack('<hc from="t23">普通消息</hc>', resolve), null);
    });
    it("herdr 包裹: 单个 skill 也由这里展开（包裹下 pi 原生不触发）", () => {
        const wrapped = expandSkillStack('<hc from="t23">/skill:a 修个 bug</hc>', resolve);
        assert.ok(wrapped?.startsWith('<hc from="t23"><skill name="a"'));
        assert.ok(wrapped?.endsWith("[skill:a] 修个 bug</hc>"));
    });
});
