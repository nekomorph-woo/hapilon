# Tracker index body edits

Wayfinder **map** and tracker **index** issue bodies are high-churn, concurrent-edit zones. `gh issue edit --body-file` does a **full overwrite** of the body — a stale snapshot silently destroys concurrent edits (new sub-issues wired by other sessions, Decisions appended, Tickets checked off).

## Rule

Before editing a map or index issue body, **re-fetch it**.

    gh issue view <n> --json body --jq .body

Edit the **just-fetched** body, never a snapshot you held from earlier in the session.

## Prefer incremental edits

Reach for the most surgical operation first; reserve full-body overwrite for genuine rewrites:

- **Wire a sub-issue** → `gh api` on the sub-issues endpoint (no body edit at all).
- **Flip one task checkbox** → fetch body, change that one line, write back.
- **Append a Decision** → fetch body, insert under `## Decisions so far`, write back.
- **Full rewrite** → fetch immediately before, then write.

## High-churn sections

`## Tickets` and `## Decisions so far` change between sessions. When patching them, diff your intended edit against the just-fetched body so you only touch the real delta — don't paste a stale block over a live one.

## Failure mode to avoid

Session opens map, reads body into memory, works for 20 minutes, then `gh issue edit --body-file` with the stale snapshot. A concurrent session's sub-issue wiring is gone, with no reflog to recover. The body is the source of truth, not your in-memory copy.
