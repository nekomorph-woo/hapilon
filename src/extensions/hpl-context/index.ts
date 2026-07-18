/**
 * hpl-context — hapilon 自有上下文体系扩展
 *
 * Skills 渐进式披露由 Pi 原生引擎自动处理（resources_discover 事件）。
 *
 * 注意：HAPILON.md + Rules 注入已迁移到 hpl-system-prompt 扩展，
 *       由 before_agent_start 全量接管 system prompt 组装。
 *
 * 设计来源: _plans/hpl-context-system.md + _plans/hpl-system-prompt.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectUpward,
  discoverSkillPaths,
} from "../../shared/files.js";

export default function hplContext(pi: ExtensionAPI): void {
  const userHome = process.env.HOME;
  if (!userHome) {
    // 加载时警告一次：HOME 缺失 → skills 发现被跳过
    console.warn("[hpl-context] HOME 环境变量未设置，hapilon skills 发现将被跳过。");
  }

  // ── Skills: 委托 Pi 原生引擎 ────────────────────────────────
  // 使用 event.cwd（会话工作目录）而非 process.cwd()，与 hpl-system-prompt 一致
  pi.on("resources_discover", (event) => {
    if (!userHome) return {};
    const skillDirs = collectUpward(event.cwd, userHome, "agents/skills");
    return { skillPaths: discoverSkillPaths(skillDirs) };
  });
}
