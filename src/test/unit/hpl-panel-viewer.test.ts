/**
 * hpl-panel-viewer 单元测试 — panels.ts + config.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  isExpandable, collectExpandables, patternMatches, titleOfLines,
  panelTitle, findNewestPanel,
} from "../../extensions/hpl-panel-viewer/panels.js";
import { applyPopConfig, loadPopConfig } from "../../extensions/hpl-panel-viewer/config.js";
import { config as popConfig } from "../../extensions/hpl-panel-viewer/shared.js";

describe("isExpandable", () => {
  it("有 setExpanded 方法的对象返回 true", () => {
    assert.equal(isExpandable({ setExpanded: () => {} }), true);
  });
  it("普通对象返回 false", () => {
    assert.equal(isExpandable({}), false);
  });
  it("null 返回 false", () => {
    assert.equal(isExpandable(null), false);
  });
});

describe("collectExpandables", () => {
  it("递归收集有 setExpanded 的子组件", () => {
    const tree = {
      children: [
        { setExpanded: () => {}, children: [] },
        { children: [{ setExpanded: () => {} }] },
      ],
    };
    const result = collectExpandables(tree, []);
    assert.equal(result.length, 2);
  });
  it("无 expandable 时返回空", () => {
    assert.deepEqual(collectExpandables({ children: [] }, []), []);
  });
});

describe("patternMatches", () => {
  it("子串匹配忽略大小写", () => {
    assert.equal(patternMatches("bash", "Bash — ls -la"), true);
  });
  it("regex 匹配", () => {
    assert.equal(patternMatches("bash|grep", "grep — pattern"), true);
  });
  it("不匹配返回 false", () => {
    assert.equal(patternMatches("xyz", "bash — ls"), false);
  });
});

describe("titleOfLines", () => {
  it("取第一个非空行，去 ANSI + marker", () => {
    assert.equal(titleOfLines(["\x1b[32m▶ test title\x1b[0m", "  "]), "test title");
  });
  it("全空返回空串", () => {
    assert.equal(titleOfLines(["  ", ""]), "");
  });
});

describe("panelTitle", () => {
  it("渲染面板取标题", () => {
    const comp = { render: () => ["line 1", "line 2"] };
    assert.equal(panelTitle(comp, 80), "line 1");
  });
  it("render 失败 fallback", () => {
    const comp = { render: () => { throw new Error("fail"); } };
    assert.equal(panelTitle(comp, 80), "(panel)");
  });
});

describe("findNewestPanel", () => {
  it("找最新匹配标题的面板", () => {
    const tui = {
      terminal: { columns: 80 },
      children: [
        { setExpanded: () => {}, render: () => ["bash — ls"] },
        { setExpanded: () => {}, render: () => ["grep — error"] },
      ],
    };
    const found = findNewestPanel(tui, "bash");
    assert.ok(found, "找到了面板");
  });
  it("未匹配返回 null", () => {
    const tui = { terminal: { columns: 80 }, children: [] };
    assert.equal(findNewestPanel(tui, "nonexistent"), null);
  });
});

describe("applyPopConfig", () => {
  beforeEach(() => {
    popConfig.include = [];
    popConfig.exclude = [];
    popConfig.maxLines = 5;
  });

  it("show 添加匹配规则", () => {
    const result = applyPopConfig("show", "python3");
    assert.ok(popConfig.include.includes("python3"));
    assert.ok(result.includes("added"));
  });

  it("hide 添加排除规则", () => {
    const result = applyPopConfig("hide", "grep");
    assert.ok(popConfig.exclude.includes("grep"));
    assert.ok(result.includes("removed"));
  });

  it("maxlines 设置行数上限", () => {
    applyPopConfig("maxlines", "3");
    assert.equal(popConfig.maxLines, 3);
  });

  it("maxlines 0 关闭上限", () => {
    applyPopConfig("maxlines", "0");
    assert.equal(popConfig.maxLines, 0);
  });

  it("list 返回配置摘要", () => {
    popConfig.include = ["python3"];
    const result = applyPopConfig("list");
    assert.ok(result.includes("python3"));
    assert.ok(result.includes("hapi-pop config"));
  });

  it("reset 清空规则", () => {
    popConfig.include = ["a"];
    popConfig.exclude = ["b"];
    applyPopConfig("reset");
    assert.deepEqual(popConfig.include, []);
    assert.deepEqual(popConfig.exclude, []);
  });

  it("remove 删除指定规则", () => {
    popConfig.include = ["a", "b"];
    applyPopConfig("remove", "a");
    assert.deepEqual(popConfig.include, ["b"]);
  });

  it("unknown action 返回错误", () => {
    const result = applyPopConfig("invalid_action");
    assert.ok(result.includes("unknown action"));
  });
});
