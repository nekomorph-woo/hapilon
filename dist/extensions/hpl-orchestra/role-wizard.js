import { CUSTOM_ROLE_FRAMEWORK } from "./role-registry.js";
import { resolveTierModelByTier } from "./herdr.js";
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
const TIERS = new Set(["opus", "sonnet", "haiku"]);
function tierReference(tier) {
    return `${tier[0].toUpperCase()}${tier.slice(1)} — ${resolveTierModelByTier(tier) ?? "未配置"}`;
}
/** 创建/编辑自定义角色时发给主面板模型的中文对话向导。 */
export function buildWizardPrompt(existing) {
    const edit = existing
        ? `\nThis is an edit of the existing role. Here is its current definition:\n${JSON.stringify(existing, null, 2)}\nAsk the user to confirm or change each field one at a time, then output the updated sentinel.`
        : "";
    return `You are guiding the user through creating a custom team role. Speak with the user in Chinese. Ask exactly one question at a time and wait for the answer before asking the next question.${edit}

Collect these fields in order:
1. key: lowercase English letters, digits, and hyphens (for example docs-writer).
2. label: one concise Chinese sentence/name.
3. prompt: detailed responsibility and style, including whether the role is read-only or may write, its output format, and forbidden actions. Use the built-in worker and reviewer roles as references. The prompt must explicitly say the role does not orchestrate and does not dispatch other panes; check and complete that boundary if the user omits it.
4. model tier: let the user choose one of these three resolved references:
   ${tierReference("opus")}
   ${tierReference("sonnet")}
   ${tierReference("haiku")}

When all fields are collected, output exactly one separate line containing this JSON sentinel and no Markdown fence:
{"teamRoleDef":{"key":"...","label":"...","tier":"opus|sonnet|haiku","prompt":"..."}}
Do not invent or dispatch another team role while conducting this wizard.`;
}
/** transient 角色只从当前对话推导职责，不再向用户逐项提问。 */
export function buildTransientRolePrompt(tier) {
    return `根据当前对话内容，直接设计一个职责边界清晰的临时团队角色。不要提问，不要编排或派发其它面板；用中文写 label 和 prompt，prompt 必须包含只读/可写边界、输出格式、禁止项和不编排不派发边界。只输出一行 JSON 哨兵，不要 Markdown 代码围栏：{"teamRoleDef":{"key":"英文短横线 key","label":"中文名称","tier":"${tier}","prompt":"职责与输出格式"}}`;
}
/** 拼接不可绕过的自定义角色边界；用替换回调保留 prompt 中的 $ 序列。 */
export function buildConstraintFrame(userPrompt) {
    return CUSTOM_ROLE_FRAMEWORK.replace("<ROLE_PROMPT>", () => userPrompt.trim());
}
function findJsonObjects(text) {
    const candidates = [];
    for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (escaped)
                    escaped = false;
                else if (char === "\\")
                    escaped = true;
                else if (char === '"')
                    inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === "{")
                depth++;
            if (char === "}") {
                depth--;
                if (depth === 0) {
                    candidates.push(text.slice(start, index + 1));
                    break;
                }
            }
        }
    }
    return candidates;
}
/** 解析 assistant 文本中的自定义角色哨兵；围栏和前后说明均可存在。 */
export function parseRoleDefSentinel(text) {
    for (const candidate of findJsonObjects(text)) {
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        }
        catch {
            continue;
        }
        if (!parsed || typeof parsed !== "object")
            continue;
        const raw = parsed.teamRoleDef;
        if (!raw || typeof raw !== "object")
            continue;
        const value = raw;
        if (typeof value.key !== "string" || !ROLE_KEY_PATTERN.test(value.key))
            continue;
        if (typeof value.label !== "string" || value.label.trim().length === 0)
            continue;
        if (typeof value.prompt !== "string" || value.prompt.trim().length === 0)
            continue;
        if (typeof value.tier !== "string" || !TIERS.has(value.tier))
            continue;
        const tier = value.tier;
        return {
            key: value.key,
            label: value.label.trim(),
            promptTemplate: buildConstraintFrame(value.prompt),
            defaultTier: tier,
            singleton: true,
            builtin: false,
        };
    }
    return undefined;
}
