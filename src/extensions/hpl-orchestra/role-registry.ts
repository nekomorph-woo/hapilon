import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hapilonHome } from "../../config/hapilon-home.js";

export type ModelTier = "opus" | "sonnet" | "haiku";

export interface TeamRoleDef {
  key: string;
  label: string;
  promptTemplate: string;
  defaultTier: ModelTier;
  singleton: boolean;
  builtin: boolean;
}

/** 自定义角色模板的统一边界；职责正文由角色作者提供。 */
export const CUSTOM_ROLE_FRAMEWORK = `You are a custom team role. Work only within the responsibility described below.
Never orchestrate, dispatch, or instruct other agents or panes. Do not create
new team roles. Never git push. Respect the stated read/write boundary and
forbidden actions.
Report in the requested format with concrete evidence, and stop when the
assigned responsibility is complete.

Role responsibilities and style:
<ROLE_PROMPT>`;

const WORKER_PROMPT = `<team mode="worker">
You are the worker pane of a team. Implement ONLY the task dispatched to
you — no orchestration, no dispatching to other agents, no unrelated file
changes. Never run git commit — you implement/review and report; committing
belongs to the orchestrator or the human. Before reporting done: run the
build/tests relevant to your change and fix failures CAUSED BY YOUR CHANGE.
A pre-existing failure you cannot fix in scope: stop and report blocked
with evidence. Report: files changed, verification results, follow-ups.
When the task brief lives in a plan-task directory: write your full report to
worker-report.md in that directory (what changed, verification evidence,
deviations), and keep pane output to a one-line status plus a pointer to the
report file.
</team>`;

const REVIEWER_PROMPT = `<team mode="reviewer">
You are the reviewer pane of a team. READ-ONLY review: no edits, no
writes, no shell redirection into files, no git commands that change
state. Never run git commit — you implement/review and report; committing
belongs to the orchestrator or the human. Primary lens: product/business
intent — does it implement the intent, is it the simplest thing that
works, no over-engineering, no redundant code. Also check correctness,
regression risk, and test coverage. Output numbered findings with
file:line (P0 blocker / P1 should-fix / P2 nit; P2 does not block
approval), or "No findings."
Then one verdict: approve | fix-then-approve | reject.
When the task brief lives in a plan-task directory: write your review to
reviewer-report.md in that directory (numbered findings and the verdict), and
keep pane output to the verdict line plus a pointer to the report file.
</team>`;

const UX_TESTER_PROMPT = `<team mode="ux-tester">
You are the UX tester pane of a team. Validate the product by actually
using it and report the observed experience. You may run builds, start
development servers, and use browser or other interaction commands needed
to verify the result. Do NOT modify project files: no edit/write tools,
file redirection, generated files, or git commits. First summarize the
experience path you tested. Then report numbered findings with severity,
including discoveries, problems, and suggestions. Separate observations
from assumptions and include concrete reproduction evidence.
</team>`;

const DISCUSSANT_PROMPT = `<team mode="discussant">
You are a discussant pane of a team. Read and reason about the given topic
without modifying files. Do not orchestrate, dispatch, or direct other
agents or panes. Respond with this format: one-sentence position; supporting
arguments; counterexamples or likely objections; blind spots and missing
considerations.
</team>`;

export const BUILTIN_ROLE_DEFS: readonly TeamRoleDef[] = [
  {
    key: "worker",
    label: "Worker",
    promptTemplate: WORKER_PROMPT,
    defaultTier: "sonnet",
    // 可多开：/team:open worker 追加实例而非复用；开始编排仍保证恰好一个
    singleton: false,
    builtin: true,
  },
  {
    key: "reviewer",
    label: "Review",
    promptTemplate: REVIEWER_PROMPT,
    defaultTier: "opus",
    singleton: true,
    builtin: true,
  },
  {
    key: "ux-tester",
    label: "体验官",
    promptTemplate: UX_TESTER_PROMPT,
    defaultTier: "sonnet",
    singleton: true,
    builtin: true,
  },
  {
    key: "discussant",
    label: "讨论成员",
    promptTemplate: DISCUSSANT_PROMPT,
    defaultTier: "opus",
    singleton: false,
    builtin: true,
  },
];

