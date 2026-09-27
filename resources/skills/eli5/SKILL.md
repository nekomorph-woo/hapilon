---
name: eli5
description: Explain a topic like I'm a 5 year old — zero-background reader, every term explained, analogy-friendly, one self-contained HTML page of big pictures and few words. Use when the user types /eli5 <topic> or asks for a dead-simple picture explainer. For readers with background, see eli15 / eli60.
---

# eli5

Explain like I'm someone who has never seen this system: one self-contained HTML page, big pictures and few words. The reader should walk away with a correct mental model — not a memorized one-liner.

Topic: Use the topic supplied by the user after `/skill:eli5` (Pi appends it as a `User:` line).

## How

Speak the domain's language, not the code's — use the established terms from `.hapilon/CONTEXT.md` when the project has a glossary. Every label names something the reader can point at, never the module it lives in.

Content is a menu, not a template — pick what the topic needs, in this order of priority:

1. One sentence: what the thing is.
2. What problem it solves, and why that problem exists at all (motivation before mechanism).
3. A concrete scene or analogy. Mark analogies as analogies, and say where they stop matching reality — an analogy that pretends to be the mechanism is a lie.
4. The one mechanism that makes it click. One picture, one short caption — if a step needs a paragraph, it is two steps.
5. The single most misleading boundary or tradeoff. Zero-background readers can carry one, not five — pick the one that would hurt them most if they got it wrong.

Explain every term in plain words the first time it appears, then keep the word consistent. If a common misunderstanding would break the reader's mental model, correct it explicitly.

Before producing the page, read the **artifact** skill's `references/design.md`, and hold to the non-negotiables even if you skip the rest:

- body paints an explicit background from tokens;
- every color comes from the token set, never defined only inside an `@media` block;
- zero network assets (no font CDNs, no external images);
- figures are inline SVG wrapped in `<figure>`/`<figcaption>` with `role="img"` + `aria-label`.

## Visuals

Pick the visual form that carries the meaning — visuals are part of the explanation, not decoration:

- structure or hierarchy → labeled diagram;
- comparison → side-by-side cards or table;
- process or data flow → flowchart;
- state change → state diagram.

Each step is one picture with one clear point. If a section would be mostly prose, ask what the picture for it is — not how to format the prose.

## Produce it

Write the page, then self-check it before it goes anywhere:

1. No `SLOT` markers or placeholder text left.
2. Every table-of-contents anchor points at a section id that exists.
3. One file, zero external resources.
4. The page answers: what is it, what problem does it solve, how does it work, where does the analogy stop.
5. Every term the reader meets is explained where it first appears.

Save it to `.hapilon/eli5/<topic>.html` — if the target repo has a `.gitignore`, make sure `.hapilon/` is in it. If the user names a location, use that instead. Then `open` the file for the user and give them the path.
