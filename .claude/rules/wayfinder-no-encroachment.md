# Wayfinder planning does not implement

Wayfinder is **plan, don't do**. Planning sessions (map open, tickets at the frontier) decide *what* to build and *where* the seams go. They do not write the destination's code.

## The seam

A ticket's state tells you whether you plan or do:

- **Frontier / grilling / hand-off** → you are still planning. Hand the work off — leave the wayfinder session; implementation happens elsewhere (to-spec → implement, or implement directly). Do not write destination code. This rule does not prescribe *how* the implementation workstream isolates its work (branch, worktree, container — that is the runtime's concern); it only marks the seam.
- **Closed / handed off** → the implementation workstream owns it. That is where code gets written.

## Strong signal: do not cross

Inside a wayfinder session, do **not** enter the "plan mode + ask the user for consent to write destination code" pattern. That is the encroachment slip — planning dressed as implementation. The output of planning is decisions, tickets, and pointers, not source files.

## Naturally exempt

`task` / `prototype` / `research` tickets produce facts, throwaway artifacts, or small state-mutating actions (registering an account, moving data) by design. They are not destination code. This rule does not block them.

## Fallback principle

If you feel the pull to write destination code directly during planning, you are at the **map's edge** — that is exactly the hand-off point. Write a ticket, point at it, and stop.
