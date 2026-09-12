import { CUSTOM_ROLE_FRAMEWORK, getRoleDef } from "./role-registry.js";
import { xmlEscape } from "../../shared/format.js";
/** Static team personalities plus registry-backed custom personalities. */
const ORCHESTRATOR_TEMPLATE = `<team mode="orchestrator">
You are the orchestrator. NEVER modify project files: no edit/write tools,
no shell redirection/heredocs/scripts into project files, no git commits.
Anything in /tmp is fine. Your job: explore, think, investigate, run
research subagents, and drive work by dispatching to your crew.

When the user asks for a new team role, guide them to run /team and choose 创建自定义角色 — do not invent roles yourself.

Crew (pane ids are real, use them as-is):
<CREW>

Dispatch discipline (a "new task" includes fix rounds from review):
1. Check worker state: herdr agent get <id>
   - idle/done: proceed. working: end your turn — the dispatch job wakes you when it settles.
     blocked: read the pane (herdr agent read), resolve with the user.
     unknown: do not send; report to the user.
2. ALWAYS clear before dispatching (never judge whether the old context
   matters): herdr agent send-keys <id> / n e w enter
   then re-check state returns to idle.
3. Dispatch: background(command="herdr agent prompt <id> \"<task>\" --wait --timeout 600000")
   Then end your turn — the background job wakes you when the worker settles.
4. Collect: herdr agent read <id> --source recent-unwrapped --lines 120
5. Review routing: every code change goes to the reviewer (docs/research
   only: skip). Verdict approve → wrap up. fix-then-approve → this is a
   new task: clear worker, dispatch findings + fix instructions, then
   re-dispatch reviewer; loop until approve. reject → re-scope with the
   user before any dispatch.
</team>`;
export const WORKER_SECTION = getRoleDef("worker").promptTemplate;
export const REVIEWER_SECTION = getRoleDef("reviewer").promptTemplate;
function customSection(key, prompt) {
    return `<team mode="${key}">
${CUSTOM_ROLE_FRAMEWORK.replace("<ROLE_PROMPT>", xmlEscape(prompt.trim()))}
</team>`;
}
/** Resolve the single role section selected by HAPI_ORCH_ROLE. */
export function buildTeamRoleSection(key) {
    const role = getRoleDef(key);
    if (role) {
        // Builtins store their complete section. Custom files may store either a
        // complete section or only the role-specific prompt body.
        return role.promptTemplate.includes("<team mode=")
            ? role.promptTemplate
            : customSection(key, role.promptTemplate);
    }
    // Transient roles never enter the registry. Their prompt is handed to the
    // pane through --env by menu.ts and is consumed only by that child pane.
    const transientPrompt = process.env.HAPI_ORCH_ROLE_PROMPT;
    if (process.env.HAPI_ORCH_TRANSIENT_ROLE === "1" && transientPrompt) {
        return customSection(key, transientPrompt);
    }
    return undefined;
}
function crewLine(key, paneId) {
    if (key === "worker" && paneId !== "not open")
        return `- worker ${paneId}: all code changes happen there`;
    if (key === "reviewer" && paneId !== "not open")
        return `- reviewer ${paneId}: code review — every code change goes there`;
    if (key === "reviewer" && paneId === "not open") {
        return "- reviewer not open — tell the user to open it via /team menu, do not dispatch";
    }
    return `- ${key} ${paneId}`;
}
export function fillOrchestratorSection(roles) {
    const crew = roles.map(({ key, paneId }) => crewLine(key, paneId));
    if (!roles.some(({ key }) => key === "reviewer")) {
        crew.push("- reviewer not open — tell the user to open it via /team menu, do not dispatch");
    }
    return ORCHESTRATOR_TEMPLATE.replace("<CREW>", crew.join("\n"));
}
// 默认兜底段不带任何 pane id；正常路径由 hpl-orchestra 经 bridge 传入真实 crew。
export const ORCHESTRATOR_SECTION = fillOrchestratorSection([]);
// 兜底没有状态可填真实 pane，只保留 worker 占位行，避免编排纪律缺少派发目标。
export const ORCHESTRATOR_TAGGED = ORCHESTRATOR_SECTION.replace("Crew (pane ids are real, use them as-is):\n", "Crew (pane ids are real, use them as-is):\n- worker <WORKER_PANE>: all code changes happen there\n");
