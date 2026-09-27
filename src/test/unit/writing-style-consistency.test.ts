// 写作纪律三处产物的一致性锁：sections.ts（system prompt 段）、human-voice SKILL.md、
// references/gates.md 各自持有一份忌口词表与判定口径，历史上无锁时已漂移过一次
// （评审 2026-09-26-writing-style-review：三处三口径）。此测试锁三件事：
// 1. 词表同步——sections 里列出的每个黑话词必须同时出现在两份 skill 文件里；
// 2. 口径落位——三处都携带"分级判定 + 判定边界 + 唯一豁免"的关键语义，防止任一处回退成零容忍；
// 3. 适用范围——所有输出一视同仁且无时机限定回退（不得只约束"写方案、长文档时"）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WRITING_STYLE_TEXT } from "../../extensions/hpl-system-prompt/sections.js";

const skillDir = fileURLToPath(new URL("../../../resources/skills/human-voice", import.meta.url));
const skillMd = readFileSync(`${skillDir}/SKILL.md`, "utf8");
const gatesMd = readFileSync(`${skillDir}/references/gates.md`, "utf8");

const BUZZWORDS = ["赋能", "抓手", "闭环", "沉淀", "打通", "拉齐", "链路", "颗粒度", "心智", "底层逻辑", "打法", "范式"];

describe("写作纪律三处产物一致性", () => {
  it("sections 的忌口词表与两份 skill 文件同步", () => {
    for (const word of BUZZWORDS) {
      assert.ok(WRITING_STYLE_TEXT.includes(word), `sections.ts 缺忌口词：${word}`);
      assert.ok(skillMd.includes(word), `human-voice/SKILL.md 缺忌口词：${word}`);
      assert.ok(gatesMd.includes(word), `gates.md 缺忌口词：${word}`);
    }
  });

  it("三处都是分级判定口径，无一处回退零容忍", () => {
    assert.ok(WRITING_STYLE_TEXT.includes("两次以上"), "sections.ts 须写明「两次以上才算违例」");
    assert.equal(WRITING_STYLE_TEXT.includes("出现即删改"), false, "sections.ts 不得回退零容忍口径");
    assert.ok(gatesMd.includes("命中一次记为线索"), "gates.md 须保留分级判定");
    assert.ok(skillMd.includes("one hit is a note, not a verdict"), "SKILL.md 须保留分级判定");
  });

  it("三处都有判定边界与唯一豁免", () => {
    assert.ok(WRITING_STYLE_TEXT.includes("判定边界"), "sections.ts 须改称判定边界（豁免一词只留给用户豁免）");
    assert.ok(WRITING_STYLE_TEXT.includes("唯一的豁免"), "sections.ts 须携带唯一豁免条款");
    assert.ok(gatesMd.includes("判定边界"), "gates.md 判定边界须在场");
    assert.ok(gatesMd.includes("唯一的豁免"), "gates.md 唯一豁免须在场");
    assert.ok(skillMd.includes("Boundary"), "SKILL.md 判定边界须在场（Boundary 条款）");
    assert.ok(skillMd.includes("only exemption"), "SKILL.md 唯一豁免须在场（only exemption 条款）");
  });

  it("适用范围声明在位，无时机限定回退", () => {
    assert.ok(WRITING_STYLE_TEXT.includes("所有输出一视同仁"), "sections.ts 须声明所有输出一视同仁");
    assert.ok(WRITING_STYLE_TEXT.includes("状态播报"), "sections.ts 适用范围须点名状态播报");
    assert.equal(WRITING_STYLE_TEXT.includes("写方案、长文档或起名字前"), false, "不得回退到只约束交付物时机的表述");
    assert.ok(skillMd.includes("status update"), "SKILL.md 触发场景须覆盖状态播报");
    assert.ok(skillMd.includes("MANDATORY"), "SKILL.md description 须为强制触发句式");
  });

  it("事实枚举与诊断性否定两个语义条件在位", () => {
    assert.ok(WRITING_STYLE_TEXT.includes("互不可推"), "排比条款须豁免互不可推的并列");
    assert.ok(WRITING_STYLE_TEXT.includes("句意不受损"), "负平行句须保留句意不受损前提");
    assert.ok(gatesMd.includes("互不可推"), "gates 排比 gate 同步豁免");
  });

  it("英文条款修错落位：features 的替换词是 has 而非 is", () => {
    assert.ok(WRITING_STYLE_TEXT.includes('"has"'), "英文条款须含 has 替换");
    assert.equal(/"features"[^\\n]*use "is"/.test(WRITING_STYLE_TEXT), false, "features 不得再指向 is");
    assert.ok(WRITING_STYLE_TEXT.includes("in order to"), "英文侧须补名词化条款");
  });
});
