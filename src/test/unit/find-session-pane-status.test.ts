/**
 * pane.ts setStatus 进度状态行单测：仅 searching 态刷新、不动列表排版。
 * 独立文件，避免改已有 UI 测试（hpl-find-session-pane.test.ts 归 UI worker）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { FindSessionPane } from "../../extensions/hpl-find-session/pane.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTheme: any = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
};

function makePane() {
  const renders: string[][] = [];
  const pane = new FindSessionPane(
    { terminal: { rows: 40 }, requestRender() { renders.push([]); } },
    mockTheme,
    null,
    () => {},
    { onSearch: () => {}, onPick: () => {} },
  );
  return { pane, renders };
}

function visibleLines(pane: FindSessionPane): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (pane as any).lines.map((l: string) => stripTerminalSequences(l).replace(/[│╭╮╰╯─]/g, "").trim());
}

describe("FindSessionPane.setStatus 进度状态", () => {
  it("searching 态刷新状态文案，布局行数不变", () => {
    const { pane } = makePane();
    // 进入 searching 态：模拟回车发起搜索
    pane.handleInput("帮我找到修锁的会话");
    pane.handleInput("\r");
    assert.equal(pane.mode, "searching");
    const before = visibleLines(pane);
    pane.setStatus("已读取索引覆盖：已索引 5/8 个会话");
    const after = visibleLines(pane);
    assert.ok(after.some((l) => l.includes("已索引 5/8")), `after=${after.join("|")}`);
    assert.equal(before.length, after.length, "状态刷新不改行数布局");
    pane.setStatus("正在扩大检索：全部 8 条摘要检查中");
    assert.ok(visibleLines(pane).some((l) => l.includes("扩大检索")));
  });

  it("list/input 态 setStatus 不生效（防止污染结果态）", () => {
    const { pane } = makePane();
    pane.handleInput("查询");
    assert.equal(pane.mode, "input");
    pane.setStatus("不该出现");
    assert.ok(!visibleLines(pane).some((l) => l.includes("不该出现")));
  });
});
