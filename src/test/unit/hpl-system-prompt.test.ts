/**
 * hpl-system-prompt 单元测试 — XML 组装逻辑
 *
 * 覆盖 shared/format.ts (xmlEscape) + xml.ts (wrapSystemPrompt)
 * + sections.ts (文本常量) + assemble.ts (各 section builder)
 * + index.ts (before_agent_start handler 注册与降级路径)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { xmlEscape } from "../../shared/format.js";
import { wrapSystemPrompt } from "../../extensions/hpl-system-prompt/xml.js";
import {
  ROLE_TEXT,
  CUSTOM_TOOLS_NOTE,
  buildPiDocText,
  BUILTIN_GUIDELINES,
} from "../../extensions/hpl-system-prompt/sections.js";
import {
  buildRoleSection,
  buildToolsSection,
  buildCustomToolsNote,
  buildGuidelinesSection,
  buildPiDocSection,
  buildHapilonInstructions,
  buildHapilonRules,
  buildContextSection,
  buildSkillsSection,
  buildAppendSection,
  buildEnvironmentSection,
  assembleSystemPrompt,
  collectHapilonContext,
  type AssembleOptions,
} from "../../extensions/hpl-system-prompt/assemble.js";
import hplSystemPrompt from "../../extensions/hpl-system-prompt/index.js";
import { getLastMeta as getSpMeta, clearLastMeta as clearSpMeta } from "../../extensions/hpl-system-prompt/metadata.js";

// ── shared/format.ts: xmlEscape ────────────────────────────────────────

describe("xmlEscape", () => {
  it("正常路径: 纯文本不转义", () => {
    assert.equal(xmlEscape("hello world"), "hello world");
  });

  it("正常路径: & 转义为 &amp;", () => {
    assert.equal(xmlEscape("A & B"), "A &amp; B");
  });

  it("边界条件: < > \" 全部转义", () => {
    assert.equal(xmlEscape('<tag attr="val">'), "&lt;tag attr=&quot;val&quot;&gt;");
  });

  it("边界条件: 空字符串", () => {
    assert.equal(xmlEscape(""), "");
  });

  it("异常路径: 多重特殊字符", () => {
    assert.equal(xmlEscape("a && b << c"), "a &amp;&amp; b &lt;&lt; c");
  });
});

// ── xml.ts: wrapSystemPrompt ──────────────────────────────────────────

describe("wrapSystemPrompt", () => {
  it("正常路径: 包裹多个 section 为完整 XML", () => {
    const result = wrapSystemPrompt([
      "<role>test-role</role>",
      "<available_tools>\n- read: Read\n</available_tools>",
      "<environment>\ncwd: /test\n</environment>",
    ]);
    assert.ok(result.startsWith("<system_prompt>"), "以 system_prompt 标签开始");
    assert.ok(result.endsWith("</system_prompt>\n"), "以 system_prompt 标签结束");
    assert.ok(result.includes("<role>test-role</role>"), "包含 role section");
    assert.ok(result.includes("<available_tools>"), "包含 tools section");
    assert.ok(result.includes("<environment>"), "包含 environment section");
  });

  it("边界条件: 空 section 数组", () => {
    const result = wrapSystemPrompt([]);
    assert.equal(result, "<system_prompt>\n</system_prompt>\n");
  });

  it("边界条件: 单个 section", () => {
    const result = wrapSystemPrompt(["<role>only</role>"]);
    assert.equal(result, "<system_prompt>\n<role>only</role>\n</system_prompt>\n");
  });

  it("边界条件: 空字符串 section 被过滤，不产生多余空行", () => {
    const result = wrapSystemPrompt(["", "<role>x</role>", ""]);
    assert.equal(result, "<system_prompt>\n<role>x</role>\n</system_prompt>\n");
  });

  it("异常路径: section 内容含已转义字符不破坏结构", () => {
    const result = wrapSystemPrompt(["<role>safe &amp; content</role>"]);
    assert.equal((result.match(/<system_prompt>/g) ?? []).length, 1);
    assert.equal((result.match(/<\/system_prompt>/g) ?? []).length, 1);
  });
});

// ── sections.ts ────────────────────────────────────────────────────────

describe("sections", () => {
  it("ROLE_TEXT 包含 hapilon 品牌标识", () => {
    assert.ok(ROLE_TEXT.includes("Hapilon"), "包含 Hapilon");
    assert.ok(ROLE_TEXT.includes('"hapi"'), '包含 "hapi" 别名');
    assert.ok(ROLE_TEXT.length > 50, "非空且有意义");
  });

  it("CUSTOM_TOOLS_NOTE 非空", () => {
    assert.ok(CUSTOM_TOOLS_NOTE.length > 20);
  });

  it("buildPiDocText 包含 hapilon 路径体系与 Pi 文档绝对路径", () => {
    const text = buildPiDocText();
    assert.ok(text.includes(".hapilon"), "引用 .hapilon 而非 .pi");
    assert.ok(text.includes("extensions"), "提及 extensions 路径");
    // 动态路径：getReadmePath/getDocsPath 返回绝对路径
    assert.ok(text.includes("Main documentation: /"), "包含 README 绝对路径");
    assert.ok(text.includes("Additional docs: /"), "包含 docs 绝对路径");
  });

  it("BUILTIN_GUIDELINES 包含 3 条内建准则", () => {
    assert.ok(BUILTIN_GUIDELINES.beConcise.length > 0);
    assert.ok(BUILTIN_GUIDELINES.showFilePaths.length > 0);
    assert.ok(BUILTIN_GUIDELINES.bashOnlyFileOps.length > 0);
  });
});

// ── assemble.ts: individual builders ──────────────────────────────────

describe("buildRoleSection", () => {
  it("正常路径: 包裹 ROLE_TEXT 于 <role> 标签", () => {
    const result = buildRoleSection();
    assert.ok(result.startsWith("<role>"), "以 <role> 开始");
    assert.ok(result.endsWith("</role>"), "以 </role> 结束");
    assert.ok(result.includes("Hapilon"), "包含 Hapilon 标识");
    assert.ok(result.includes('"hapi"'), '包含 "hapi" 别名');
  });
});

describe("buildToolsSection", () => {
  const snippets = {
    read: "Read file contents",
    bash: "Execute bash commands",
  };

  it("正常路径: 动态生成工具列表", () => {
    const result = buildToolsSection(snippets, ["read", "bash"]);
    assert.ok(result.startsWith("<available_tools>"));
    assert.ok(result.includes("- read: Read file contents"));
    assert.ok(result.includes("- bash: Execute bash commands"));
    assert.ok(result.endsWith("</available_tools>"));
  });

  it("边界条件: 空 toolSnippets 输出 (none) 占位", () => {
    const result = buildToolsSection({}, []);
    assert.ok(result.includes("<available_tools>"));
    assert.ok(result.includes("(none)"), "空列表应显示 (none) 占位符");
    assert.ok(result.includes("</available_tools>"));
  });

  it("边界条件: 过滤 selectedTools 之外的 snippet", () => {
    const result = buildToolsSection(snippets, ["read"]); // 仅 read
    assert.ok(result.includes("read"));
    assert.ok(!result.includes("bash"), "bash 不在 selectedTools 中，应被过滤");
  });
});

describe("buildCustomToolsNote", () => {
  it("正常路径: 包裹 CUSTOM_TOOLS_NOTE", () => {
    const result = buildCustomToolsNote();
    assert.ok(result.startsWith("<custom_tools_note>"));
    assert.ok(result.endsWith("</custom_tools_note>"));
  });
});

describe("buildGuidelinesSection", () => {
  it("正常路径: 组合工具级和内建 guidelines", () => {
    const result = buildGuidelinesSection(
      ["Use read to examine files instead of cat or sed."],
      ["read", "bash", "edit", "write"],
    );
    assert.ok(result.startsWith("<guidelines>"));
    assert.ok(result.endsWith("</guidelines>"));
    assert.ok(result.includes("Use read to examine files"));
    assert.ok(result.includes("Be concise in your responses"));
    assert.ok(result.includes("Show file paths clearly"));
  });

  it("正常路径: 重复与空白 guideline 被去重和过滤", () => {
    const result = buildGuidelinesSection(
      ["Be concise in your responses", "  Be concise in your responses  ", ""],
      ["read"],
    );
    assert.equal(
      (result.match(/Be concise in your responses/g) ?? []).length,
      1,
      "重复条目仅出现一次",
    );
  });

  it("正常路径: bash 启用但 grep/find/ls 未启用时追加 bashOnlyFileOps", () => {
    const result = buildGuidelinesSection([], ["bash"]);
    assert.ok(result.includes("Use bash for file operations"));
  });

  it("边界条件: grep/find/ls 全启用时不追加 bashOnlyFileOps", () => {
    const result = buildGuidelinesSection([], ["bash", "grep", "find", "ls"]);
    assert.ok(!result.includes("Use bash for file operations"));
  });

  it("边界条件: 仅 grep 与 bash 启用时不追加 bashOnlyFileOps", () => {
    const result = buildGuidelinesSection([], ["bash", "grep"]);
    assert.ok(!result.includes("Use bash for file operations"), "部分启用同样不追加");
  });

  it("边界条件: 空 promptGuidelines 仅输出内建准则", () => {
    const result = buildGuidelinesSection([], ["read"]);
    assert.ok(result.includes("Be concise in your responses"));
    assert.ok(result.includes("Show file paths clearly"));
  });
});

describe("buildPiDocSection", () => {
  it("正常路径: 包裹 buildPiDocText 内容", () => {
    const result = buildPiDocSection();
    assert.ok(result.startsWith("<pi_documentation>"));
    assert.ok(result.endsWith("</pi_documentation>"));
    assert.ok(result.includes(".hapilon"), "包含 hapilon 路径");
  });
});

describe("buildHapilonInstructions", () => {
  it("正常路径: 正文 XML 转义，防止 < 破坏 XML 结构", () => {
    const result = buildHapilonInstructions([
      { path: "/x.md", content: "Use Array<string> & generics" },
    ]);
    assert.ok(result.includes("Use Array&lt;string&gt; &amp; generics"), "正文 < > & 转义");
    assert.ok(!result.includes("Use Array<string>"), "原样尖括号不出现");
  });

  it("异常路径: 正文含 </hapilon_instructions> 字面量时结构不被破坏", () => {
    const result = buildHapilonInstructions([
      { path: "/x.md", content: "before </hapilon_instructions> after" },
    ]);
    assert.ok(result.includes("&lt;/hapilon_instructions&gt;"), "闭合标签被转义");
    assert.equal(
      (result.match(/<\/hapilon_instructions>/g) ?? []).length,
      1,
      "仅结尾一个闭合标签",
    );
  });

  it("边界条件: 空数组返回空字符串", () => {
    assert.equal(buildHapilonInstructions([]), "");
  });
});

describe("buildHapilonRules", () => {
  it("正常路径: name 属性与正文均转义", () => {
    const result = buildHapilonRules([
      { name: 'test"rule', content: "if a < b & c > d" },
    ]);
    assert.ok(result.includes('name="test&quot;rule"'), "name 属性中双引号被转义");
    assert.ok(result.includes("if a &lt; b &amp; c &gt; d"), "正文 < > & 转义");
  });

  it("边界条件: 空数组返回空字符串", () => {
    assert.equal(buildHapilonRules([]), "");
  });
});

describe("buildEnvironmentSection", () => {
  it("正常路径: 包含 cwd", () => {
    const result = buildEnvironmentSection("/home/user/project");
    assert.ok(result.startsWith("<environment>"));
    assert.ok(result.includes("Current working directory: /home/user/project"));
    assert.ok(result.endsWith("</environment>"));
  });

  it("边界条件: Windows 反斜杠路径归一化为正斜杠", () => {
    const result = buildEnvironmentSection("C:\\Users\\test");
    assert.ok(result.includes("C:/Users/test"), "反斜杠应归一化");
  });
});

describe("buildContextSection", () => {
  it("正常路径: 多文件拼接，path 属性与正文均转义", () => {
    const result = buildContextSection([
      { path: '/a"b.md', content: "hello <x>" },
      { path: "/c.md", content: "world" },
    ]);
    assert.equal((result.match(/<project_instructions/g) ?? []).length, 2, "两个文件条目");
    assert.ok(result.includes('path="/a&quot;b.md"'), "path 中双引号被转义");
    assert.ok(result.includes("hello &lt;x&gt;"), "正文 < > 转义");
  });

  it("边界条件: 空数组输出注释占位 section（Spec §2）", () => {
    const result = buildContextSection([]);
    assert.ok(result.includes("<project_context>"), "仍输出 section");
    assert.ok(result.includes("<!-- 当前为空"), "空时显示注释");
    assert.ok(result.includes("</project_context>"));
    assert.equal(buildContextSection(undefined), result, "undefined 与空数组一致");
  });
});

describe("buildSkillsSection", () => {
  it("正常路径: 输出 name/description/location 三字段 + read 指引", () => {
    const result = buildSkillsSection([
      { name: "deploy", description: "Deploy <fast> & safe", filePath: "/skills/deploy/SKILL.md" },
    ]);
    assert.ok(result.includes("<available_skills>"));
    assert.ok(result.includes("Use the read tool to load a skill's file"), "含加载指引");
    assert.ok(result.includes("<name>deploy</name>"));
    assert.ok(result.includes("<description>Deploy &lt;fast&gt; &amp; safe</description>"), "description 转义");
    assert.ok(result.includes("<location>/skills/deploy/SKILL.md</location>"), "含 SKILL.md 路径");
  });

  it("正常路径: disableModelInvocation 的 skill 被过滤", () => {
    const result = buildSkillsSection([
      { name: "a", description: "d", filePath: "/a/SKILL.md", disableModelInvocation: true },
      { name: "b", description: "d", filePath: "/b/SKILL.md" },
    ]);
    assert.ok(!result.includes("<name>a</name>"), "禁用的 skill 不出现");
    assert.ok(result.includes("<name>b</name>"));
  });

  it("边界条件: 空数组/全部禁用输出注释占位 section（Spec §2）", () => {
    const placeholder = "<available_skills>\n<!-- 当前为空；hapilon 使用 --no-skills -->\n</available_skills>";
    assert.equal(buildSkillsSection([]), placeholder, "空数组输出占位");
    assert.equal(buildSkillsSection(undefined), placeholder, "undefined 输出占位");
    assert.equal(
      buildSkillsSection([{ name: "a", description: "d", filePath: "/a", disableModelInvocation: true }]),
      placeholder,
      "全部禁用输出占位",
    );
  });
});

describe("buildAppendSection", () => {
  it("正常路径: appendSystemPrompt 包裹于 additional_instructions", () => {
    const result = buildAppendSection("Extra instructions here");
    assert.ok(result.includes("<additional_instructions>"));
    assert.ok(result.includes("Extra instructions here"));
  });

  it("边界条件: 空/undefined 返回空字符串", () => {
    assert.equal(buildAppendSection(undefined), "");
    assert.equal(buildAppendSection(""), "");
    assert.equal(buildAppendSection("   "), "");
  });
});

// ── assemble.ts: assembleSystemPrompt ─────────────────────────────────

describe("assembleSystemPrompt", () => {
  const defaultOpts: AssembleOptions = {
    toolSnippets: {
      read: "Read file contents",
      bash: "Execute bash commands (ls, grep, find, etc.)",
      edit: "Make precise file edits",
      write: "Create or overwrite files",
    },
    selectedTools: ["read", "bash", "edit", "write"],
    promptGuidelines: [
      "Use read to examine files instead of cat or sed.",
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "Use write only for new files or complete rewrites.",
    ],
    cwd: "/test/project",
    hapilonMd: [{ path: "/home/.hapilon/HAPILON.md", content: "# Test" }],
    hapilonRules: [],
  };

  it("正常路径: 完整组装含所有必选 section", () => {
    const result = assembleSystemPrompt(defaultOpts);
    assert.ok(result.includes("<system_prompt>"));
    assert.ok(result.includes("<role>"), "含 role");
    assert.ok(result.includes("<available_tools>"), "含 tools");
    assert.ok(result.includes("<custom_tools_note>"), "含 custom_tools_note");
    assert.ok(result.includes("<guidelines>"), "含 guidelines");
    assert.ok(result.includes("<pi_documentation>"), "含 pi_doc");
    assert.ok(result.includes("<hapilon_instructions>"), "含 hapilon_instructions");
    assert.ok(result.includes("# Test"), "含 HAPILON.md 内容");
    assert.ok(result.includes("<environment>"), "含 environment");
    assert.ok(result.includes("Current working directory: /test/project"));
    assert.ok(result.endsWith("</system_prompt>\n"));
  });

  it("正常路径: 全量 section（含 contextFiles/skills/append）与顺序断言", () => {
    const result = assembleSystemPrompt({
      ...defaultOpts,
      hapilonRules: [{ name: "r1", content: "rule body" }],
      contextFiles: [{ path: "/ctx.md", content: "context content" }],
      skills: [{ name: "s1", description: "skill one", filePath: "/s1/SKILL.md" }],
      appendSystemPrompt: "appended text",
    });
    // 全部 11 个 section 标签
    const tags = [
      "<role>",
      "<available_tools>",
      "<custom_tools_note>",
      "<guidelines>",
      "<pi_documentation>",
      "<hapilon_instructions>",
      "<hapilon_rules>",
      "<project_context>",
      "<available_skills>",
      "<additional_instructions>",
      "<environment>",
    ];
    for (const tag of tags) {
      assert.ok(result.includes(tag), `应包含 ${tag}`);
    }
    // 顺序断言：role 最前，environment 最后
    assert.ok(result.indexOf("<role>") < result.indexOf("<available_tools>"), "role 在 tools 之前");
    assert.ok(
      result.indexOf("<environment>") > result.indexOf("<additional_instructions>"),
      "environment 收尾",
    );
  });

  it("正常路径: HAPILON.md 正文 XML 转义", () => {
    const result = assembleSystemPrompt({
      ...defaultOpts,
      hapilonMd: [{ path: "/x.md", content: "use <tag> & Array<string>" }],
    });
    assert.ok(result.includes("use &lt;tag&gt; &amp; Array&lt;string&gt;"), "正文 < > & 转义");
    assert.ok(!result.includes("use <tag>"), "原样尖括号不出现");
  });

  it("边界条件: 空 contextFiles/skills 时仍输出注释占位 section", () => {
    const result = assembleSystemPrompt(defaultOpts);
    assert.ok(result.includes("<project_context>"), "project_context 占位输出");
    assert.ok(result.includes("<available_skills>"), "available_skills 占位输出");
    assert.ok(result.includes("<!-- 当前为空"), "空时显示注释");
  });

  it("边界条件: selectedTools=undefined 回退默认工具集且两个 builder 语义一致", () => {
    const result = assembleSystemPrompt({ ...defaultOpts, selectedTools: undefined });
    // tools section 按默认工具集输出
    assert.ok(result.includes("- read: Read file contents"), "tools 含 read");
    assert.ok(result.includes("- bash: Execute bash commands"), "tools 含 bash");
    // guidelines 按同一默认工具集判断（bash 启用 + 无 grep/find/ls → bashOnlyFileOps 出现）
    assert.ok(result.includes("Use bash for file operations"), "guidelines 与 tools 语义一致");
  });

  it("边界条件: 空 hapilonMd 时不输出 hapilon_instructions section", () => {
    const result = assembleSystemPrompt({ ...defaultOpts, hapilonMd: [] });
    assert.ok(!result.includes("<hapilon_instructions>"));
  });

  it("边界条件: 空 hapilonRules 时不输出 rules section", () => {
    const result = assembleSystemPrompt({ ...defaultOpts, hapilonRules: [] });
    assert.ok(!result.includes("<hapilon_rules>"));
  });

  it("异常路径: rules name 含 XML 特殊字符被转义", () => {
    const result = assembleSystemPrompt({
      ...defaultOpts,
      hapilonRules: [{ name: 'test"rule', content: "body" }],
    });
    assert.ok(result.includes("test&quot;rule"), "双引号应被转义");
  });

  it("正常路径: assembleSystemPrompt 后 metadata 被记录", () => {
    clearSpMeta();
    assembleSystemPrompt(defaultOpts);
    const meta = getSpMeta();
    assert.ok(meta, "metadata 已被记录");
    assert.ok(meta!.sections.roleAndIdentity > 0, "role 长度 > 0");
    assert.ok(meta!.sections.tools > 0, "tools 长度 > 0");
    assert.ok(meta!.sections.environment > 0, "environment 长度 > 0");
    assert.equal(meta!.cwd, defaultOpts.cwd, "cwd 匹配");
    clearSpMeta();
  });
});

// ── assemble.ts: collectHapilonContext（真实文件系统接线） ────────────

describe("collectHapilonContext", () => {
  let tmpHome: string;
  let projectDir: string;

  before(() => {
    // 模拟 home 目录树：<home>/project/sub 为工作目录
    tmpHome = mkdtempSync(join(tmpdir(), "hapilon-ctx-"));
    projectDir = join(tmpHome, "project");
    mkdirSync(join(tmpHome, ".hapilon", "agents", "rules"), { recursive: true });
    mkdirSync(join(projectDir, ".hapilon", "agents", "rules"), { recursive: true });
    writeFileSync(join(tmpHome, ".hapilon", "HAPILON.md"), "# global md");
    writeFileSync(join(projectDir, ".hapilon", "HAPILON.md"), "# project md");
    writeFileSync(join(tmpHome, ".hapilon", "agents", "rules", "g.md"), "global rule");
    writeFileSync(join(projectDir, ".hapilon", "agents", "rules", "p.md"), "project rule");
  });

  after(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("正常路径: 收集 HAPILON.md 与 rules，全局在前项目在后", () => {
    const { hapilonMd, hapilonRules } = collectHapilonContext(projectDir, tmpHome);
    assert.equal(hapilonMd.length, 2, "两层 HAPILON.md");
    assert.ok(hapilonMd[0]!.content.includes("global md"), "全局在前");
    assert.ok(hapilonMd[1]!.content.includes("project md"), "项目在后");
    const names = hapilonRules.map((r) => r.name).sort();
    assert.deepEqual(names, ["g", "p"], "两层 rules 均被收集");
  });

  it("边界条件: 无任何 .hapilon 时返回空", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "hapilon-empty-"));
    try {
      const { hapilonMd, hapilonRules } = collectHapilonContext(emptyDir, emptyDir);
      assert.equal(hapilonMd.length, 0);
      assert.equal(hapilonRules.length, 0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("正常路径: 项目在 home 之外时全局 ~/.hapilon 仍被收集（挂载卷场景）", () => {
    // 项目目录与 home 目录处于两棵独立目录树
    const outsideProject = mkdtempSync(join(tmpdir(), "hapilon-outside-"));
    try {
      const { hapilonMd } = collectHapilonContext(outsideProject, tmpHome);
      assert.equal(hapilonMd.length, 1, "全局 HAPILON.md 通过补查被收集");
      assert.ok(hapilonMd[0]!.content.includes("global md"));
    } finally {
      rmSync(outsideProject, { recursive: true, force: true });
    }
  });
});

// ── index.ts: handler 注册与降级路径 ──────────────────────────────────

describe("hplSystemPrompt handler", () => {
  /** 最小 ExtensionAPI stub：捕获 on() 注册的 handler */
  function createStubPi(): { handlers: Record<string, Function>; pi: unknown } {
    const handlers: Record<string, Function> = {};
    const pi = {
      on(name: string, fn: Function) {
        handlers[name] = fn;
      },
    };
    return { handlers, pi };
  }

  it("正常路径: 注册 before_agent_start handler 且返回 XML system prompt", () => {
    const { handlers, pi } = createStubPi();
    hplSystemPrompt(pi as never);
    assert.ok(handlers["before_agent_start"], "handler 已注册");

    const result = handlers["before_agent_start"]!({
      systemPromptOptions: {
        toolSnippets: { read: "Read file contents" },
        selectedTools: ["read"],
        promptGuidelines: [],
        cwd: "/test",
      },
    }) as { systemPrompt?: string };

    assert.ok(result.systemPrompt, "返回 systemPrompt");
    assert.ok(result.systemPrompt!.startsWith("<system_prompt>"), "XML 结构");
    assert.ok(result.systemPrompt!.includes("Hapilon"), "含品牌标识");
  });

  it("正常路径: customPrompt 存在时让位返回空对象", () => {
    const { handlers, pi } = createStubPi();
    hplSystemPrompt(pi as never);

    const result = handlers["before_agent_start"]!({
      systemPromptOptions: {
        customPrompt: "user custom prompt",
        toolSnippets: {},
        cwd: "/test",
      },
    }) as Record<string, unknown>;

    assert.deepEqual(result, {}, "customPrompt 时不替换");
  });

  it("异常路径: 组装抛错时降级返回空对象且 console.error 被调用", () => {
    const { handlers, pi } = createStubPi();
    hplSystemPrompt(pi as never);

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      // systemPromptOptions 为 undefined → opts.customPrompt 访问抛 TypeError
      const result = handlers["before_agent_start"]!({}) as Record<string, unknown>;
      assert.deepEqual(result, {}, "降级返回空对象（Pi 使用原始 prompt）");
      assert.equal(errors.length, 1, "console.error 被调用一次");
      assert.ok(
        String(errors[0]![0]).includes("[hpl-system-prompt]"),
        "错误日志含扩展标识",
      );
    } finally {
      console.error = originalError;
    }
  });
});
