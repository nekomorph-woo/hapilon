---
name: eli15
description: Explain a topic to a cross-domain colleague — a professional who knows software and their own field, but not this domain. Industry common knowledge is assumed; this domain's terms are still explained. One self-contained HTML page. Use when the user types /eli15 <topic> or asks for an explainer aimed at colleagues from another field. See eli5 for zero-background readers, eli60 for domain experts.
---

# eli15

Explain like I'm a professional from a neighboring field: I know how software works, I just don't know this domain. One self-contained HTML page — mechanics over analogies, tradeoffs included.

Topic: Use the topic supplied by the user after `/skill:eli15` (Pi appends it as a `User:` line).

## How

The reader's existing knowledge is an asset — use it. Software concepts (APIs, caching, state machines, tests), industry practices, and general engineering intuition can be referenced without explanation. What they don't have is **this domain's vocabulary and its hard-won context** — that is exactly what you explain.

Content, in this order of priority:

1. The problem this domain thing solves, and what people did before it existed (motivation carries the reader across the domain boundary).
2. The real mechanism — no analogy detour needed; a labeled structure or flow diagram beats an oversimplified metaphor for this reader.
3. New domain terms, explained where they first appear, then used consistently. Assume anything outside the domain (HTTP, latency, reviews) needs zero explanation.
4. Boundaries, tradeoffs, and failure modes — this reader will make decisions based on your page, so the edges matter as much as the center.
5. A short close that states the core relationship to remember.

Keep the causal chain explicit: condition → what happens → effect. Prefer a few connected concepts over a pile of facts. Don't drop qualifiers that change meaning just to stay "brief".

## Accuracy

- An analogy is optional here; when used, mark where it stops matching — but the reader's engineering intuition usually lets you go straight to the mechanism.
- Domain terms, once introduced, keep one meaning for the whole page.
- If a common misconception leads this kind of reader to a wrong call (e.g. treating a best-effort guarantee as a contract), correct it explicitly.
- Distinguish what the source wrote, what you inferred, and what is unverified.
- Verify cold or high-stakes facts against authoritative sources; keep the useful source links in the page.

## Visuals

Same discipline as all explainer tiers — the visual form follows the content:

- structure or hierarchy → labeled diagram;
- comparison → side-by-side cards or table;
- process or data flow → flowchart;
- state change → state diagram.

Visuals are part of the explanation, not decoration: one clear point per visual, readable labels, accessible markers (`role="img"` / `aria-label`). Animation only when motion itself explains a flow or state transition, with a static fallback and `prefers-reduced-motion: reduce` respected.

Before producing the page, read the **artifact** skill's `references/design.md`, and hold to the non-negotiables: token-driven background, colors from the token set only, zero network assets, inline SVG in `<figure>`/`<figcaption>`.

## Produce it

Write the page, then self-check:

1. No placeholder text; every anchor points at a real section id.
2. One file, zero external resources.
3. The page answers: what problem does this solve, how does it work, where are the edges.
4. Every domain term is introduced where it first appears; no industry common knowledge is over-explained.
5. Tradeoffs and failure modes are present, not just the happy path.

Save it to `.hapilon/eli15/<topic>.html` — if the target repo has a `.gitignore`, make sure `.hapilon/` is in it. If the user names a location, use that instead. Then `open` the file for the user and give them the path.
