# Worktree convention: throwaway and destination work in layers

Some work produces code that is **not destination** — prototypes that answer a design question, debug harnesses that chase a bug, data-gathering scripts that surface facts. Other work produces the destination itself — features built with `implement` / `tdd`. Both kinds of work belong in a git worktree; the two layers differ in what happens to the code afterwards. The **throwaway** layer serves a decision, then is discarded. The **destination** layer becomes product code, merged to the main branch through a PR.

## Work layers: which layer does my work belong to

**Destination code is not throwaway.** Code that `implement` / `tdd` produce is destination; code that answers a question and is then discarded is throwaway.

The table is the anchor: it names every fiber-plugin skill, and the layer its output belongs to. When a skill is not listed, **ask the user** — do not default to a classification.

| Layer | Skills | Where the output lives |
|-------|--------|------------------------|
| **throwaway** | `prototype`, `diagnosing-bugs`, `research` (when routed by wayfinder), wayfinder `task` tickets | a throwaway worktree on its own branch, never merged into main |
| **destination** | `implement`, `tdd` | a destination worktree on its own feature branch; merged via PR (merge target is **not** main by default — ask the user or follow the branch the user explicitly names) |
| **neutral** | `grilling`, `grill-me`, `grill-with-docs`, `domain-modeling`, `teach`, `ask-matt`, `writing-great-skills`, `wayfinder`, `codebase-design`, `to-spec`, `to-tickets`, `triage`, `code-review`, `resolving-merge-conflicts`, `improve-codebase-architecture`, `handoff`, `setup-matt-pocock-skills` | follow the current directory — these do not trigger a worktree choice |

`spin` as a plugin is neutral — its skills are not named here. Consumer repos' own skills fall outside the table: **ask the user** which layer they belong to.

The table answers only "which layer does my work belong to". When a destination worktree is *created* is a trigger rule, defined in the destination layer below — the table does not decide that.

## Where worktrees live

Every worktree — throwaway or destination — lives in **`.fiber/worktrees/<slug>/`** inside the repo, where `<slug>` is the branch or task name. This is the b3oy1 unified directory; worktrees never live outside it. The `.gitignore` excludes `.fiber/worktrees/`, so worktree directories never show up as untracked files in the main working tree. The routing table at `.fiber/worktrees.md` maps ticket → path → branch.

## The convention

Rules for the **throwaway** layer. A throwaway's job is done once its decision is made; it must not leak into the destination.

1. **Throwaway code goes in a git worktree** at `.fiber/worktrees/<slug>/` (see Where worktrees live), on its own branch, forked from the current local branch — not necessarily main. If the current branch has uncommitted or unpushed work, commit and push it first, so the new branch forks from a clean, fixed point. `git worktree add` is git's native multi-working-directory mechanism — it lets several throwaways exist in parallel without checkout-juggling. This is a git-layer convention, independent of any agent runtime.

2. **Never merge a throwaway branch into the main branch.** No PR from a throwaway branch to main. The main branch keeps only validated decisions and destination code.

3. **On resolve, extract then remove.** When the ticket resolves, lift the decision / spec / key findings into the resolution comment and the map's Decisions-so-far. Then `git worktree remove` the working directory. The throwaway code's job is done.

4. **Keep the branch while `implement` works, then delete it when the destination lands.** The throwaway branch (pushed to remote) stays as the context pointer linked from the issue while implementation is underway — for **reading and understanding only**. Once the decision has become destination code on main (the implementation PR merges), delete the branch; its reference job is done. Backstop: clear all remaining throwaway branches when the map closes. If an issue should outlive its branch, lift key reference snippets into the resolution comment before deleting.

5. **`implement` writes from the spec, not from the throwaway.** When implementation takes over, it writes destination code from the extracted spec/decision. It does **not** cherry-pick, merge, or reuse the throwaway branch as a starting point. The branch is a reference, not a base.

## Claude Code worktrees are forbidden

Claude Code's `EnterWorktree` mechanism and its `.claude/worktrees/` directory are **forbidden** in this repo — worktrees are created and managed with `git worktree` commands only. A `.claude/worktrees/` directory existing in this repo is a violation.

- If a `.claude/worktrees/` directory exists with no uncommitted work, remove it.
- If it holds uncommitted work, save it (stash or commit) before removing.
- If this session is running inside a `.claude/worktrees/` worktree, save uncommitted work, exit the worktree, and recreate the equivalent environment with `git worktree add`.

## The destination layer

Rules for the **destination** layer — normal feature development in parallel worktrees.

