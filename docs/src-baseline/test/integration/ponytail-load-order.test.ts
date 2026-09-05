/**
 * #55 ponytail 集成——加载顺序稳定性验证
 *
 * 核心风险：ponytail 的 before_agent_start 是「尾部追加」语义
 * （返回 event.systemPrompt + "\n\n" + ponytail 指令），hpl-system-prompt
 * 是「全量替换」语义。内核 runner 对多扩展 handler 按加载顺序链式传递
 * currentSystemPrompt（runner.js emitBeforeAgentStart）。
 *
 * 若 ponytail 先于 hpl-system-prompt 执行：ponytail 的追加会被 hpl 的
 * 全量替换抹掉——ponytail 静默失效，无任何报错。
 *
 * hapilon 的防护：cli.ts 固定 [...hpl, ...npm] 顺序 + NPM_EXTENSIONS
 * 声明序把 ponytail 放末位。本测试用内核公开 loader
 * （discoverAndLoadExtensions，真实 jiti 加载链）按 hapilon 的注入顺序
 * 加载两个扩展，跑 ExtensionRunner.emitBeforeAgentStart，断言最终
 * prompt = hpl XML + ponytail 尾部追加，把该前提钉进 CI。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createExtensionRuntime,
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import hplSystemPromptEntry from "../../extensions/hpl-system-prompt/index.js";
import { resolveNpmExtensionPaths } from "../../npm-extensions.js";

const CWD = process.cwd();

/** runner 构造依赖的 stub（本测试只触发 before_agent_start） */
const stub = (() => ({})) as never;

/** hpl handler 消费的 systemPromptOptions（cwd 为必填字段） */
const promptOpts = {
  cwd: CWD,
  toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files", write: "Write files" },
} as never;

describe("#55 加载顺序稳定性（hpl 先于 ponytail）", () => {
  it("链式语义：追加型扩展的输出在替换型扩展之后（runner 真实链路）", async () => {
    const runtime = createExtensionRuntime();

    // hpl-system-prompt：替换型（真实模块，经内核 loader 走 dist 入口）
    const hplRes = await discoverAndLoadExtensions(
      ["./dist/extensions/hpl-system-prompt/index.js"],
      CWD,
      "./nonexistent-agent-dir",
    );
    const hplExt = hplRes.extensions[0];
    assert.ok(hplExt, "hpl-system-prompt 加载成功");

    // 追加型模拟扩展（与 ponytail index.js:204-209 同语义）
    const appendExt = (
      await discoverAndLoadExtensions(
        ["./dist/test/fixtures/append-extension.js"],
        CWD,
        "./nonexistent-agent-dir",
      )
    ).extensions[0];
    assert.ok(appendExt, "追加型扩展加载成功");

    const runner = new ExtensionRunner([hplExt, appendExt], runtime, CWD, stub, stub);
    const result = await runner.emitBeforeAgentStart("hello", undefined, "PI-BASE-PROMPT", promptOpts);

    assert.ok(result?.systemPrompt, "返回了修改后的 prompt");
    const prompt = result!.systemPrompt!;
    // hpl 全量替换已生效（XML 结构存在，Pi 基础 prompt 被换掉）
    assert.ok(prompt.includes("<system_prompt>"), "hpl XML 结构存在");
    assert.ok(!prompt.includes("PI-BASE-PROMPT"), "hpl 全量替换抹掉了 Pi 基础 prompt");
    // 追加在替换之后（尾部，未被抹掉）——顺序错误的实现此处即红
    assert.ok(prompt.includes("PONYTAIL-TAIL-MARKER"), "追加存活");
    assert.ok(
      prompt.indexOf("</system_prompt>") < prompt.indexOf("PONYTAIL-TAIL-MARKER"),
      "追加在 hpl XML 之后（尾部追加语义）",
    );
  });

  it("真实 ponytail 扩展可被内核 loader 加载（防包结构/exports 漂移）", async () => {
    const paths = resolveNpmExtensionPaths();
    const ponytailEntry = paths[paths.length - 1];
    assert.ok(ponytailEntry.includes("@dietrichgebert/ponytail"), "末位是 ponytail");

    const { extensions, errors } = await discoverAndLoadExtensions(
      [ponytailEntry],
      CWD,
      "./nonexistent-agent-dir",
    );
    assert.equal(errors.length, 0, `加载无错误: ${JSON.stringify(errors)}`);
    assert.equal(extensions.length, 1, "ponytail 加载为一个扩展");
  });

  it("hpl → ponytail 按 hapilon 注入顺序加载后 prompt 链式拼接正确（端到端）", async () => {
    const paths = resolveNpmExtensionPaths();
    const ponytailEntry = paths[paths.length - 1];

    // 与 cli.ts:105 同序：hpl 组在前、npm 组（ponytail 末位）在后
    const { extensions, errors } = await discoverAndLoadExtensions(
      ["./dist/extensions/hpl-system-prompt/index.js", ponytailEntry],
      CWD,
      "./nonexistent-agent-dir",
    );
    assert.equal(errors.length, 0, `双扩展加载无错误: ${JSON.stringify(errors)}`);
    assert.equal(extensions.length, 2, "加载两个扩展");

    const runner = new ExtensionRunner(extensions, createExtensionRuntime(), CWD, stub, stub);
    const result = await runner.emitBeforeAgentStart("hi", undefined, "PI-BASE", promptOpts);

    assert.ok(result?.systemPrompt, "返回修改后 prompt");
    const prompt = result!.systemPrompt!;
    assert.ok(prompt.includes("<system_prompt>"), "hpl XML 存在");
    assert.ok(
      prompt.toLowerCase().includes("ponytail"),
      "真实 ponytail 指令文本出现在最终 prompt",
    );
    assert.ok(
      prompt.indexOf("</system_prompt>") < prompt.toLowerCase().indexOf("ponytail"),
      "ponytail 指令位于 hpl XML 之后（尾部追加）",
    );
    // #54 的 code_style section 与 ponytail 追加共存
    assert.ok(prompt.includes("<code_style>"), "code_style section 与 ponytail 共存");
  });
});

// 类型引用：保持 ExtensionAPI 在导入表（hpl 扩展签名文档用）
export type { ExtensionAPI };
void hplSystemPromptEntry;
void createEventBus;
