/**
 * hpl-system-prompt — hapilon System Prompt 完全控制扩展
 *
 * 通过 before_agent_start 事件全量替换 Pi 默认 system prompt，
 * 改为 hapilon 自有 XML 结构化体系。
 *
 * 让位规则：用户通过 SYSTEM.md / --system-prompt 显式指定 customPrompt 时，
 * 本扩展不替换（返回空），尊重用户显式配置。
 *
 * 组装逻辑由 assemble.ts 完成；降级策略确保任何异常时回退到 Pi 原始 prompt。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assembleSystemPrompt, collectHapilonContext } from "./assemble.js";
import { agentDir } from "../../hapilon-home.js";

export default function hplSystemPrompt(pi: ExtensionAPI): void {
  const userHome = process.env.HOME;
  if (!userHome) {
    // 加载时警告一次：HOME 缺失 → hapilon 上下文（HAPILON.md/rules）不会被注入
    console.warn(
      "[hpl-system-prompt] HOME 环境变量未设置，HAPILON.md 与 rules 将不会注入上下文。",
    );
  }

  pi.on("before_agent_start", (event) => {
    try {
      const opts = event.systemPromptOptions;

      // 用户显式指定 customPrompt（SYSTEM.md / --system-prompt）时让位，不替换
      if (opts.customPrompt) return {};

      const cwd = opts.cwd;

      // 收集 hapilon 自有上下文（HAPILON.md + rules）
      const hapilonCtx = userHome
        ? collectHapilonContext(cwd, userHome)
        : { hapilonMd: [], hapilonRules: [] };

      // 全量组装
      // 全量组装（agentDirPath 供 #50 MCP 环境段使用）
      const systemPrompt = assembleSystemPrompt({
        toolSnippets: opts.toolSnippets ?? {},
        selectedTools: opts.selectedTools,
        promptGuidelines: opts.promptGuidelines,
        appendSystemPrompt: opts.appendSystemPrompt,
        cwd,
        contextFiles: opts.contextFiles,
        skills: opts.skills,
        hapilonMd: hapilonCtx.hapilonMd,
        hapilonRules: hapilonCtx.hapilonRules,
        agentDirPath: agentDir(),
      });

      return { systemPrompt };
    } catch (err) {
      // L2 降级：整体组装异常 → 回退到 Pi 原始 prompt（传原始 err 保留 stack）
      console.error(
        "[hpl-system-prompt] Assembly failed, falling back to original system prompt:",
        err,
      );
      return {}; // 空返回 = 不替换，Pi 使用原始 prompt
    }
  });
}
