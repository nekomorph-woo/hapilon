/**
 * content.ts 单元测试 — header 内容构建纯函数
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hapilonLogo,
  drawBox,
  layoutColumns,
  parseExtensionsEnv,
  buildHeaderLines,
  buildLeftColumn,
  buildRightColumn,
  centerLines,
  type HeaderData,
} from "../../extensions/hpl-startup-header/content.js";

describe("hapilonLogo()", () => {
  it("返回 4 行 ASCII art", () => {
    const logo = hapilonLogo();
    assert.strictEqual(logo.length, 4);
  });

  it("每行非空", () => {
    for (const line of hapilonLogo()) {
      assert.ok(line.length > 0, "每行不应为空字符串");
    }
  });
});

describe("drawBox()", () => {
  it("width < 3 → 返回空数组（防崩溃）", () => {
    assert.deepStrictEqual(drawBox(["x"], 0), []);
    assert.deepStrictEqual(drawBox(["x"], 1), []);
    assert.deepStrictEqual(drawBox(["x"], 2), []);
  });

  it("边框结构完整：顶边 + 内容 + 底边", () => {
    const lines = ["hello", "world"];
    const box = drawBox(lines, 20, "Test");
    assert.ok(box[0].startsWith("╭"), `顶边应以 ╭ 开头，实际: ${box[0]}`);
    assert.ok(box[0].endsWith("╮"), `顶边应以 ╮ 结尾`);
    assert.ok(box[box.length - 1].startsWith("╰"), "底边应以 ╰ 开头");
    assert.ok(box[box.length - 1].endsWith("╯"), "底边应以 ╯ 结尾");
  });

  it("边框行数 = 内容行数 + 2", () => {
    const lines = ["a", "b", "c"];
    assert.strictEqual(drawBox(lines, 30).length, 5);
  });

  it("空内容也能正常渲染", () => {
    const box = drawBox([], 10);
    assert.strictEqual(box.length, 2, "空内容应只有顶边+底边");
  });

  it("带标题时标题左对齐出现在顶边", () => {
    const box = drawBox(["x"], 40, "─── My Title");
    assert.ok(box[0].startsWith("╭─── My Title"), "标题应左对齐");
    assert.ok(box[0].endsWith("╮"), "应以 ╮ 结尾");
  });

  it("内容超出宽度时截断而不是换行", () => {
    const longLine = "x".repeat(50);
    const box = drawBox([longLine], 10);
    const contentLine = box[1]; // 第一行内容
    const innerWidth = contentLine.length - 2; // 去掉 │ │
    assert.ok(innerWidth <= 8, `内宽 ${innerWidth} 应 <= 8 (10-2=8)`);
  });
});

describe("layoutColumns()", () => {
  it("width >= 80: 双栏布局", () => {
    const left = ["L1", "L2"];
    const right = ["R1", "R2"];
    const result = layoutColumns(left, right, 80);
    // 每行应包含 │ 分隔符，但不是顶部/底部边框
    for (const line of result) {
      assert.ok(line.includes("│"), "双栏应包含竖向分隔符");
    }
  });

  it("width < 80: 单栏堆叠", () => {
    const left = ["L1"];
    const right = ["R1"];
    const result = layoutColumns(left, right, 40);
    // 单栏模式下应有分隔线
    const hasSeparator = result.some((l) => l.includes("──"));
    assert.ok(hasSeparator, "单栏应有分隔线");
    assert.ok(result.some((l) => l.includes("L1")), "应包含左栏内容");
    assert.ok(result.some((l) => l.includes("R1")), "应包含右栏内容");
  });

  it("右侧行更多时左栏补空行对齐", () => {
    const left = ["L1"];
    const right = ["R1", "R2", "R3"];
    const result = layoutColumns(left, right, 80);
    assert.strictEqual(result.length, 3, "行数 = max(1, 3) = 3");
  });

  it("左侧行更多时右栏补空", () => {
    const left = ["L1", "L2", "L3"];
    const right = ["R1"];
    const result = layoutColumns(left, right, 80);
    assert.strictEqual(result.length, 3, "行数 = max(3, 1) = 3");
  });
});

describe("parseExtensionsEnv()", () => {
  it("undefined → undefined", () => {
    assert.strictEqual(parseExtensionsEnv(undefined), undefined);
  });

  it('有效 JSON 数组 → string[]', () => {
    const result = parseExtensionsEnv(JSON.stringify(["a", "b", "c"]));
    assert.deepStrictEqual(result, ["a", "b", "c"]);
  });

  it("非法 JSON → warn + undefined", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const result = parseExtensionsEnv("bad json");
      assert.strictEqual(result, undefined);
      assert.ok(warnings.length > 0, "应打印警告");
    } finally {
      console.warn = orig;
    }
  });

  it("非数组 JSON → warn + undefined", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const result = parseExtensionsEnv(JSON.stringify({ not: "array" }));
      assert.strictEqual(result, undefined);
      assert.ok(warnings.length > 0, "应打印警告");
    } finally {
      console.warn = orig;
    }
  });
});

describe("drawBox edge cases", () => {
  it("标题恰好等于内宽时不越界", () => {
    // width=10 → innerW=8, title "Test" → titleStr " Test " = 6 chars → remain=2 > 0
    const box = drawBox(["x"], 12, "LongTitle");
    assert.ok(box[0].startsWith("╭"));
    assert.ok(box[0].endsWith("╮"));
  });

  it("标题超出内宽时安全截断", () => {
    const box = drawBox(["x"], 10, "VeryLongTitleThatExceeds");
    const top = box[0];
    // innerW = 8, top should be 10 chars (╭ + 8 content + ╮)
    assert.ok(top.length <= 10, `顶边长度 ${top.length} 应 <= 10`);
    assert.ok(top.endsWith("╮"), "应以 ╮ 结尾");
  });
});

describe("layoutColumns edge cases", () => {
  it("width < 3 → 返回空数组（防 RangeError）", () => {
    assert.deepStrictEqual(layoutColumns(["L"], ["R"], 0), []);
    assert.deepStrictEqual(layoutColumns(["L"], ["R"], 1), []);
  });

  it("右栏为空时不添加分隔线", () => {
    const result = layoutColumns(["L1"], [], 40);
    assert.deepStrictEqual(result, ["L1"]);
  });

  it("左栏为空时仍在窄模式下正确输出右栏", () => {
    const result = layoutColumns([], ["R1"], 40);
    // 窄模式：空左栏 + 分隔线 + 右栏
    assert.ok(result.some((l) => l.includes("R1")), "应包含右栏内容");
    assert.ok(result.some((l) => l.includes("──")), "应有分隔线");
  });
});

describe("centerLines()", () => {
  it("短文本在宽列中居中", () => {
    const result = centerLines(["hi"], 10);
    assert.strictEqual(result[0].length, 4); // left-padded to center
    assert.ok(result[0].startsWith(" "), "左边有空格");
  });

  it("超长文本不截断", () => {
    const result = centerLines(["very long text here"], 5);
    assert.strictEqual(result[0], "very long text here");
  });

  it("空字符串对齐", () => {
    const result = centerLines([""], 10);
    assert.strictEqual(result[0], "          "); // 10 spaces
  });
});

describe("buildLeftColumn()", () => {
  const base: HeaderData = {
    version: "0.1.0",
    modelProvider: "zai",
    modelName: "glm-5",
    cwd: "/tmp",
    extensions: undefined,
    piUpdate: undefined,
  };

  it("有 model → 含 provider·model 行", () => {
    const lines = buildLeftColumn(base);
    const text = lines.join("\n");
    assert.ok(text.includes("zai · glm-5"), "应包含模型信息");
  });

  it("无 model → 显示 no model selected", () => {
    const lines = buildLeftColumn({ ...base, modelProvider: undefined, modelName: undefined });
    const text = lines.join("\n");
    assert.ok(text.includes("no model selected"), "应提示无模型");
  });
});

describe("buildRightColumn()", () => {
  const base: HeaderData = {
    version: "0.1.0",
    modelProvider: "zai",
    modelName: "glm-5",
    cwd: "/tmp",
    extensions: ["ext-a", "ext-b"],
    piUpdate: "0.81.0",
  };

  it("collapsed → 显示 Tips + 扩展计数 + 分隔线 + update + help", () => {
    const lines = buildRightColumn(base, false);
    const text = lines.join("\n");
    assert.ok(text.includes("Tips for getting started"), "含 Tips 标题");
    assert.ok(text.includes("2 extensions loaded"), "含扩展计数");
    assert.ok(text.includes("──"), "含分隔线");
    assert.ok(text.includes("0.81.0 available"), "含更新提示");
    assert.ok(text.includes("ctrl+o for more"), "含帮助提示");
  });

  it("expanded → 显示完整扩展列表 + 快捷键", () => {
    const lines = buildRightColumn(base, true);
    const text = lines.join("\n");
    assert.ok(text.includes("  ext-a"), "应列出扩展名");
    assert.ok(text.includes("  ext-b"), "应列出扩展名");
    assert.ok(text.includes("esc"), "应包含快捷键");
  });

  it("无 piUpdate 时显示 up to date", () => {
    const lines = buildRightColumn({ ...base, piUpdate: undefined }, false);
    const text = lines.join("\n");
    assert.ok(text.includes("up to date"), "应显示最新");
  });

  it("无 extensions → 不显示扩展段", () => {
    const lines = buildRightColumn({ ...base, extensions: undefined }, false);
    const text = lines.join("\n");
    assert.ok(!text.includes("Extensions"), "不应有扩展信息");
  });

  it("无 piUpdate → 不显示更新段", () => {
    const lines = buildRightColumn({ ...base, piUpdate: undefined }, false);
    const text = lines.join("\n");
    assert.ok(!text.includes("is available"), "不应有更新信息");
  });

  it("expanded → 含快捷键列表", () => {
    const normal = buildRightColumn(base, false);
    const expanded = buildRightColumn(base, true);
    assert.ok(expanded.length > normal.length, "expanded 应更长");
    assert.ok(expanded.some((l) => l.includes("esc")), "应包含快捷键");
  });
});

describe("buildHeaderLines()", () => {
  const baseData: HeaderData = {
    version: "0.1.0-alpha",
    modelProvider: "zai",
    modelName: "glm-5-turbo",
    cwd: "/Volumes/Under_M2/morphiiouo/hapilon",
    extensions: ["hpl-context", "hpl-footer", "hpl-panel-viewer"],
    piUpdate: "0.80.10",
  };

  it("正常路径: 完整数据 → 产生多行输出", () => {
    const lines = buildHeaderLines(baseData, false);
    assert.ok(lines.length > 5, "至少 6 行");
    const text = lines.join("\n");
    assert.ok(text.includes("Welcome back!"), "包含欢迎语");
    assert.ok(text.includes("zai"), "包含 provider");
    assert.ok(text.includes("glm-5-turbo"), "包含模型名");
    assert.ok(text.includes(baseData.cwd), "包含 workspace 路径");
    assert.ok(text.includes("3 extensions loaded"), "包含扩展计数");
    assert.ok(text.includes("──"), "含分隔线");
  });

  it("无 model 时显示 no model selected", () => {
    const lines = buildHeaderLines({ ...baseData, modelProvider: undefined, modelName: undefined }, false);
    const text = lines.join("\n");
    assert.ok(text.includes("no model"), "应显示无模型提示");
  });

  it("无 extensions env → Tips 行仍存在但不含计数", () => {
    const lines = buildHeaderLines({ ...baseData, extensions: undefined }, false);
    const text = lines.join("\n");
    assert.ok(text.includes("Tips for getting started"), "Tips 应存在");
    assert.ok(!text.includes("extensions loaded"), "不应有计数");
  });

  it("无 piUpdate → 不显示更新行", () => {
    const lines = buildHeaderLines({ ...baseData, piUpdate: undefined }, false);
    const text = lines.join("\n");
    assert.ok(!text.includes("is available"), "不应有更新提示");
  });

  it("expanded 模式含更多快捷键文本", () => {
    const normal = buildHeaderLines(baseData, false);
    const expanded = buildHeaderLines(baseData, true);
    const normalText = normal.join("\n");
    const expandedText = expanded.join("\n");
    assert.ok(expandedText.length > normalText.length, "expanded 应更长");
    assert.ok(
      expandedText.includes("ctrl+") || expandedText.includes("/") || expandedText.includes("!"),
      "expanded 应包含快捷键提示",
    );
  });

  it("无版本 env → 内容正常构建（标题不含版本号）", () => {
    const lines = buildHeaderLines({ ...baseData, version: undefined }, false);
    const text = lines.join("\n");
    assert.ok(!text.includes("0.1.0"), "内容不应含版本号（标题由 drawBox 添加）");
    assert.ok(text.includes("Welcome back!"), "仍应有欢迎语");
  });
});
