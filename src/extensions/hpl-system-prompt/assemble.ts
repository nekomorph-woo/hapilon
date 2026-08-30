/**
 * assemble.ts — System Prompt XML builder 函数
 *
 * 各 builder 与 assembleSystemPrompt() 均为纯函数，仅从传入的 options
 * 构建 XML 片段；文件系统读取由 collectHapilonContext()（本文件内唯一
 * 的 I/O 函数）完成，结果经 AssembleOptions 传入。
 *
 * XML 转义策略：正文类内容（HAPILON.md / rules / contextFiles 正文）与
 * 属性值一律 xmlEscape——hapilon 的 prompt 是 XML 结构，正文中的 < > &
 * 若不转义会被模型当作标签/实体解读，甚至提前闭合 section 破坏结构
 * （Spec §3.9；Pi 原生 prompt 是 markdown 纯文本，无此结构，不构成参照）。
 */

import {
  collectUpward,
  readHapilonMd,
  readRules,
  type FileEntry,
  type RuleEntry,
} from "../../shared/files.js";
import { xmlEscape } from "../../shared/format.js";
import { wrapSystemPrompt } from "./xml.js";
import {
  ROLE_TEXT,
  CUSTOM_TOOLS_NOTE,
  buildPiDocText,
  buildMcpSectionText,
  BUILTIN_GUIDELINES,
  CODE_STYLE_TEXT,
} from "./sections.js";
import { setLastMeta } from "./metadata.js";

// ── Types ──────────────────────────────────────────────────────────────

/** Skill 条目：与 Pi 的 Skill 接口结构兼容（filePath 为 SKILL.md 绝对路径） */
export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

export interface AssembleOptions {
  toolSnippets: Record<string, string>;
  selectedTools?: string[];
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles?: FileEntry[];
  skills?: SkillEntry[];
  hapilonMd: FileEntry[];
  hapilonRules: RuleEntry[];
  /** agentDir 绝对路径——提供时 environment section 附加 MCP 环境段（#50） */
  agentDirPath?: string;
}

// ── Individual builders ────────────────────────────────────────────────

export function buildRoleSection(): string {
  return `<role>\n${ROLE_TEXT}\n</role>`;
}

export function buildToolsSection(
  toolSnippets: Record<string, string>,
  selectedTools: string[],
): string {
  const visible = selectedTools.filter((name) => !!toolSnippets[name]);
  const list =
    visible.length > 0
      ? visible.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n")
      : "(none)";
  return `<available_tools>\n${list}\n</available_tools>`;
}

export function buildCustomToolsNote(): string {
  return `<custom_tools_note>\n${CUSTOM_TOOLS_NOTE}\n</custom_tools_note>`;
}

export function buildGuidelinesSection(
  promptGuidelines: string[] | undefined,
  selectedTools: string[],
): string {
  const guidelines: string[] = [];
  const seen = new Set<string>();
  const add = (g: string) => {
    const trimmed = g.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      guidelines.push(trimmed);
    }
  };

  const hasBash = selectedTools.includes("bash");
  const hasGrep = selectedTools.includes("grep");
  const hasFind = selectedTools.includes("find");
  const hasLs = selectedTools.includes("ls");

  // bash 启用但 grep/find/ls 均未启用时，加 "Use bash for file ops"
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    add(BUILTIN_GUIDELINES.bashOnlyFileOps);
  }

  // 工具级 guidelines（从 promptGuidelines 动态获取）
  for (const g of promptGuidelines ?? []) {
    add(g);
  }

  // 内建准则
  add(BUILTIN_GUIDELINES.beConcise);
  add(BUILTIN_GUIDELINES.showFilePaths);

  const list = guidelines.map((g) => `- ${g}`).join("\n");
  return `<guidelines>\n${list}\n</guidelines>`;
}

export function buildCodeStyleSection(): string {
  // 纯常量正文（无用户输入），不经过 xmlEscape——与 buildRoleSection 同策略
  return `<code_style>\n${CODE_STYLE_TEXT}\n</code_style>`;
}

export function buildPiDocSection(): string {
  return `<pi_documentation>\n${buildPiDocText()}\n</pi_documentation>`;
}

export function buildHapilonInstructions(hapilonMd: FileEntry[]): string {
  if (hapilonMd.length === 0) return "";
  // 正文转义（Spec §3.9）：防 < > & 破坏 XML 结构
  const body = hapilonMd.map((f) => xmlEscape(f.content)).join("\n\n").trim();
  return `<hapilon_instructions>\n${body}\n</hapilon_instructions>`;
}

export function buildHapilonRules(rules: RuleEntry[]): string {
  if (rules.length === 0) return "";
  // name 属性与正文均转义（Spec §3.9）
  const items = rules
    .map((r) => `<rule name="${xmlEscape(r.name)}">\n${xmlEscape(r.content)}\n</rule>`)
    .join("\n\n");
  return `<hapilon_rules>\n\n${items}\n\n</hapilon_rules>`;
}

