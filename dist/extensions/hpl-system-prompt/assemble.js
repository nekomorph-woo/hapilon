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
 * （Pi 原生 prompt 是 markdown 纯文本，无此结构，不构成参照）。
 */
import { collectUpward, readHapilonMd, readRules, } from "../../shared/files.js";
import { existsSync } from "node:fs";
import { xmlEscape } from "../../shared/format.js";
import { wrapSystemPrompt } from "./xml.js";
import { ROLE_TEXT, CUSTOM_TOOLS_NOTE, buildPiDocText, buildMcpSectionText, BUILTIN_GUIDELINES, CODE_STYLE_TEXT, COMMIT_DISCIPLINE_TEXT, ROLE_COMMIT_BOUNDARY_TEXT, WORKFLOW_TEXT, CONFIRM_BEFORE_BUILDING_TEXT, WRITING_STYLE_TEXT, } from "./sections.js";
import { getPolicySection } from "../hpl-effect-policy/bridge.js";
import { hapilonHome } from "../../config/hapilon-home.js";
import { getAddedDirs } from "../hpl-add-dir/bridge.js";
import { buildContextInjection } from "../hpl-add-dir/context.js";
import { buildTeamRoleSection, MISSING_ROLE_SECTION } from "../hpl-orchestra/roles.js";
// ── Individual builders ────────────────────────────────────────────────
export function buildRoleSection() {
    return `<role>\n${ROLE_TEXT}\n</role>`;
}
/** browser_* 工具描述共享的用法前缀；逐条重复 15 次，剥成组级一条（措辞变了则原样保留，fail-open）。 */
const BROWSER_PAGES_HINT = "Use browser_list_pages first, then pass its numeric pageId.";
export function buildToolsSection(toolSnippets, selectedTools) {
    const visible = selectedTools.filter((name) => !!toolSnippets[name]);
    if (visible.length === 0) {
        return "<available_tools>\n(none)\n</available_tools>";
    }
    let browserHintPlaced = false;
    const list = visible
        .map((name) => {
        let desc = toolSnippets[name];
        if (desc.startsWith(BROWSER_PAGES_HINT)) {
            desc = desc.slice(BROWSER_PAGES_HINT.length).trimStart();
            if (!browserHintPlaced) {
                browserHintPlaced = true;
                desc = `${BROWSER_PAGES_HINT} ${desc}`;
            }
        }
        return `- ${name}: ${desc}`;
    })
        .join("\n");
    return `<available_tools>\n${list}\n</available_tools>`;
}
export function buildCustomToolsNote() {
    return `<custom_tools_note>\n${CUSTOM_TOOLS_NOTE}\n</custom_tools_note>`;
}
/** Policy 文本由 hpl-effect-policy 生成；此处只负责条件拼接。 */
export function buildCodingPolicySection(text) {
    return text;
}
export function buildGuidelinesSection(promptGuidelines, selectedTools) {
    const guidelines = [];
    const seen = new Set();
    const add = (g) => {
        const trimmed = g.trim();
        if (trimmed.length > 0 && !seen.has(trimmed)) {
            seen.add(trimmed);
            guidelines.push(trimmed);
        }
    };
    const hasBash = selectedTools.includes("bash");
    const hasPowerShell = selectedTools.includes("powershell");
    const hasGrep = selectedTools.includes("grep");
    const hasFind = selectedTools.includes("find");
    const hasLs = selectedTools.includes("ls");
    // 与 pi 0.85.1 对齐：bash/PowerShell 启用（grep/find/ls 均未启用时）按组合给指引
    if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
        if (hasBash && hasPowerShell) {
            add(BUILTIN_GUIDELINES.bashAndPowerShellFileOps);
        }
        else if (hasPowerShell) {
            add(BUILTIN_GUIDELINES.powerShellOnlyFileOps);
        }
        else {
            add(BUILTIN_GUIDELINES.bashOnlyFileOps);
        }
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
export function buildCodeStyleSection() {
    // 纯常量正文（无用户输入），不经过 xmlEscape——与 buildRoleSection 同策略
    return `<code_style>\n${CODE_STYLE_TEXT}\n</code_style>`;
}
export function buildCommitDisciplineSection() {
    // 纯常量正文（无用户输入），不经过 xmlEscape——与 buildCodeStyleSection 同策略
    return `<commit_discipline>\n${COMMIT_DISCIPLINE_TEXT}\n</commit_discipline>`;
}
export function buildRoleCommitBoundarySection() {
    // 纯常量正文（无用户输入），不经过 xmlEscape——与 buildCodeStyleSection 同策略
    return `<role_commit_boundary>\n${ROLE_COMMIT_BOUNDARY_TEXT}\n</role_commit_boundary>`;
}
/** confirmPre 是否为 true 由调用方按「非 team 会话」判定：见 assembleSystemPrompt */
export function buildWorkflowSection(preconfirm = false) {
    // 纯常量正文（无用户输入），不经过 xmlEscape——与 buildCodeStyleSection 同策略
    const body = preconfirm ? `${CONFIRM_BEFORE_BUILDING_TEXT}\n\n${WORKFLOW_TEXT}` : WORKFLOW_TEXT;
    return `<workflow>\n${body}\n</workflow>`;
}
export function buildWritingStyleSection() {
    // 纯常量正文（无用户输入），不经过 xmlEscape——与 buildCodeStyleSection 同策略
    return `<writing_style>\n${WRITING_STYLE_TEXT}\n</writing_style>`;
}
export function buildPiDocSection() {
    return `<pi_documentation>\n${buildPiDocText()}\n</pi_documentation>`;
}
export function buildHapilonInstructions(hapilonMd) {
    if (hapilonMd.length === 0)
        return "";
    // 正文转义：防 < > & 破坏 XML 结构
    const body = hapilonMd.map((f) => xmlEscape(f.content)).join("\n\n").trim();
    return `<hapilon_instructions>\n${body}\n</hapilon_instructions>`;
}
export function buildHapilonRules(rules) {
    if (rules.length === 0)
        return "";
    // name 属性与正文均转义
    const items = rules
        .map((r) => `<rule name="${xmlEscape(r.name)}">\n${xmlEscape(r.content)}\n</rule>`)
        .join("\n\n");
    return `<hapilon_rules>\n\n${items}\n\n</hapilon_rules>`;
}
/**
 * 领域词汇表段：静态路径引用（byte 级恒定，不随词汇表内容变化——前缀缓存不受影响）。
 * 内容侧指导模型按需 read；写侧（拍板即追加）由 domain-modeling 技能承载。
 */
export function buildDomainGlossarySection(glossary) {
    if (glossary === null || glossary === undefined || glossary === "") {
        return `<domain_glossary>\n领域词汇表未建。术语被拍板/澄清时，按 domain-modeling 技能在 .hapilon/CONTEXT.md 建表。\n</domain_glossary>`;
    }
    return `<domain_glossary>\n领域词汇表在 .hapilon/CONTEXT.md（人与 AI 共同维护）。涉及领域命名/用词的任务开工前先 read 该文件，遵循既定术语。新术语拍板即追加一行（domain-modeling 技能）。\n</domain_glossary>`;
}
export function buildContextSection(contextFiles) {
    if (!contextFiles || contextFiles.length === 0) {
        // 无论是否为空都输出 section，空时显示注释（防将来去掉 --no-context-files）
        return `<project_context>\n<!-- 当前为空；hapilon 使用 --no-context-files -->\n</project_context>`;
    }
    // path 属性与正文均转义
    const entries = contextFiles
        .map((f) => `<project_instructions path="${xmlEscape(f.path)}">\n${xmlEscape(f.content)}\n</project_instructions>`)
        .join("\n\n");
    return `<project_context>\n\n${entries}\n\n</project_context>`;
}
export function buildSkillsSection(skills, selectedTools) {
    if (!skills || skills.length === 0) {
        // 无论是否为空都输出 section，空时显示注释（防将来去掉 --no-skills）
        return `<available_skills>\n<!-- 当前为空；hapilon 使用 --no-skills -->\n</available_skills>`;
    }
    // 与 pi 0.85.1 formatSkillsForPrompt 对齐：模型需有能读文件的工具 skill 才有意义。
    // 无 read/bash 时静默不注入（原生行为）——注入了模型也无法加载。
    const skillFileReadTool = selectedTools
        ? ["read", "bash"].find((tool) => selectedTools.includes(tool))
        : "read";
    if (!skillFileReadTool) {
        return `<available_skills>\n<!-- 当前为空；hapilon 使用 --no-skills -->\n</available_skills>`;
    }
    const visible = skills.filter((s) => !s.disableModelInvocation);
    if (visible.length === 0) {
        return `<available_skills>\n<!-- 当前为空；hapilon 使用 --no-skills -->\n</available_skills>`;
    }
    // 指引措辞随可用读取工具自适应（pi 0.85.1 同语义：bash-only 时改说 Use bash）
    const readHint = skillFileReadTool === "read"
        ? "Use the read tool to load a skill's file when the task matches its description."
        : "Use bash to load a skill's file when the task matches its description.";
    // 与 Pi formatSkillsForPrompt 对齐：name/description/location 三字段 + read 指引
    const entries = visible
        .map((s) => `<skill>\n<name>${xmlEscape(s.name)}</name>\n<description>${xmlEscape(s.description)}</description>\n<location>${xmlEscape(s.filePath)}</location>\n</skill>`)
        .join("\n");
    return `<available_skills>\n${readHint}\n${entries}\n</available_skills>`;
}
export function buildAppendSection(appendSystemPrompt) {
    if (!appendSystemPrompt || appendSystemPrompt.trim().length === 0)
        return "";
    return `<additional_instructions>\n${appendSystemPrompt}\n</additional_instructions>`;
}
/** vision 子代理派发纪律：输入构造与防幻觉双向约束（主模型侧） */
export function buildVisionDelegationSection() {
    return [
        "<vision_delegation>",
        "Prefer dispatching image/screenshot analysis to the vision sub-agent (multimodal, subagent_type=vision); the main session does not read images directly:",
        "- Dispatch input must include all four: image paths, the specific question to answer, judgment/acceptance criteria, and the expected output format. Without them vision can only ask back or state assumptions — a wasted round trip.",
        "- After receiving vision's text findings, aggregate and adjudicate strictly on its verbatim content: never imagine problems in the image, never fabricate visual details it did not report. If in doubt about the picture, send the question back to vision for re-check instead of guessing.",
        "</vision_delegation>",
    ].join("\n");
}
/** 外部目录（/add-dir）注入内容由 hpl-add-dir 经 bridge 提供；此处条件拼接 + XML 转义。 */
export function buildExternalDirsSection() {
    const dirs = getAddedDirs();
    if (dirs.length === 0)
        return "";
    const body = xmlEscape(buildContextInjection(dirs).trim());
    return `<external_directories>\n${body}\n</external_directories>`;
}
export function buildEnvironmentSection(cwd, agentDirPath, runModeText) {
    const normalized = cwd.replace(/\\/g, "/");
    const runMode = runModeText ? `\n${runModeText}` : "";
    const mcp = agentDirPath ? `\n${buildMcpSectionText(agentDirPath)}` : "";
    return `<environment>\nCurrent working directory: ${normalized}${runMode}${mcp}\n</environment>`;
}
// ── Assembly ───────────────────────────────────────────────────────────
const HAPILON_RELATIVE = "HAPILON.md";
const RULES_RELATIVE = "agents/rules";
const GLOSSARY_RELATIVE = "CONTEXT.md";
/** Pi 默认工具集（与 Pi system-prompt.ts 的 selectedTools 缺省一致） */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
/** 收集 HAPILON.md 和 rules：项目/祖先层 .hapilon/ + 全局层（缺省 HAPILON_HOME 数据根） */
function collectHapilonContext(cwd, userHome, globalBase = hapilonHome()) {
    const hapilonMdPaths = collectUpward(cwd, userHome, HAPILON_RELATIVE, globalBase);
    const hapilonMd = readHapilonMd(hapilonMdPaths);
    const ruleDirs = collectUpward(cwd, userHome, RULES_RELATIVE, globalBase);
    const hapilonRules = readRules(ruleDirs);
    // 领域词汇表：只判存在性（内容不内联——前缀缓存稳定）；项目/祖先层就近，全局层兜底
    const glossaryPaths = collectUpward(cwd, userHome, GLOSSARY_RELATIVE, globalBase);
    const domainGlossary = glossaryPaths.some((path) => existsSync(path)) ? "exists" : null;
    return { hapilonMd, hapilonRules, domainGlossary };
}
/**
 * 完整组装 hapilon system prompt（纯函数，不做文件 I/O）。
 * 从 opts 构建所有 XML section，拼接为 final prompt。
 * selectedTools 缺省时回退 Pi 默认工具集，统一传给 tools 和 guidelines
 * 两个 builder，保证语义一致。
 */
export function assembleSystemPrompt(opts) {
    const { toolSnippets, selectedTools, promptGuidelines, appendSystemPrompt, cwd, contextFiles, skills, hapilonMd, hapilonRules, agentDirPath, runModeText, team, extensionSections, domainGlossary, } = opts;
    // 统一归一化：undefined = Pi 默认工具集（两个 builder 语义一致）
    const tools = selectedTools ?? DEFAULT_TOOLS;
    const roleSection = buildRoleSection();
    const toolsSection = buildToolsSection(toolSnippets, tools);
    const customToolsNote = buildCustomToolsNote();
    const codingPolicySection = getPolicySection();
    const guidelinesSection = buildGuidelinesSection(promptGuidelines, tools);
    // Keep this branch deliberately exclusive: before_agent_start returns a full prompt,
    // so a worker/reviewer role must never coexist with the orchestrator section.
    // Orchestrator 段文本由 hpl-orchestra 经 bridge 提供（含实值 pane id）；
    // team 未启用时不注入，普通/单会话不应读到大段 orchestrator 纪律。
    // 不变量（review-r3 N2）：HAPI_ORCH_ROLE 非空的面板永远不落回 orchestrator 段——
    // 即使它的角色定义与状态文件都被删除，也只能拿到 MISSING_ROLE_SECTION。
    const hasRoleEnv = Boolean(process.env.HAPI_ORCH_ROLE);
    const teamSection = process.env.HERDR_ENV !== "1"
        ? ""
        : hasRoleEnv || team?.role
            ? (buildTeamRoleSection(team?.role ?? process.env.HAPI_ORCH_ROLE) ?? MISSING_ROLE_SECTION)
            : (team?.orchestrator ?? "");
    const codeStyleSection = buildCodeStyleSection();
    const commitDisciplineSection = buildCommitDisciplineSection();
    const roleCommitBoundarySection = buildRoleCommitBoundarySection();
    // 开工确认只给非 team 会话：team 的确认由 owner 写目标门承担，所有 role 的 prompt
    // 里都不出现这段（含 worker——角色豁免写进正文反而引入「我是哪个角色」的噪音）
    const workflowSection = buildWorkflowSection(teamSection === "");
    const writingStyleSection = buildWritingStyleSection();
    const piDocSection = buildPiDocSection();
    const hapilonInstructions = buildHapilonInstructions(hapilonMd);
    const hapilonRulesSection = buildHapilonRules(hapilonRules);
    const domainGlossarySection = buildDomainGlossarySection(domainGlossary);
    const contextFilesSection = buildContextSection(contextFiles);
    const externalDirsSection = buildExternalDirsSection();
    const skillsSection = buildSkillsSection(skills, tools);
    const visionDelegationSection = buildVisionDelegationSection();
    const appendSection = buildAppendSection(appendSystemPrompt);
    const envSection = buildEnvironmentSection(cwd, agentDirPath, runModeText);
    const prompt = wrapSystemPrompt([
        roleSection,
        toolsSection,
        customToolsNote,
        ...(codingPolicySection ? [buildCodingPolicySection(codingPolicySection)] : []),
        guidelinesSection,
        teamSection,
        codeStyleSection,
        commitDisciplineSection,
        roleCommitBoundarySection,
        workflowSection,
        writingStyleSection,
        piDocSection,
        hapilonInstructions,
        hapilonRulesSection,
        ...(domainGlossarySection ? [domainGlossarySection] : []),
        contextFilesSection,
        externalDirsSection,
        skillsSection,
        visionDelegationSection,
        appendSection,
        envSection,
    ]);
    // 兄弟扩展的 sections 贡献内联在 XML 之后（等价旧版「尾部追加」语义，
    // 4.x ponytail 的追加位置就在这里）；无贡献时不引入多余空行
    const contributed = Object.values(extensionSections ?? {}).filter((text) => text.length > 0);
    return contributed.length > 0 ? `${prompt}\n\n${contributed.join("\n\n")}` : prompt;
}
// Re-export for index.ts
export { collectHapilonContext };
