---
name: eli5
description: Explain a topic like I'm a 5 year old. Use when the user types /eli5 <topic> or asks for a dead-simple picture explainer of how something works.
---

# eli5

Explain like I'm someone who knows nothing about this topic: one self-contained HTML page, big pictures and few words.

Topic: Use the topic supplied by the user after `/skill:eli5` (Pi appends it as a `User:` line).

## How

Speak the domain's language, not the code's. The reader has never seen the system, so every label names something they can point at, never the module it lives in. Each step is one picture and one short caption — if a step needs a paragraph, it is two steps. Move in order: what the thing is, what it does, then the one mechanism that makes it click.

Before producing the page, read the **artifact** skill's `references/design.md`, and hold to the non-negotiables even if you skip the rest:

- body paints an explicit background from tokens;
- every color comes from the token set, never defined only inside an `@media` block;
- zero network assets (no font CDNs, no external images);
- figures are inline SVG wrapped in `<figure>`/`<figcaption>` with `role="img"` + `aria-label`.

## Produce it

Write the page, then self-check it before it goes anywhere:

1. No `SLOT` markers or placeholder text left.
2. Every table-of-contents anchor points at a section id that exists.
3. One file, zero external resources.

Save it to `.hapilon/eli5/<topic>.html` — if the target repo has a `.gitignore`, make sure `.hapilon/` is in it. If the user names a location, use that instead. Then `open` the file for the user and give them the path.
