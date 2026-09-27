---
name: eli60
description: Explain a topic to a domain expert — terms used directly with zero preamble, focused on mechanisms, tradeoffs, failure modes, and alternatives. The shortest and densest tier. One self-contained HTML page. Use when the user types /eli60 <topic> or asks for an expert-level explainer of something in this domain. See eli5 / eli15 for readers without domain background.
---

# eli60

Explain like I work on this every day: no definitions, no motivation, no analogy. The reader knows the vocabulary and the history — what they don't know (or have wrong) is a specific mechanism, tradeoff, or edge. One self-contained HTML page, short and dense.

Topic: Use the topic supplied by the user after `/skill:eli60` (Pi appends it as a `User:` line).

## How

Motivation sections are dead weight for this reader — cut them. Spend the entire page on what an expert actually gets value from:

1. The mechanism, precisely — including the part that is easy to picture wrong.
2. Tradeoffs: what this design gives up, and what it buys with that. An expert trusts a page that names its costs.
3. Failure modes and the boundaries where the behavior changes qualitatively.
4. Alternatives: what else solves this, and the concrete reason this one wins (or loses) here.

If the topic is contested or the reader may hold a wrong mental model, lead with the disambiguation — "X is not Y, the difference matters because …". Everything else follows from it.

Distinguish three registers and never mix them: what the source states, what you infer, what is unverified. An expert reader will weight your claims by this — mislabeling an inference as a stated fact is the fastest way to lose them.

## Visuals

One visual, maybe two — only the relation that is genuinely hard to hold in one's head (a state machine, a tradeoff matrix, a before/after of the mechanism). Flowcharts of what the reader already knows are padding.

Same production rules as all explainer tiers: read the **artifact** skill's `references/design.md` first and hold to the non-negotiables (token background, colors from tokens only, zero network assets, inline SVG in `<figure>`/`<figcaption>` with `role="img"` / `aria-label`). Animation only when it explains a transition the reader has specifically gotten wrong before; static fallback and `prefers-reduced-motion: reduce` respected.

## Produce it

Write the page, then self-check:

1. No placeholder text; every anchor points at a real section id.
2. One file, zero external resources.
3. Zero preamble — the page never explains a term the reader already owns or motivates a problem they already feel.
4. Tradeoffs and failure modes are explicit; nothing reads as a free lunch.
5. Stated / inferred / unverified are distinguishable throughout.

Save it to `.hapilon/eli60/<topic>.html` — if the target repo has a `.gitignore`, make sure `.hapilon/` is in it. If the user names a location, use that instead. Then `open` the file for the user and give them the path.
