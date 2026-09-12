---
name: artifact
description: Self-contained HTML deliverables — long-form reports, explainer pages, plans, dashboards and data tables, PR briefs. Use when the user asks for a standalone deliverable like a report, explainer page, plan, dashboard, data table, or PR brief, or says "帮我做个报告/页面/仪表盘". For quick in-conversation visuals use show-me; for throwaway prototypes use prototype.
---

# Artifact

Produce a standalone HTML deliverable: one file, self-contained down to the byte, that opens in a browser and can be handed to someone else as-is. Byte-level self-containment is the hard constraint — no external stylesheet, script, font, or image, and nothing fetched to render it.

## Process

### 1. Decide the shape

- **prose-page** — a document read top to bottom: report, analysis, writeup, memo, spec, explainer, plan.
- **data-page** — a page scanned for numbers: dashboard, data table.
- **pr-brief** — a PR review briefing.

Read `references/slot-library.md` for the shape's slots and its template status. v1 ships one template — `references/template-prose.html` — and it serves the prose shapes (report, explainer, plan). The data shapes (dashboard, data table) are hand-rolled from the slot knowledge plus the design constitution.

### 2. Read the design constitution

Read `references/design.md` before writing any markup. It governs every shape: token structure, type, spacing, copy, and the anti-default rules.

### 3. Produce the page

- **prose-page** — copy `references/template-prose.html` and fill every `<!-- SLOT: ... -->` marker. Each marker's comment says what goes there; the placeholder text after the comment is replaced too, not just the comment. Delete optional blocks (takeaways, appendix) rather than leaving them empty.
- **any other shape** — hand-roll it following the slot knowledge and `design.md`.

Either way the result is one byte-self-contained HTML file.

### 4. Self-check

1. No `SLOT` markers and no placeholder text left.
2. Every table-of-contents anchor points at a section id that exists.
3. One file, zero external resources.

### 5. Save it

Write it to `.hapilon/artifacts/YYYY-MM-DD-<slug>.html`. If the user names a location, use that instead. When the user explicitly wants it kept in or shared with the repo, put it in `docs/artifacts/` instead. If the target repo has a `.gitignore`, make sure `.hapilon/` is in it.

### 6. Open it

`open` the file and tell the user its path.

## PR briefs

Read `references/pr-brief-rules.md` before gathering the PR, and follow it for the whole build. Record the PR's head SHA at generation time as the page's staleness anchor, so a later reader can tell whether the branch moved under the briefing.