export function buildContextSection(contextFiles?: FileEntry[]): string {
  if (!contextFiles || contextFiles.length === 0) {
    // Spec §2：无论是否为空都输出 section，空时显示注释（防将来去掉 --no-context-files）
    return `<project_context>\n<!-- 当前为空；hapilon 使用 --no-context-files -->\n</project_context>`;
  }
  // path 属性与正文均转义（Spec §3.9）
  const entries = contextFiles
    .map(
      (f) =>
        `<project_instructions path="${xmlEscape(f.path)}">\n${xmlEscape(f.content)}\n</project_instructions>`,
    )
    .join("\n\n");
  return `<project_context>\n\n${entries}\n\n</project_context>`;
}

export function buildSkillsSection(skills?: SkillEntry[]): string {
  const visible = (skills ?? []).filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) {
    // Spec §2：无论是否为空都输出 section，空时显示注释（防将来去掉 --no-skills）
    return `<available_skills>\n<!-- 当前为空；hapilon 使用 --no-skills -->\n</available_skills>`;
  }
  // 与 Pi formatSkillsForPrompt 对齐：name/description/location 三字段 + read 指引
  const entries = visible
    .map(
      (s) =>
        `<skill>\n<name>${xmlEscape(s.name)}</name>\n<description>${xmlEscape(s.description)}</description>\n<location>${xmlEscape(s.filePath)}</location>\n</skill>`,
    )
    .join("\n");
  return `<available_skills>\nUse the read tool to load a skill's file when the task matches its description.\n${entries}\n</available_skills>`;
}

export function buildAppendSection(appendSystemPrompt?: string): string {
  if (!appendSystemPrompt || appendSystemPrompt.trim().length === 0) return "";
  return `<additional_instructions>\n${appendSystemPrompt}\n</additional_instructions>`;
}

export function buildEnvironmentSection(cwd: string, agentDirPath?: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  const mcp = agentDirPath ? `\n${buildMcpSectionText(agentDirPath)}` : "";
  return `<environment>\nCurrent working directory: ${normalized}${mcp}\n</environment>`;
}

// ── Assembly ───────────────────────────────────────────────────────────

const HAPILON_RELATIVE = "HAPILON.md";
const RULES_RELATIVE = "agents/rules";

/** Pi 默认工具集（与 Pi system-prompt.ts 的 selectedTools 缺省一致） */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/** 收集 HAPILON.md 和 rules 文件（从 cwd 向上遍历，home 外项目补查全局） */
function collectHapilonContext(
  cwd: string,
  userHome: string,
): { hapilonMd: FileEntry[]; hapilonRules: RuleEntry[] } {
  const hapilonMdPaths = collectUpward(cwd, userHome, HAPILON_RELATIVE);
  const hapilonMd = readHapilonMd(hapilonMdPaths);

  const ruleDirs = collectUpward(cwd, userHome, RULES_RELATIVE);
  const hapilonRules = readRules(ruleDirs);

  return { hapilonMd, hapilonRules };
}

/**
 * 完整组装 hapilon system prompt（纯函数，不做文件 I/O）。
 * 从 opts 构建所有 XML section，拼接为 final prompt。
 * selectedTools 缺省时回退 Pi 默认工具集，统一传给 tools 和 guidelines
 * 两个 builder，保证语义一致。
 */
export function assembleSystemPrompt(opts: AssembleOptions): string {
  const {
    toolSnippets,
    selectedTools,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles,
    skills,
    hapilonMd,
    hapilonRules,
    agentDirPath,
  } = opts;

  // 统一归一化：undefined = Pi 默认工具集（两个 builder 语义一致）
  const tools = selectedTools ?? DEFAULT_TOOLS;

  const roleSection = buildRoleSection();
  const toolsSection = buildToolsSection(toolSnippets, tools);
  const customToolsNote = buildCustomToolsNote();
  const guidelinesSection = buildGuidelinesSection(promptGuidelines, tools);
  const codeStyleSection = buildCodeStyleSection();
  const piDocSection = buildPiDocSection();
  const hapilonInstructions = buildHapilonInstructions(hapilonMd);
  const hapilonRulesSection = buildHapilonRules(hapilonRules);
  const contextFilesSection = buildContextSection(contextFiles);
  const skillsSection = buildSkillsSection(skills);
  const appendSection = buildAppendSection(appendSystemPrompt);
  const envSection = buildEnvironmentSection(cwd, agentDirPath);

  // 记录元数据：各部分长度供 hpl-context-viewer /context 命令做 token 估算
  setLastMeta({
    assembledAt: Date.now(),
    cwd,
    sections: {
      roleAndIdentity: roleSection.length,
      piDocumentation: piDocSection.length,
      tools: toolsSection.length,
      guidelines: guidelinesSection.length,
      codeStyle: codeStyleSection.length,
      hapilonInstructions: hapilonInstructions.length,
      hapilonRules: hapilonRulesSection.length,
      contextFiles: contextFilesSection.length,
      skills: skillsSection.length,
      customToolsNote: customToolsNote.length,
      additionalData: appendSection.length,
      environment: envSection.length,
    },
  });

  return wrapSystemPrompt([
    roleSection,
    toolsSection,
    customToolsNote,
    guidelinesSection,
    codeStyleSection,
    piDocSection,
    hapilonInstructions,
    hapilonRulesSection,
    contextFilesSection,
    skillsSection,
    appendSection,
    envSection,
  ]);
}

// Re-export for index.ts
export { collectHapilonContext };