### Trigger: when a destination worktree is created

A destination worktree is created when either signal fires:

1. A destination-layer skill (`implement` / `tdd`) is invoked.
2. The user explicitly asks to work in a destination worktree.

**The AI does not improvise this.** Without a destination-layer skill invocation or an explicit user request, the AI must not open a destination worktree based on its own read of the situation.

When a signal fires, the AI creates the worktree **automatically — no proposal step**, at `.fiber/worktrees/<slug>/` (see Where worktrees live). The fork point must be clean: if the current branch has uncommitted work, **ask the user first** (per the git-working-tree rule) before committing it — never touch uncommitted user work on its own. After creation, register the worktree in `.fiber/worktrees.md` (see Routing below), so a new session routes to it automatically.

**Task-granularity reuse.** Before creating, check `.fiber/worktrees.md`: if the same unfinished task already has a destination worktree, reuse it — do not create a second one. One worktree per unfinished task. When the task lands (its PR merges), remove the worktree and deregister the entry. There is no parallelism cap beyond that.

### Routing: `.fiber/worktrees.md` is the single source of truth

The routing table lives at `.fiber/worktrees.md` — one line per worktree:

    <ticket/issue> — <absolute worktree path> — <branch name> — <status>

`git worktree list` gives branch → directory; the routing table adds the ticket → worktree semantic layer on top. A new session reads the table to find where its task lives.

The main-branch spec (to-spec's issue), the ticket, and the map's Notes each carry a one-line pointer to the table — the wayfinder "index, not store" philosophy. Writing a worktree path is **explicitly authorized** here, overriding the upstream to-spec convention that forbids file paths in specs — the routing table is environment state, not an implementation detail.

Entries are registered on creation, cleaned up on resolve / PR merge: remove the entry and `git worktree remove` the directory.

### Commit and push

- **Commit freely with `snap`.** In a destination worktree the AI commits with `snap` by default — it is the pure-change committer. A separate **version-maintainer** skill (whatever the repo uses — the `ship` skill generated by setup-ship, or the repo's own equivalent) is called **only by the user**, when a commit must also bump a version.
- **Push is free.** The committer only commits; pushing to the origin feature branch of the same name is a free action — the AI or the user may push any time, no approval needed.
- **Merge is human-only.** The AI must not `git merge` or `gh pr merge` onto the main branch. The AI may push and may open PRs; the merge itself is confirmed and executed by a human on GitHub.
- **The main branch only receives merges.** All destination code lives in worktrees; nobody — user included — commits directly to main. A PR merge is the only entry point.
- **Force push is forbidden by default**, allowed only when the branch was never pushed, or when it is known no one else uses it.

### Merge: integration branch A, two levels

Destination worktrees develop on feature branches forked from a shared integration branch **A**, which itself is forked from main. Merging is two-level: feature → A → main.

- **Merge order.** Without dependencies: merge to A in spec/ticket number order (to-tickets numbers blockers-first, so number order is development order); with no numbers, in branch-creation order. With dependencies (B depends on A): the user controls worktree creation and merge-to-A order.
- **feature → A**: the AI merges on its own with `git merge` — no PR needed. "Merge is human-only" applies to the main branch, not to A.
- **A → main**: batched, on a milestone (map wrap-up / release point). The AI opens a PR; a human reviews and merges it ("main only receives merges" applies here). Before opening the A → main PR, the AI must first sync the latest main into A.
- **main → A sync**: the AI merges main into A on its own with `git merge main`; it syncs when it detects new commits on main, and always once before an A → main PR.
- **Conflicts**: always resolve with merge — never rewrite history (force push stays forbidden by default). The AI resolves conflicts at the merge site. **Conflicts it cannot resolve stop the work: ask the user to respond and resolve — the AI must not improvise an understanding and press on.**

## Why a worktree, not just a branch

A single working directory can only checkout one branch at a time — multiple parallel prototypes mean checkout-juggling. A git worktree gives each throwaway its own working directory while sharing one `.git` object store. Parallel exploration without the friction.

## Out of scope

- Throwaway artifacts that never enter the repo (HTML reports / handoff docs written to `$TMPDIR` by `improve-codebase-architecture` / `handoff`) — already outside the repo; the "feed the decision" spirit applies, the worktree mechanism does not.
- `research` skill's own findings (retained in the repo) — throwaway only when wayfinder routes a research ticket to a `research/<name>` branch.
- Disabling Claude Code's `EnterWorktree` at the harness layer (settings / hooks) — this convention bans the mechanism at the documentation level; harness-level enforcement is out of scope here.