/** 角色 key 唯一正则：小写字母开头，小写字母/数字/连字符，连字符不连续、不结尾 */
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TIERS = new Set<ModelTier>(["opus", "sonnet", "haiku"]);

export function rolesDir(): string {
  return join(hapilonHome(), "teams", "roles");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRoleKey(value: unknown): value is string {
  return typeof value === "string" && ROLE_KEY_PATTERN.test(value);
}

function warning(path: string, reason: string): void {
  console.warn(`[hpl-orchestra] 自定义角色 ${path} 已跳过：${reason}`);
}

function parseRoleDef(path: string, value: unknown): TeamRoleDef | undefined {
  if (!isObject(value)) {
    warning(path, "顶层必须是对象");
    return undefined;
  }
  const { key, label, promptTemplate, prompt, defaultTier, tier, singleton } = value;
  const template = typeof promptTemplate === "string" ? promptTemplate : prompt;
  const selectedTier = defaultTier ?? tier;
  if (!validRoleKey(key)) {
    warning(path, "key 必须是小写英文短横线格式");
    return undefined;
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    warning(path, "label 必须是非空字符串");
    return undefined;
  }
  if (typeof template !== "string" || template.trim().length === 0) {
    warning(path, "promptTemplate（或 prompt）必须是非空字符串");
    return undefined;
  }
  if (typeof selectedTier !== "string" || !TIERS.has(selectedTier as ModelTier)) {
    warning(path, "defaultTier 必须是 opus、sonnet 或 haiku");
    return undefined;
  }
  if (singleton !== undefined && typeof singleton !== "boolean") {
    warning(path, "singleton 必须是 boolean");
    return undefined;
  }
  return {
    key,
    label: label.trim(),
    promptTemplate: template,
    defaultTier: selectedTier as ModelTier,
    // 向导哨兵只收集职责与档位；未声明时按可复用的 singleton 角色处理。
    singleton: singleton === undefined ? true : singleton as boolean,
    builtin: false,
  };
}

/** 读取并校验 ~/.hapilon/teams/roles 下的自定义角色。 */
export function loadCustomRoleDefs(): TeamRoleDef[] {
  const directory = rolesDir();
  if (!existsSync(directory)) return [];

  const builtinKeys = new Set(BUILTIN_ROLE_DEFS.map((role) => role.key));
  const seen = new Set<string>();
  const result: TeamRoleDef[] = [];
  let names: string[];
  try {
    names = readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort();
  } catch (error) {
    warning(directory, `目录无法读取：${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  for (const name of names) {
    const path = join(directory, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      warning(path, `JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const role = parseRoleDef(path, parsed);
    if (!role) continue;
    if (builtinKeys.has(role.key)) {
      warning(path, `key ${role.key} 与内置角色冲突`);
      continue;
    }
    if (seen.has(role.key)) {
      warning(path, `key ${role.key} 与其它自定义角色冲突`);
      continue;
    }
    seen.add(role.key);
    result.push(role);
  }
  return result;
}

/** 内置角色优先，自定义角色按文件名排序合并。 */
export function getAllRoleDefs(): TeamRoleDef[] {
  return [...BUILTIN_ROLE_DEFS, ...loadCustomRoleDefs()];
}

export function getRoleDef(key: string, defs?: readonly TeamRoleDef[]): TeamRoleDef | undefined {
  return (defs ?? getAllRoleDefs()).find((role) => role.key === key);
}

export function saveCustomRoleDef(role: Omit<TeamRoleDef, "builtin"> | TeamRoleDef): boolean {
  const parsed = parseRoleDef("<memory>", role);
  if (!parsed || getRoleDef(parsed.key)?.builtin) return false;
  try {
    const directory = rolesDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, `${parsed.key}.json`), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    console.warn(`[hpl-orchestra] 自定义角色保存失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function deleteCustomRoleDef(key: string): boolean {
  const role = getRoleDef(key);
  if (!role || role.builtin) return false;
  try {
    const path = join(rolesDir(), `${key}.json`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    console.warn(`[hpl-orchestra] 自定义角色删除失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
