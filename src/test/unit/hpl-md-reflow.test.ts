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
});
