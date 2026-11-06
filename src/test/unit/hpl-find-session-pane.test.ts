/**
 * hpl-find-session/pane.ts 单元测试：渲染布局、跨天/跨年时间、两行省略、
 * 选择滚动、宽高预算（index.ts overlay maxHeight 80%）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { FindSessionPane } from "../../extensions/hpl-find-session/pane.js";
import type { RankedEntry } from "../../extensions/hpl-find-session/rank.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTheme: any = {
  fg: (_name: string, text: string) => `\x1b[38;5;7m${text}\x1b[39m`,
  bg: (_name: string, text: string) => `\x1b[48;5;8m${text}\x1b[49m`,
};

function plain(line: string): string {
  return stripTerminalSequences(line).replace(/[│╭╮╰╯─]/g, "").trim();
}

function makePane(entriesAfterSearch: RankedEntry[] = [], status = "", rows = 40) {
  const calls: string[] = [];
  const state = { picked: null as RankedEntry | null, closed: false };
  const pane = new FindSessionPane(
    { terminal: { rows }, requestRender() {} },
    mockTheme,
    null,
    () => { state.closed = true; },
    {
      onSearch: (query) => calls.push(query),
      onPick: (entry) => { state.picked = entry; },
    },
  );
  pane.setResults(entriesAfterSearch, status);
  return { pane, calls, state };
}

function ranked(i: number, created: string, modified: string, summary: string): RankedEntry {
  return {
    entry: {
      path: `/tmp/s${i}.jsonl`,
      id: `id-${i}`,
      cwd: "/proj",
      name: "",
      created,
      modified,
      messageCount: 3,
      firstUser: summary,
      lastUser: "",
      sizeBytes: 10,
    },
    summary,
  };
}

describe("FindSessionPane 列表态", () => {
  it("每条固定 4 行：时间行 + 2 行摘要 + 1 行空隔", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      ranked(i, `2026-11-01T10:${String(i).padStart(2, "0")}:00Z`, `2026-11-01T11:00:00Z`, `摘要 ${i}`));
    const { pane } = makePane(entries);
    const lines = pane.render(80).slice(1, -3).map(plain);
    for (let i = 0; i < 5; i++) {
      const line = lines[i * 4]!;
      assert.ok(line.includes(`创建 11-01 10:${String(i).padStart(2, "0")}`), `第 ${i} 条时间行: ${line}`);
      assert.ok(line.includes("最后活动"), "时间行带显式标签");
    }
    assert.ok(lines[1]!.includes("摘要 0"));
    assert.equal(lines[2]!, "", "摘要不足 2 行时第二槽位为空");
    assert.equal(lines[3]!, "", "条目间固定一行空隔");
  });

  it("跨日最后活动保留日期，同日只显时刻；跨年两侧都带年份", () => {
    const entries = [
      ranked(0, "2026-11-01T10:00:00Z", "2026-11-01T23:30:00Z", "同日"),
      ranked(1, "2026-11-01T10:00:00Z", "2026-11-02T05:30:00Z", "跨日"),
      ranked(2, "2025-12-30T10:00:00Z", "2026-01-02T05:30:00Z", "跨年"),
    ];
    const { pane } = makePane(entries);
    const lines = pane.render(100).slice(1, -3).map(plain);
    assert.ok(lines[0]!.includes("创建 11-01 10:00 · 最后活动 11-01 23:30"));
    assert.ok(lines[4]!.includes("创建 11-01 10:00 · 最后活动 11-02 05:30"));
    assert.ok(lines[8]!.includes("创建 2025-12-30 10:00 · 最后活动 2026-01-02 05:30"));
  });

  it("完整 summary 折行显示，三句超两行时第二句保留、第二摘要行末尾以 … 省略", () => {
    const s1 = "第一句话讲背景情况，交代了整个会话的来龙去脉和上下文脉络以及涉及的项目范围。";
    const s2 = "第二句话补充了大量细节内容，需要占据足够多的宽度把前两行的显示空间全部填满不留空隙。";
    const s3 = "第三句话是被省略的结尾，不应该出现在渲染结果里。";
    const { pane } = makePane([ranked(0, "2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", s1 + s2 + s3)]);
    const lines = pane.render(80).slice(1, -3).map(plain);
    const joined = lines.join("\n");
    assert.ok(joined.includes("第一句话"), "首句显示");
    assert.ok(joined.includes("第二句话"), "非首句内容保留");
    assert.ok(!joined.includes("第三句话"), "尾句被省略");
    assert.ok(lines[2]!.endsWith("…"), `第二摘要行末尾有省略号: ${JSON.stringify(lines[2])}`);
    assert.ok(!lines[0]!.endsWith("…"), "时间行不受摘要省略影响");
  });

  it("长 ASCII 恰好占满第二摘要行时仍有省略号（回归：满行丢字不出…）", () => {
    const { pane } = makePane([ranked(0, "2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", "a".repeat(200))]);
    const lines = pane.render(80).slice(1, -3).map(plain);
    assert.equal(plain(lines[1])!.replace(/…$/, "").length, 75, "第一摘要行占满 textW");
    assert.ok(lines[2]!.endsWith("…"), `满行末尾仍有省略号: ${JSON.stringify(lines[2])}`);
    assert.ok(lines[2]!.replace(/…$/, "").length === 74, "预留省略号宽度后截断");
  });

  it("中文偶数列恰好占满第二摘要行时仍有省略号", () => {
    const { pane } = makePane([ranked(0, "2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", "甲".repeat(120))]);
    const lines = pane.render(80).slice(1, -3).map(plain);
    assert.equal([...plain(lines[1])!].length, 37, "第一摘要行 37 个汉字占满可用宽度");
    assert.ok(lines[2]!.endsWith("…"), `中文满行末尾有省略号: ${JSON.stringify(lines[2])}`);
    assert.equal([...lines[2]!.replace(/…$/, "")].length, 37);
  });

  it("窄终端 20/40/80 列 × 12/24 行高：行宽与总行数都不超限，末选完整可见", () => {
    const long = "很长的中文内容摘要会话讨论".repeat(6) + " long english content ".repeat(4);
    const entries = Array.from({ length: 15 }, (_, i) =>
      ranked(i, `2026-11-01T10:${String(i).padStart(2, "0")}:00Z`, `2026-11-01T10:${String(i).padStart(2, "0")}:00Z`, long));
    for (const width of [20, 40, 80]) {
      for (const rows of [12, 24, 40]) {
        const { pane } = makePane(entries, "排序完成", rows);
        for (let i = 0; i < 14; i++) pane.handleInput("j");
        const out = pane.render(width);
        const budget = Math.floor(rows * 0.8);
        assert.ok(out.length <= budget, `${width}列${rows}行: 总行数 ${out.length} > ${budget}`);
        for (const line of out) {
          assert.ok(visibleWidth(stripTerminalSequences(line)) <= width,
            `${width}列: 行宽 ${visibleWidth(stripTerminalSequences(line))} > ${width}`);
        }
        const joined = out.map(plain).join("\n");
        if (width >= 40) {
          assert.ok(joined.includes("10:14"), `${width}列${rows}行: 末选时间行可见`);
        }
        assert.ok(joined.includes("排序完成") || rows < 8, `${width}列${rows}行: 状态行可见`);
        assert.ok(joined.includes("esc"), `${width}列${rows}行: esc 快捷键可见`);
        assert.ok(joined.includes("15/15"), `${width}列${rows}行: 位置指示可见`);
      }
    }
  });

  it("选择滚动后首条滚出，末条两行摘要完整", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      ranked(i, `2026-11-01T10:${String(i).padStart(2, "0")}:00Z`, `2026-11-01T10:${String(i).padStart(2, "0")}:00Z`, `摘要内容 ${i} 甲乙丙丁`));
    const { pane } = makePane(entries);
    for (let i = 0; i < 14; i++) pane.handleInput("j");
    const joined = pane.render(80).map(plain).join("\n");
    assert.ok(joined.includes("创建 11-01 10:14"), "首条时间行已滚出检查");
    assert.ok(!joined.includes("10:00 ·"), "第一条时间行不在窗口内");
    assert.ok(joined.includes("摘要内容 14"), "末条摘要第一行");
    assert.ok(joined.includes("甲乙丙丁"), "末条摘要第二行");
  });

  it("标题为中文找回会话且带查询；底部状态行与快捷键行分开固定", () => {
    const entries = [ranked(0, "2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", "摘要")];
    const { pane } = makePane(entries, "排序完成");
    pane.handleInput("e");
    for (const ch of "发版脚本") pane.handleInput(ch);
    pane.handleInput("\r");
    pane.setResults(entries, "排序完成");
    const out = pane.render(80);
    assert.ok(plain(out[0]!).includes("找回会话"), plain(out[0]!));
    assert.ok(plain(out[0]!).includes("发版脚本"));
    // 状态行/快捷键行在闭合底边框之前，面板内倒数第 2、3 行
    const bottom = out[out.length - 1]!;
    assert.ok(bottom.includes("╰"), "最后一行是闭合底边框");
    assert.ok(plain(out[out.length - 3]!).includes("排序完成"), "状态行在底边框之前");
    assert.ok(plain(out[out.length - 2]!).includes("esc 退出"), "快捷键行在状态行之后、底边框之前");
  });

  it("无结果回到输入态，状态文本进提示行不伪造统计", () => {
    const { pane } = makePane([], "没有匹配的会话");
    assert.equal(pane.mode, "input");
    const out = pane.render(80);
    assert.ok(out.some((l) => plain(l).includes("没有匹配的会话")));
    assert.ok(out.some((l) => plain(l).includes("回车搜索")));
  });

  it("极短高度（rows=5）：总行数不超预算且不炸", () => {
    const entries = [ranked(0, "2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", "摘要")];
    const { pane } = makePane(entries, "", 5);
    const out = pane.render(80);
    assert.ok(out.length <= Math.floor(5 * 0.8));
    assert.ok(out.length >= 2);
  });

  it("窄列 20：时间行被截断而不折行，条目仍各占 4 行", () => {
    const entries = [
      ranked(0, "2026-11-01T10:00:00Z", "2026-11-02T05:30:00Z", "甲"),
      ranked(1, "2026-11-01T10:01:00Z", "2026-11-02T05:31:00Z", "乙"),
    ];
    const { pane } = makePane(entries);
    const lines = pane.render(20).slice(1, -3).map(plain);
    assert.ok(lines[0]!.includes("创建") && lines[0]!.includes("…"), `窄列时间行截断: ${lines[0]}`);
    assert.equal(lines[3]!, "", "条目间仍有固定空隔");
    assert.ok(lines[4]!.includes("创建"), "第二条时间行仍在第 5 行");
  });
});

describe("FindSessionPane 输入与恢复", () => {
  it("初始 query 直接进搜索态并回调 onSearch", () => {
    const calls: string[] = [];
    const pane = new FindSessionPane(
      { terminal: { rows: 40 }, requestRender() {} },
      mockTheme,
      null,
      () => {},
      { onSearch: (q) => calls.push(q), onPick: () => {} },
      "发版脚本",
    );
    assert.equal(pane.mode, "searching");
    assert.deepEqual(calls, ["发版脚本"]);
    pane.setResults([], "");
  });

  it("列表态 e 回输入态，输入后回车再次回调 onSearch", () => {
    const entries = [ranked(0, "2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", "摘要")];
    const { pane, calls } = makePane(entries);
    pane.handleInput("e");
    assert.equal(pane.mode, "input");
    for (const ch of "查询") pane.handleInput(ch);
    pane.handleInput("\r");
    assert.equal(pane.mode, "searching");
    assert.equal(calls.length, 1);
  });

  it("粘贴整段进入 query，换行压成空格", () => {
    const { pane } = makePane([]);
    pane.handleInput("\x1b[200~第一行\n第二行\x1b[201~");
    const out = pane.render(80);
    assert.ok(out.some((l) => plain(l).includes("第一行 第二行")));
  });

  it("列表态回车关闭面板并回调 onPick", () => {
    const entries = [ranked(0, "2026-11-01T10:00:00Z", "2026-11-01T10:00:00Z", "摘要")];
    const { pane, state } = makePane(entries);
    pane.handleInput("\r");
    assert.equal(state.closed, true);
    assert.equal(state.picked?.entry.id, "id-0");
  });
});
