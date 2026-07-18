/**
 * hpl-context — hapilon 自有上下文体系扩展
 *
 * 替代 Pi 原生的 AGENTS.md / CLAUDE.md / ~/.pi/agent/skills/ 识别，
 * 建立 hapilon 自己的三层体系：
 *   HAPILON.md — ~/.hapilon/HAPILON.md + 项目 .hapilon/HAPILON.md（祖先遍历）
 *   Rules       — ~/.hapilon/agents/rules/*.md + .hapilon/agents/rules/*.md
 *   Skills      — ~/.hapilon/agents/skills/ + .hapilon/agents/skills/
 *
 * Skills 渐进式披露由 Pi 原生引擎自动处理（resources_discover 事件）。
 * 设计来源: _plans/hpl-context-system.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectUpward,
  discoverSkillPaths,
  readHapilonMd,
  readRules,
} from "./files.js";
import { formatHapilonMd, formatRules } from "./format.js";

export default function hplContext(pi: ExtensionAPI): void {
  const userHome = process.env.HOME;

  // ── Skills: 委托 Pi 原生引擎 ────────────────────────────────
  pi.on("resources_discover", (_event) => {
    if (!userHome) return {};
    const skillDirs = collectUpward(process.cwd(), userHome, "agents/skills");
    return { skillPaths: discoverSkillPaths(skillDirs) };
  });

  // ── HAPILON.md + Rules: 注入 systemPrompt ───────────────────
  pi.on("before_agent_start", (event) => {
    if (!userHome) return {};

    // HAPILON.md: collectUpward 从 cwd 到 userHome 自动覆盖所有 .hapilon/ 层级
    const hapilonMdPaths = collectUpward(process.cwd(), userHome, "HAPILON.md");
    const hapilonFiles = readHapilonMd(hapilonMdPaths);
    const hapilonBlock = formatHapilonMd(hapilonFiles);

    // Rules: 同理
    const ruleDirs = collectUpward(process.cwd(), userHome, "agents/rules");
    const rules = readRules(ruleDirs);
    const rulesBlock = formatRules(rules);

    const extra = [hapilonBlock, rulesBlock].filter(Boolean).join("\n\n");
    if (!extra) return {};

    return { systemPrompt: event.systemPrompt + "\n\n" + extra };
  });
}
