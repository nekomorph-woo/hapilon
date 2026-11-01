/**
 * ponytail 集成——加载顺序稳定性验证
 *
 * 核心风险：ponytail 5.x 的 before_agent_start 是「sections 贡献」语义
 * （写 systemPromptOptions.sections.ponytail 后返回空），hpl-system-prompt
 * 是「全量替换」语义（返回 systemPrompt → forceSystemPrompt）。pi 中
 * forceSystemPrompt 与 sections 互斥——若 hpl 不内联，先跑的 ponytail
 * 贡献会被整体丢弃，ponytail 静默失效，无任何报错。
 *
 * hapilon 的防护（两层）：
 * 1. startup 拼接序固定 [npm-BEFORE-HPL(ponytail), ...hpl, ...npm]，
 *    ponytail 先于 hpl-system-prompt 执行；
 * 2. hpl 组装把 opts.sections 的全部贡献内联到 XML 之后
 *    （assembleSystemPrompt 的 extensionSections）。
 *
 * 本测试用内核公开 loader（discoverAndLoadExtensions，真实 jiti 加载链）
 * 按 hapilon 的注入顺序加载两个扩展，跑 ExtensionRunner.emitBeforeAgentStart，
 * 断言最终 prompt = hpl XML + sections 贡献内联，把该前提钉进 CI。
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
import { resolveNpmExtensionsBeforeHplEffect, resolveNpmExtensionPathsEffect } from "../../extensions/npm-extensions.js";
import { Effect } from "effect";

const CWD = process.cwd();

/** runner 构造依赖的 stub（本测试只触发 before_agent_start） */
const stub = (() => ({})) as never;

/** hpl handler 消费的 systemPromptOptions（cwd 为必填字段） */
const promptOpts = {
  cwd: CWD,
  toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files", write: "Write files" },
} as never;

describe("加载顺序稳定性（ponytail 先于 hpl）", () => {
  it("链式语义：sections 贡献被全量替换内联到 XML 之后（runner 真实链路）", async () => {
    const runtime = createExtensionRuntime();

    // sections 贡献型扩展（与 ponytail 5.x index.js 同语义），先加载
    const sectionExt = (
      await discoverAndLoadExtensions(
        ["./dist/test/fixtures/append-extension.js"],
        CWD,
        "./nonexistent-agent-dir",
      )
    ).extensions[0];
    assert.ok(sectionExt, "sections 贡献型扩展加载成功");

    // hpl-system-prompt：替换型（真实模块，经内核 loader 走 dist 入口），后加载
    const hplRes = await discoverAndLoadExtensions(
      ["./dist/extensions/hpl-system-prompt/index.js"],
      CWD,
      "./nonexistent-agent-dir",
    );
    const hplExt = hplRes.extensions[0];
    assert.ok(hplExt, "hpl-system-prompt 加载成功");

    const runner = new ExtensionRunner([sectionExt, hplExt], runtime, CWD, stub, stub);
    const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "hello" }, promptOpts);

    const prompt = result.systemPromptOptions.forceSystemPrompt;
    assert.ok(prompt, "返回了修改后的 prompt");
    // hpl 全量替换已生效（XML 结构存在，Pi 基础 prompt 被换掉）
    assert.ok(prompt.includes("<system_prompt>"), "hpl XML 结构存在");
    assert.ok(!prompt.includes("PI-BASE-PROMPT"), "hpl 全量替换抹掉了 Pi 基础 prompt");
    // sections 贡献被内联在替换之后（尾部）——不内联的实现在此处即红
    assert.ok(prompt.includes("PONYTAIL-TAIL-MARKER"), "sections 贡献存活");
    assert.ok(
      prompt.indexOf("</system_prompt>") < prompt.indexOf("PONYTAIL-TAIL-MARKER"),
      "贡献内联在 hpl XML 之后（等价旧尾部追加位置）",
    );
  });

  it("真实 ponytail 扩展可被内核 loader 加载（防包结构/exports 漂移）", async () => {
    const ponytailEntry = Effect.runSync(resolveNpmExtensionsBeforeHplEffect)[0];
    assert.ok(ponytailEntry.includes("@dietrichgebert/ponytail"), "先行组首位是 ponytail");

    const { extensions, errors } = await discoverAndLoadExtensions(
      [ponytailEntry],
      CWD,
      "./nonexistent-agent-dir",
    );
    assert.equal(errors.length, 0, `加载无错误: ${JSON.stringify(errors)}`);
    assert.equal(extensions.length, 1, "ponytail 加载为一个扩展");
  });

  it("hpl → ponytail 按 hapilon 注入顺序加载后 prompt 链式拼接正确（端到端）", async () => {
    const ponytailEntry = Effect.runSync(resolveNpmExtensionsBeforeHplEffect)[0];
    const npmRest: string[] = Effect.runSync(resolveNpmExtensionPathsEffect);
    assert.ok(!npmRest.some((p) => p.includes("ponytail")), "ponytail 不在主体组");

    // 与 startup 同序：BEFORE_HPL 组在前、hpl 在后
    const { extensions, errors } = await discoverAndLoadExtensions(
      [ponytailEntry, "./dist/extensions/hpl-system-prompt/index.js"],
      CWD,
      "./nonexistent-agent-dir",
    );
    assert.equal(errors.length, 0, `双扩展加载无错误: ${JSON.stringify(errors)}`);
    assert.equal(extensions.length, 2, "加载两个扩展");

    const runner = new ExtensionRunner(extensions, createExtensionRuntime(), CWD, stub, stub);
    const result = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "hi" }, promptOpts);

    const prompt = result.systemPromptOptions.forceSystemPrompt;
    assert.ok(prompt, "返回修改后 prompt");
    assert.ok(prompt.includes("<system_prompt>"), "hpl XML 存在");
    assert.ok(
      prompt.toLowerCase().includes("ponytail"),
      "真实 ponytail 指令文本出现在最终 prompt",
    );
    // 用 lastIndexOf：仓库自身 .hapilon/HAPILON.md 正文可能合法提到 ponytail（XML 内部），
    // 扩展 sections 贡献自身含该词且必然是最后一处——用首处会被自家文档假红
    assert.ok(
      prompt.indexOf("</system_prompt>") < prompt.toLowerCase().lastIndexOf("ponytail"),
      "ponytail 指令位于 hpl XML 之后（内联尾部）",
    );
    // code_style section 与 ponytail 内联共存
    assert.ok(prompt.includes("<code_style>"), "code_style section 与 ponytail 共存");
  });
});

// 类型引用：保持 ExtensionAPI 在导入表（hpl 扩展签名文档用）
export type { ExtensionAPI };
void hplSystemPromptEntry;
