import { join } from "node:path";
import { CUSTOM_ROLE_FRAMEWORK, getRoleDef } from "./role-registry.js";
import { xmlEscape } from "../../shared/format.js";
import { hapilonHome } from "../../config/hapilon-home.js";
/** Static team personalities plus registry-backed custom personalities. */
const ORCHESTRATOR_TEMPLATE = `<team mode="orchestrator">
You are the orchestrator. NEVER modify project files: no edit/write tools,
no shell redirection/heredocs/scripts into project files, no git commits.
Anything in /tmp is fine. Your job: explore, think, investigate, run
research subagents, and drive work by dispatching to your crew.

When the user asks for a new team role, guide them to run /team and choose 创建自定义角色 — do not invent roles yourself.

Crew (pane ids are real, use them as-is):
<CREW>

Task briefs: one dossier directory per task,
   <PLAN_TASK_DIR>/YYYY-MM-DD-slug/. Write the full brief as task-brief.md
   there (refine it incrementally before dispatch) and reference that path when
   dispatching. Workers and reviewers file their reports in the same directory.
   /tmp is never a brief home.

Crew state handling (states from the /team panel):
- working → wait; if stale (no report past the threshold) → interrupt and
  demand the report.
- waiting-input → read the pane to see the question. Design clarifications
  and constraint arbitration: answer it yourself via send-keys. Irreversible
  operations, credentials, external effects: escalate to the human — never
  auto-answer.
- done → collect: read that pane's own report file in the task's dossier
  directory (worker-report.md for the worker, reviewer-report.md for the
  reviewer; the pane line is only a pointer; the file is the record).
- dead → respawn per the crew table, then have the respawned pane assess partial work.
- unknown → read the pane manually before acting; ask the human if still unclear.

Dispatch discipline (a "new task" includes fix rounds from review):
1. ALWAYS clear before dispatching (never judge whether the old context
   matters): herdr agent send-keys <id> / n e w enter
   then re-check state returns to idle.
2. Dispatch: background(command="herdr agent prompt <id> \"<task>\" --wait --timeout 600000")
   Then end your turn — the background job wakes you when the pane settles.
3. Collect: herdr agent read <id> --source recent-unwrapped --lines 120
4. Review routing: every code change goes to the reviewer (docs/research
   only: skip). Verdict approve → wrap up. fix-then-approve → this is a
   new task: clear worker, dispatch findings + fix instructions, then
   re-dispatch reviewer; loop until approve. reject → re-scope with the
   user before any dispatch.

Crew state polling — after every dispatch, and whenever you wake:
1. Re-check each pane: herdr agent get <id>. When the status is blocked,
   sample the screen twice: herdr pane read <id> --source visible --lines 40.
   Two consecutive samples showing an ask_user or approval dialog mean
   waiting-input — a single sample can be a half-drawn frame.
2. States: working | waiting-input | stale | dead | done | unknown.
   done requires the report file in the task dossier (worker-report.md /
   reviewer-report.md): a live pane is never evidence that work finished,
   and idle alone is not done. working/idle with no report file past 15
   minutes of no observed change is stale — read the pane, then re-poll,
   re-dispatch, or report to the user. unknown means contradictory signals
   or a failed read: tell the user, never guess.
   The /team menu shows the same state per pane.
3. Answer policy at waiting-input:
   | question kind                                            | action |
   | design clarification, constraint arbitration, scoping     | answer it yourself in the brief's context (herdr agent send-keys the option that matches intent) |
   | irreversible action, credentials, anything published externally | never answer — escalate to the user and wait |
</team>`;
function customSection(key, prompt) {
    return `<team mode="${key}">
${CUSTOM_ROLE_FRAMEWORK.replace("<ROLE_PROMPT>", () => xmlEscape(prompt.trim()))}
</team>`;
}
/** Resolve the single role section selected by HAPI_ORCH_ROLE. */
export function buildTeamRoleSection(key) {
    const role = getRoleDef(key);
    if (role) {
        // Builtins are trusted static templates. Custom definitions always pass
        // through the constraint wrapper, even if their body contains a fake tag.
        return role.builtin ? role.promptTemplate : customSection(key, role.promptTemplate);
    }
    // Transient roles never enter the registry. Their prompt is handed to the
    // pane through --env by menu.ts and is consumed only by that child pane.
    const transientPrompt = process.env.HAPI_ORCH_ROLE_PROMPT;
    if (process.env.HAPI_ORCH_TRANSIENT_ROLE === "1" && transientPrompt) {
        return customSection(key, transientPrompt);
    }
    return undefined;
}
export const MISSING_ROLE_SECTION = `<team mode="unknown">
This panel's team role definition is missing. Ask the user to re-create the role or run /team.
</team>`;
/** 自愈指令：主 agent 把 /team:open <key> 打进自己的输入框就能开/救活对应角色面板。 */
function selfOpenLine(key) {
    return `- ${key} not open — send \`/team:open ${key}\` to your own pane, wait for it in the crew table, then dispatch.`;
}
/** reviewer 缺席时的唯一定义：crew 行与无 reviewer 兜底行共用，避免两处文案漂移。 */
const REVIEWER_NOT_OPEN_LINE = "- reviewer not open — review necessity is your call: code or behavior"
    + " changes → open it yourself (send `/team:open reviewer` to your own pane), wait for it in the"
    + " crew table, then dispatch the review. Docs/research-only changes → no reviewer.";
function crewLine(key, paneId) {
    if (key === "worker" && paneId !== "not open")
        return `- worker ${paneId}: all code changes happen there`;
    if (key === "reviewer" && paneId !== "not open")
        return `- reviewer ${paneId}: code review — every code change goes there`;
    if (key === "reviewer")
        return REVIEWER_NOT_OPEN_LINE;
    return paneId === "not open" ? selfOpenLine(key) : `- ${key} ${paneId}`;
}
export function fillOrchestratorSection(roles) {
    const crew = roles.map(({ key, paneId }) => crewLine(key, paneId));
    if (!roles.some(({ key }) => key === "reviewer")) {
        crew.push(REVIEWER_NOT_OPEN_LINE);
    }
    return ORCHESTRATOR_TEMPLATE
        .replace("<CREW>", crew.join("\n"))
        .replace("<PLAN_TASK_DIR>", () => join(hapilonHome(), "plan-task"));
}
// 默认兜底段不带任何 pane id；正常路径由 hpl-orchestra 经 bridge 传入真实 crew。
export const ORCHESTRATOR_SECTION = fillOrchestratorSection([]);
// 兜底没有状态可填真实 pane，只保留 worker 占位行，避免编排纪律缺少派发目标。
export const ORCHESTRATOR_TAGGED = ORCHESTRATOR_SECTION.replace("Crew (pane ids are real, use them as-is):\n", "Crew (pane ids are real, use them as-is):\n- worker <WORKER_PANE>: all code changes happen there\n");
