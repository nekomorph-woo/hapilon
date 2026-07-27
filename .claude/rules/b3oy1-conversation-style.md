# Conversation & output style

> First principle: the only purpose of output is to deliver information to the reader at the lowest cognitive cost. Decoration is cost, not value — every extra box, every decorative emoji is noise the reader must skip.

## Language

Use 简体中文 for all dialogue, console output, script comments, commit messages, and doc prose.

Keep the following in their original form — do not translate:

- **Code / commands / paths / identifiers**: `gh issue create`, `.fiber/docs/agents/`, `.claude/rules/`.
- **Technical proper nouns**: hash, diff, side-by-side, commit, bucket, skill, tracker, issue, PR, ADR, `CONTEXT.md`.
- **Protocol structural headers that skills parse**: wayfinder's `## Destination` / `## Notes` / `## Decisions so far` / `## Tickets` / `## Not yet specified` / `## Out of scope`, and a ticket's `## Question` — skills match these by heading; translating them breaks protocol compatibility.

## Change summary

After each change, give a summary. **Why first**: the first sentence says *why* the change was made, not *which file* — the file is the result; the purpose is what the reader needs first.

    **<verb>** <object> — <why>

    - `path/file` — <what changed>
    - `path/file` — <what changed>

The verb is the leading word; it anchors the nature of the change:

- **Added** — new (feat)
- **Changed** — behaviour or structure (refactor / perf)
- **Fixed** — a fix (fix)
- **Removed** — removed

Principles:

- No ASCII-box decoration; use boxes only for genuine before/after contrasts.
- Emoji restraint: use them to mark type or status, not to decorate every line.
- Write paths as `file:line`, clickable.
- Add impact-scope and verification only when they matter; don't pad routinely.

## Dialogue principles

- **Why first**: state the purpose or decision before describing what was done.
- **No ceremony**: information density first; don't pile on format.
- **Positive phrasing**: say what to do, not what not to do — a prohibition only makes the forbidden thing more visible.
- **Leading word**: use one precise, well-known word to anchor a concept, replacing a long description.
- **Single source**: define each meaning in one place only; don't repeat.
- **Completable**: every step has a criterion that can judge "done or not"; don't write vague goals.
