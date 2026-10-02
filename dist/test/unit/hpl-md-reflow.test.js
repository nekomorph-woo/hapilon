import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reflowHardWraps } from "../../extensions/hpl-md-reflow/index.js";
describe("reflowHardWraps", () => {
    it("散文硬换行接回通栏，CJK 相接不补空格", () => {
        const md = "背景：考卷要求每个替代角色写清损失。\n代价有两半：";
        assert.equal(reflowHardWraps(md), "背景：考卷要求每个替代角色写清损失。代价有两半：");
    });
    it("拉丁词边界补一个空格", () => {
        const md = "running the\nserver now";
        assert.equal(reflowHardWraps(md), "running the server now");
    });
    it("标题与分隔线不并入段落", () => {
        const md = "### 决策 1\n前半句断了\n后半句续上\n─────\n下一节";
        assert.equal(reflowHardWraps(md), "### 决策 1\n前半句断了后半句续上\n─────\n下一节");
    });
    it("列表项续行并入条目，条目间不粘连", () => {
        const md = "- 前半句：这条链路就断了——原文直接支撑白纸\n黑字，是事实\n- 后半句：保持现状";
        assert.equal(reflowHardWraps(md), "- 前半句：这条链路就断了——原文直接支撑白纸黑字，是事实\n- 后半句：保持现状");
    });
    it("代码围栏内逐字保留", () => {
        const md = "说明如下\n```\nkeep   this\n  exactly\n```\n尾部续行";
        assert.equal(reflowHardWraps(md), "说明如下\n```\nkeep   this\n  exactly\n```\n尾部续行");
    });
    it("表格行与引用行不粘连", () => {
        const md = "| a | b |\n| --- | --- |\n正文一行\n> 引用一行\n下一行";
        assert.equal(reflowHardWraps(md), "| a | b |\n| --- | --- |\n正文一行\n> 引用一行\n下一行");
    });
    it("空行分段不粘连", () => {
        const md = "第一段上半\n第一段下半\n\n第二段";
        assert.equal(reflowHardWraps(md), "第一段上半第一段下半\n\n第二段");
    });
    it("行尾两个空格的强制换行保留为独立行", () => {
        const md = "第一行  \n第二行";
        assert.equal(reflowHardWraps(md), "第一行\n第二行");
    });
    it("\\r\\n 归一为 \\n", () => {
        assert.equal(reflowHardWraps("上\r\n下"), "上下");
    });
    // 圈号与中文序号列表（用户手打的软换行条目不被粘掉）
    it("圈号序号行各自保留", () => {
        const md = "黑话候选确认\n①全部用 subagent 去检索\n②717182 散文轴格式不支持\n③Electron UI 壳";
        assert.equal(reflowHardWraps(md), "黑话候选确认\n①全部用 subagent 去检索\n②717182 散文轴格式不支持\n③Electron UI 壳");
    });
    it("圈号行的悬挂续行仍并入条目", () => {
        assert.equal(reflowHardWraps("①确认条目\n后续说明"), "①确认条目后续说明");
    });
    it("中文序号行保留：一、1、（一）", () => {
        const md = "前言\n一、黑话确认\n1、散文轴\n（一）Electron 壳";
        assert.equal(reflowHardWraps(md), "前言\n一、黑话确认\n1、散文轴\n（一）Electron 壳");
    });
    // 围栏只认同类符号闭合
    it("``` 围栏内嵌 ~~~ 不提前闭合", () => {
        const md = "说明\n```\n甲\n~~~\n乙\n丙\n```\n丁";
        assert.equal(reflowHardWraps(md), "说明\n```\n甲\n~~~\n乙\n丙\n```\n丁");
    });
    it("~~~ 围栏内嵌 ``` 不提前闭合", () => {
        const md = "~~~\n甲\n```\n乙\n```\n丙\n~~~";
        assert.equal(reflowHardWraps(md), "~~~\n甲\n```\n乙\n```\n丙\n~~~");
    });
    // 表格：无首管道 GFM 表格不被粘坏；孤立 | 开头行是散文
    it("无首管道表格整体保留", () => {
        const md = "项目 | 状态\n--- | ---\nreflow | 已验证";
        assert.equal(reflowHardWraps(md), "项目 | 状态\n--- | ---\nreflow | 已验证");
    });
    it("孤立 | 开头的散文行参与粘接", () => {
        assert.equal(reflowHardWraps("前半\n| 普通文本\n后半"), "前半| 普通文本后半");
    });
    // 分隔线与裸结构行
    it("下划线分隔线独立保留", () => {
        assert.equal(reflowHardWraps("前文\n___\n后文"), "前文\n___\n后文");
    });
    it("裸 # 与 - 行不被粘接", () => {
        assert.equal(reflowHardWraps("前文\n#\n中\n-\n后文"), "前文\n#\n中\n-\n后文");
    });
    // CJK 范围与码点安全
    it("圈号作粘接边界不插空格（非行首）", () => {
        assert.equal(reflowHardWraps("备注①\n后续说明"), "备注①后续说明");
    });
    it("Ext B 增补平面字符相接不插空格", () => {
        assert.equal(reflowHardWraps("𠀀\n𠂉"), "𠀀𠂉");
    });
    // 粘接边界
    it("行尾 URL 接中文补空格防吞字", () => {
        assert.equal(reflowHardWraps("访问 https://example.com\n中文继续"), "访问 https://example.com 中文继续");
    });
    it("路径断行不插空格", () => {
        assert.equal(reflowHardWraps("下载 src/\nfoo.ts 试试"), "下载 src/foo.ts 试试");
    });
    it("链接语法跨行拆开时保住 [文本](url)", () => {
        assert.equal(reflowHardWraps("见 [参考文档]\n(https://a.com/b) 说明"), "见 [参考文档](https://a.com/b) 说明");
    });
    // 缩进保留
    it("嵌套列表缩进不丢", () => {
        const md = "- 一级\n  - 二级\n    - 三级";
        assert.equal(reflowHardWraps(md), "- 一级\n  - 二级\n    - 三级");
    });
    it("段落首行前导缩进保留", () => {
        assert.equal(reflowHardWraps("  第一行\n  第二行"), "  第一行第二行");
    });
});
