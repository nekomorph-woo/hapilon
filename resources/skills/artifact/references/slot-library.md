# Slot library

What each deliverable shape needs, condensed from the builtin artifact templates. The status line says whether a v1 template exists for it.

## report — v1 template available

Source: artifact-report.

- Shape: masthead, table of contents, prose sections, optional appendix.
- Slots: `TITLE`, `SUBTITLE`, `KEY_TAKEAWAYS` (optional — 3–5 bullets, one line each, a single clause carrying its number or specific), `TOC_ITEMS` (fill **after** the sections, from the headings actually written), `SECTIONS` (one `<section id>` per topic, `<h2>` plus prose, with `<h3>` / `<table>` / `<pre>` / `<blockquote>` / `<figure>` inside), `APPENDIX` (optional).
- Discipline: the reader's attention is the scarcest resource a report consumes. Lead each section with its conclusion; push details, methodology, and raw data after it or into the appendix.
- Template: `template-prose.html`.

## explainer — v1 template available (prose template variant)

Source: artifact-explainer.

- Shape: a lede stating what the reader will learn, then numbered steps that each pair a short explanation with a visual, ending with a recap.
- Two structures — keep one, delete the other: **number of steps** — the default, a progression the reader follows start to finish (concept explainers, how something works); or **sections** — a looser tour of a system, change, or architecture, where code carries more weight.
- Discipline: default to a diagram per step — the reader grasps structure and flow from the picture before parsing the prose, so an explainer that is mostly text underuses the format. Reach for a code block or a small table alone only when the concept is genuinely symbolic.
- Template: `template-prose.html`, restructured into steps.

## plan — v1 template available (prose template variant)

Source: plan-artifact.

- Shape: the standard plan treatment — every plan shares one shell so plans read as a family: same type system, same palette, same rhythm in light and dark.
- Discipline: always start from the template; the shell is the consistency. Edit content only, and add or remove whole sections so the document matches the plan's actual structure.
- Template: `template-prose.html`.

## dashboard — not yet templated — hand-roll following design.md

Source: artifact-dashboard.

- Shape: the three-piece kit — KPI tiles (2–5 headline numbers), one primary time-series chart, a breakdown table. Slot-table driven.
- Discipline: replace every placeholder number with real data, never invent one — a fabricated trend is worse than no chart. No time dimension means no time axis. Format numbers for scanning (a unit, 2–3 significant figures, thousands separators). Color deltas by meaning, not direction — a falling latency is good.
- Hand-roll the tiles, chart, and table from `design.md`'s token and layout rules.

## data-table — not yet templated — hand-roll following design.md

Source: artifact-data-table.

- Shape: a filter input, a dense sortable table (click a column header to sort), and a row count, over a dataset embedded in the page.
- Data discipline: values in `num` columns must be JSON numbers — `1234.5`, never `"1,234.50"` or `"$1,234.50"`; strip currency symbols and thousands separators and put the unit in the column label. A missing value is `null`, never `0`, `"N/A"`, or `"-"`. Dates go in text columns as ISO-8601 so alphabetical order is chronological.
- Discipline: the template's value is its mechanics, not its look — the styling can be repainted wholesale while sorting and filtering keep working.
