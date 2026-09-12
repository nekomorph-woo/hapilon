---
name: snap
description: Write one conventional-commit message for the staged diff and commit it, linking any issue the conversation already references.
---

# Snap

Write one conventional-commit message for the staged diff, then commit. Link any issue the conversation already references.

Snap serves any project. It detects the commit language from the repo's own history and rules, and infers `type` / `scope` from the paths touched. It does not bump versions or run project-specific release flow — pair it with a project-level skill when a commit must also version something.

## Process

### 1. Read the staged diff, recall the intent

Run `git diff --cached --stat` and `git diff --cached`. From the diff pick a **type** and a **scope**; from the conversation recall **why the change exists** — the task behind it, in one sentence.

The two sources have different jobs: the diff says *what moved* and keeps the message honest; the conversation says *what it was for* and gives the description its words. A change whose intent cannot be traced in the conversation falls to technical phrasing (step 3).

Completion: every staged file maps to one type and one scope, and the change's purpose is at hand in one sentence.

### 2. Detect the commit language

Pick the language for `description`, in priority order:

1. The language of the last 5 commit messages.
2. The language of the project's rule file (`HAPILON.md` / `.hapilon/agents/rules/*.md`).
3. English.

Completion: one language is chosen before the message is written.

### 3. Write the message

Format:

    <type>(<scope>): <description>

- `description` in the detected language, single line, imperative.
- **Altitude ladder — start at the top, drop only when forced:**
  - **Business altitude (default).** Say what the product or system can now do, or what problem no longer exists: what a user notices, which workflow changed, what got fixed for them. The reader should understand the commit without knowing any file name.
  - **Technical fallback.** Only when the change has no business face at all — pure refactor, deps bump, CI, tooling — state the technical fact plainly instead.
- **One line, one idea.** Never enumerate code points: a description listing functions, fields, or files means the altitude is wrong — climb back up until the scattered items collapse into one purpose.

Completion: one line names the capability gained or the problem closed — or, when none exists, the single technical fact.

### 4. Link issues already in context

Scan the conversation for issue signals. **No signal → append no footer, ask nothing.**

| Signal | Example |
|--------|---------|
| `#<n>` in the user's message | "fixes #42", "links #7 and #13" |
| issue URL | `https://github.com/owner/repo/issues/42` |
| an issue created earlier this session | its number is in context |
| the draft message already cites one | `description` carries `#<n>` |

On match, collect every number and append a footer:

    Closes #42, closes #13

`Closes` is the keyword — GitHub and GitLab both accept `Closes` / `Fixes` / `Resolves`.

Completion: every issue referenced in context is cited, or the message has no footer.

### 5. Commit and summarize

`git commit` with the message. Print a short summary: the type and scope chosen, any linked issues, and how many commits sit ahead of `origin`.

Completion: the commit exists; the summary states the type, scope, any linked issues, and the count of commits ahead of `origin`.

## type

Infer from what the change does.

| type | when |
|------|------|
| feat | new file / function / capability |
| fix | bug fix |
| docs | docs only |
| style | formatting, no logic change |
| refactor | restructure, behavior unchanged |
| perf | performance |
| test | tests |
| chore | build / tooling / deps |
| ci | CI config |

## scope

Infer from the primary path touched; multiple paths → the dominant one.

| path | scope |
|------|-------|
| `src/**/<area>/**` | the area, e.g. `auth`, `api` |
| `tests/**` / `**/*.test.*` | test |
| `docs/**` | docs |
| `package.json` / `*.lock` | deps |
| `.github/workflows/**` | ci |
| root config files | config |
| unclear | the project name, or `core` |
