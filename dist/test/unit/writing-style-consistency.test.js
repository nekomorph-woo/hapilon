// 写作纪律一致性锁：system prompt 的 writing_style 段（sections.ts）是唯一常驻
// 文风规则（human-voice skill 已移除）。answer-me-with-html 的 STE lint 管页面草稿，
// 两处管同一件事——此测试锁三个不变量：
// 1. 词表同步——amwh lint 的中文套话表（上游 src/lint/wordlist.zh.js 的 ZH_CLICHES，
//    下方硬拷贝；re-vendor amwh 时须对照更新）必须是 writing_style 忌口表的子集，
//    lint 会警告的词 prompt 绝不放过；
// 2. 口径落位——writing_style 携带「分级判定 + 判定边界 + 唯一豁免」的关键语义，
//    防止回退成零容忍；
// 3. 适用范围——所有输出一视同仁且无时机限定回退（不得只约束"写方案、长文档时"）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WRITING_STYLE_TEXT } from "../../extensions/hpl-system-prompt/sections.js";
// amwh ZH_CLICHES 硬拷贝（fa42f5c 版 wordlist.zh.js）——词表本体在 skill 的 bundle 里
// 不可 import，re-vendor answer-me-with-html 时对照上游源文件更新这份拷贝。
const AMWH_CLICHES = [
    "赋能", "抓手", "闭环", "打通", "全方位", "多维度", "深度融合", "显著提升", "至关重要", "不可或缺",
    "与此同时", "综上所述", "值得注意的是", "总而言之", "众所周知", "毋庸置疑", "一站式", "底层逻辑", "颗粒度", "方法论",
    "下面我来", "下面我将", "接下来我将", "让我来", "让我们来", "总的来说", "希望对你有帮助", "希望对您有帮助", "如有疑问",
];
// hapilon 侧自有的忌口（amwh 词表之外），一并钉住防漂移
const HAPILON_ONLY = ["沉淀", "拉齐", "链路", "心智", "打法", "范式", "说实话", "不得不说", "有一说一"];
describe("写作纪律一致性（writing_style ↔ amwh lint）", () => {
    it("amwh lint 的套话词表是 writing_style 忌口表的子集", () => {
        for (const word of AMWH_CLICHES) {
            assert.ok(WRITING_STYLE_TEXT.includes(word), `writing_style 缺 amwh 套话词：${word}`);
        }
        for (const word of HAPILON_ONLY) {
            assert.ok(WRITING_STYLE_TEXT.includes(word), `writing_style 缺自有忌口词：${word}`);
        }
    });
    it("amwh 句法增量在场：轻动词、句长预算、给数、端点、一词一义", () => {
        for (const marker of ["加以", "予以", "做出", "~35 字", "~6 句", "说了数量就给数", "端点", "键入"]) {
            assert.ok(WRITING_STYLE_TEXT.includes(marker), `writing_style 缺 amwh 同源规则标记：${marker}`);
        }
    });
    it("分级判定口径在场，无零容忍回退", () => {
        assert.ok(WRITING_STYLE_TEXT.includes("两次以上"), "须写明「两次以上才算违例」");
        assert.equal(WRITING_STYLE_TEXT.includes("出现即删改"), false, "不得回退零容忍口径");
        assert.ok(WRITING_STYLE_TEXT.includes("判定边界"), "须携带判定边界（引用不在检查范围）");
        assert.ok(WRITING_STYLE_TEXT.includes("唯一的豁免"), "须携带唯一豁免条款");
    });
    it("适用范围一视同仁，无时机限定回退", () => {
        assert.ok(WRITING_STYLE_TEXT.includes("一视同仁"), "须声明所有输出一视同仁");
        assert.ok(WRITING_STYLE_TEXT.includes("commit message"), "覆盖面须含 commit message");
        assert.equal(WRITING_STYLE_TEXT.includes("human-voice"), false, "human-voice skill 已移除，不得再引用");
    });
    it("amwh skill 在场且带适配段（re-vendor 后此断言提醒同步词表拷贝）", () => {
        const skill = readFileSync(fileURLToPath(new URL("../../../resources/skills/answer-me-with-html/SKILL.md", import.meta.url)), "utf8");
        assert.ok(skill.includes("hapilon: adaptation start"), "amwh SKILL.md 须带 hapilon 适配段");
        assert.ok(skill.includes("AM_HOME"), "适配段须写明 AM_HOME 约定");
    });
});
