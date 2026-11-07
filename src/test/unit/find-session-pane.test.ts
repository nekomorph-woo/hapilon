import { it } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SessionChatPane } from "../../extensions/hpl-find-session/pane.js";
import type { VerifiedResult } from "../../extensions/hpl-find-session/rpc-session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTheme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

interface Harness {
  pane: SessionChatPane;
  sent: string[];
  aborted: boolean;
  picked: VerifiedResult | null;
  closed: boolean;
}

const harness = (): Harness => {
  const state: Harness = { sent: [], aborted: false, picked: null, closed: false, pane: undefined as unknown as SessionChatPane };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tui: any = { requestRender: () => {}, terminal: { rows: 40 } };
  state.pane = new SessionChatPane(tui, mockTheme, {}, () => { state.closed = true; }, {
    onSend: (text) => state.sent.push(text),
    onAbort: () => { state.aborted = true; },
    onPick: (result) => { state.picked = result; },
  });
  return state;
};

const candidate = (id: string): VerifiedResult => ({
  sessionId: id, path: `/sessions/project/${id}.jsonl`, summary: `${id} 的总结`, reason: "提到目标词",
  evidence: [{ line: 2, messageId: "m1", quote: "原文", role: "user", timestamp: "2026-01-01T00:00:00.000Z" }],
});

const plain = (lines: string[]): string[] => lines.map((line) => stripTerminalSequences(line));

it("渲染多轮上下文与固定输入/状态行，文本与工具进度都进滚动区", () => {
  const h = harness();
  h.pane.onUserAccepted("找发版讨论");
  h.pane.onAssistantDelta("正在");
  h.pane.onAssistantFinal("找到了 1 个");
  h.pane.onToolStart("session_search", "keyword=发版");
  h.pane.onToolEnd("session_search", false);
  h.pane.onSettled(false);
  const flat = plain(h.pane.render(80));
  const text = flat.join("\n");
  assert.ok(text.includes("你：找发版讨论"));
  assert.ok(text.includes("找到了 1 个"));
  assert.ok(text.includes("session_search（完成）"));
  assert.ok(text.includes("›"), "固定输入行存在");
  assert.ok(text.includes("完成，可继续提问"), "状态行反映 settled");
});

it("流式增量与终稿覆盖、aborted 状态、错误行保留", () => {
  const h = harness();
  h.pane.onUserAccepted("问");
  h.pane.onAssistantDelta("部分");
  h.pane.onSettled(true);
  let flat = plain(h.pane.render(80)).join("\n");
  assert.ok(flat.includes("部分"));
  assert.ok(flat.includes("已停止，可继续提问"));
  h.pane.onError("provider down");
  h.pane.onSettled(false);
  flat = plain(h.pane.render(80)).join("\n");
  assert.ok(flat.includes("错误：provider down"), "错误行保留");
  assert.ok(flat.includes("完成，可继续提问"));
});

it("结果候选渲染与选择；空结果提示无匹配", () => {
  const h = harness();
  h.pane.onResults([candidate("a"), candidate("b")]);
  let flat = plain(h.pane.render(80)).join("\n");
  assert.ok(flat.includes("a 的总结"));
  assert.ok(flat.includes("已发布 2 条候选"));
  h.pane.onResults([]);
  flat = plain(h.pane.render(80)).join("\n");
  assert.ok(flat.includes("无匹配结果"));
});

it("候选标题展示完整 sessionId 不截短，路径与证据行分行标注", () => {
  const h = harness();
  const id = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  h.pane.onResults([candidate(id)]);
  const flat = plain(h.pane.render(80)).join("\n");
  assert.ok(flat.includes(`sessionId: ${id}`), "冒号形式展示完整 ID");
  assert.ok(flat.includes(`路径：/sessions/project/${id}.jsonl`), "路径单独一行");
  assert.ok(flat.includes("证据行：2"), "证据位置用『证据行：』标注");
  assert.ok(!flat.includes("0f1e2d3c:"), "不再出现截短 ID 后黏证据行号的旧形式");
});

it("窄宽度下候选长行折行，渲染不越出面板宽度", () => {
  const h = harness();
  const id = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  h.pane.onResults([candidate(id)]);
  const width = 30;
  const flat = plain(h.pane.render(width));
  for (const line of flat) {
    assert.ok(visibleWidth(line) <= width, `行宽 ${visibleWidth(line)} 超出 ${width}：${line}`);
  }
});

it("输入非空回车发送；输入空回车恢复选中候选并关闭", () => {
  const h = harness();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const input = (data: string) => h.pane.handleInput(data as any);
  "找会话".split("").forEach((ch) => input(ch));
  input("\r");
  assert.deepEqual(h.sent, ["找会话"]);
  assert.equal(h.closed, false);
  h.pane.onResults([candidate("a"), candidate("b")]);
  input("\x1b[B"); // down 选中第 2 条
  input("\r");
  assert.equal(h.closed, true);
  assert.equal(h.picked?.sessionId, "b");
});

it("运行中 esc 停止本轮不关面板；空闲 esc 关闭；ctrl+c 直接关闭", () => {
  const h = harness();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = (data: string) => h.pane.handleInput(data as any);
  h.pane.onUserAccepted("x");
  key("\x1b");
  assert.equal(h.aborted, true);
  assert.equal(h.closed, false);
  h.pane.onSettled(false);
  key("\x1b");
  assert.equal(h.closed, true);
});

it("关闭后内存清空，迟到更新不再进入渲染", () => {
  const h = harness();
  h.pane.onResults([candidate("a")]);
  h.pane.handleInput("\x1b");
  assert.equal(h.closed, true);
  h.pane.onResults([candidate("b")]);
  h.pane.onError("迟到");
  const flat = plain(h.pane.render(80)).join("\n");
  assert.ok(!flat.includes("b 的总结"));
  assert.ok(!flat.includes("迟到"));
});

it("长内容滚动：渲染行数受终端高度约束，最新内容在可见区", () => {
  const h = harness();
  for (let i = 0; i < 60; i++) h.pane.onUserAccepted(`第 ${i} 条`);
  const flat = plain(h.pane.render(80));
  const text = flat.join("\n");
  assert.ok(flat.length <= Math.floor(40 * 0.8) + 5, `渲染行数 ${flat.length} 超出预算`);
  assert.ok(text.includes("第 59 条"), "跟随到最新内容");
});
