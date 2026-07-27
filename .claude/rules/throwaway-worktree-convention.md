# Throwaway code lives in a git worktree, never the main branch

Some work produces code that is **not destination** — prototypes that answer a design question, debug harnesses that chase a bug, data-gathering scripts that surface facts. This code serves a decision; once the decision is made, the code's job is done. It must not leak into the destination.

## What counts as throwaway

- **prototype** tickets (wayfinder) and the `/prototype` skill — code that answers a design question
- **research** tickets routed by wayfinder — scripts/findings that surface facts on a throwaway `research/<name>` branch
- **task** tickets (wayfinder) — data-gathering or state-mutating scripts whose output is facts (credentials, URLs, row counts), not product code
- **diagnosing-bugs** — debug harnesses, repro scripts, curl/replay traces, experimental fixes

Destination code (`implement`, `tdd`, the product itself) is **not** throwaway.

## The convention

1. **Throwaway code goes in a git worktree** on its own branch, forked from the current local branch — not necessarily main. If the current branch has uncommitted or unpushed work, commit and push it first, so the new branch forks from a clean, fixed point. `git worktree add` is git's native multi-working-directory mechanism — it lets several throwaways exist in parallel without checkout-juggling. This is a git-layer convention, independent of any agent runtime.

2. **Never merge a throwaway branch into the main branch.** No PR from a throwaway branch to main. The main branch keeps only validated decisions and destination code.

3. **On resolve, extract then remove.** When the ticket resolves, lift the decision / spec / key findings into the resolution comment and the map's Decisions-so-far. Then `git worktree remove` the working directory. The throwaway code's job is done.

4. **Keep the branch while `implement` works, then delete it when the destination lands.** The throwaway branch (pushed to remote) stays as the context pointer linked from the issue while implementation is underway — for **reading and understanding only**. Once the decision has become destination code on main (the implementation PR merges), delete the branch; its reference job is done. Backstop: clear all remaining throwaway branches when the map closes. If an issue should outlive its branch, lift key reference snippets into the resolution comment before deleting.

5. **`implement` writes from the spec, not from the throwaway.** When implementation takes over, it writes destination code from the extracted spec/decision. It does **not** cherry-pick, merge, or reuse the throwaway branch as a starting point. The branch is a reference, not a base.

## Why a worktree, not just a branch

A single working directory can only checkout one branch at a time — multiple parallel prototypes mean checkout-juggling. A git worktree gives each throwaway its own working directory while sharing one `.git` object store. Parallel exploration without the friction.

## Out of scope

- Throwaway artifacts that never enter the repo (HTML reports / handoff docs written to `$TMPDIR` by `improve-codebase-architecture` / `handoff`) — already outside the repo; the "feed the decision" spirit applies, the worktree mechanism does not.
- `research` skill's own findings (retained in the repo) — throwaway only when wayfinder routes a research ticket to a `research/<name>` branch.
