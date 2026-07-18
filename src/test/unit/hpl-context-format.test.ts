/**
 * hpl-context format.ts 单元测试 — XML 格式化纯函数
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatHapilonMd, formatRules } from "../../extensions/hpl-context/format.js";

describe("formatHapilonMd", () => {
  it("正常路径: 单个文件包裹在 XML block 中", () => {
    assert.equal(
      formatHapilonMd([{ path: "/home/.hapilon/HAPILON.md", content: "# Hello" }]),
      "<hapilon_instructions>\n\n# Hello\n\n</hapilon_instructions>",
    );
  });

  it("正常路径: 多个文件内容拼接，祖先级在前", () => {
    const result = formatHapilonMd([
      { path: "/root/.hapilon/HAPILON.md", content: "root" },
      { path: "/root/a/.hapilon/HAPILON.md", content: "child" },
    ]);
    assert.ok(result.indexOf("root") < result.indexOf("child"), "祖先级内容应在深层之前");
    assert.equal(result, "<hapilon_instructions>\n\nroot\n\nchild\n\n</hapilon_instructions>");
  });

  it("边界条件: 空输入返回空字符串", () => {
    assert.equal(formatHapilonMd([]), "");
  });

  it("异常路径: 空内容的文件仍参与格式化", () => {
    assert.equal(
      formatHapilonMd([{ path: "/empty.md", content: "" }]),
      "<hapilon_instructions>\n\n\n\n</hapilon_instructions>",
    );
  });

  it("异常路径: 内容含 XML 特殊字符被转义，不破坏结构", () => {
    assert.equal(
      formatHapilonMd([{ path: "/x.md", content: "A & B < C > D" }]),
      "<hapilon_instructions>\n\nA &amp; B &lt; C &gt; D\n\n</hapilon_instructions>",
    );
    // 内容含 </hapilon_instructions> 不会提前闭合外层标签
    const inner = formatHapilonMd([{ path: "/x.md", content: "before </hapilon_instructions> after" }]);
    assert.ok(inner.includes("&lt;/hapilon_instructions&gt;"), "标签闭合符应被转义");
    assert.equal((inner.match(/<\/hapilon_instructions>/g) ?? []).length, 1, "外层标签仅闭合一次");
  });
});

describe("formatRules", () => {
  it("正常路径: 单条规则包裹在 <rule> 标签中", () => {
    assert.equal(
      formatRules([{ name: "git-rules", content: "Always commit before push." }]),
      "<hapilon_rules>\n\n<rule name=\"git-rules\">\nAlways commit before push.\n</rule>\n\n</hapilon_rules>",
    );
  });

  it("正常路径: 多条规则各自含 name 属性", () => {
    const result = formatRules([
      { name: "a", content: "first" },
      { name: "b", content: "second" },
    ]);
    assert.ok(result.indexOf('<rule name="a">') < result.indexOf('<rule name="b">'), "保持输入顺序");
    assert.equal(
      result,
      "<hapilon_rules>\n\n<rule name=\"a\">\nfirst\n</rule>\n\n<rule name=\"b\">\nsecond\n</rule>\n\n</hapilon_rules>",
    );
  });

  it("边界条件: 空输入返回空字符串", () => {
    assert.equal(formatRules([]), "");
  });

  it("异常路径: name 含 XML 特殊字符被转义", () => {
    const result = formatRules([{ name: 'test"rule', content: "body" }]);
    assert.ok(result.includes('name="test&quot;rule"'), "双引号应被转义");
    assert.ok(!result.includes('name="test"rule"'), "原始双引号不应出现在属性值中");
  });

  it("异常路径: content 含 </rule> 不破坏外层结构", () => {
    const result = formatRules([{ name: "r", content: "text </rule> more" }]);
    assert.ok(result.includes("&lt;/rule&gt;"), "</rule> 应被转义");
    assert.equal((result.match(/<\/rule>/g) ?? []).length, 1, "外层 </rule> 仅一次");
  });
});
