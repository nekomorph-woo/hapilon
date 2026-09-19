---
name: ask
description: Answer a question with the investigation its type deserves — fact, project code, root cause, business rule, trade-off, how-to, or blast radius. Use when the user asks 为什么 / 怎么 / 根因 / 在哪 / 影响 / 哪个好 / 怎么配, asks what/how/why something works, or invokes /ask or /skill:ask. Not for implementation requests ("fix it", "add X") — those are editing work, not a question.
disable-model-invocation: true
---

# Ask

A question is not an edit request. Answer it, with the investigation its **type** demands — then stop. Change code only when the user asks for a change, not because answering touched the files.

## Route the question

Identify the type first, then follow that row's discipline. Mixed questions are answered type by type.

| Type | Signals | Investigation discipline | Reuse |
|------|---------|------------------------|-------|
| **Fact / technical knowledge** | what is X, does X support Y, which version, what's the default | Cite first-party sources only — official docs, source, spec — never a secondary write-up. Separate "the docs say" from "I infer". State the version the answer holds for. | `research` skill; `web_search`, `source_check` |
| **Project code / implementation** | how does X work here, where is X, what calls this | Read from the entry point down the real call chain before answering — never from file names or memory. Evidence carries `file:line`. Label each conclusion Observed / Inferred / Unknown. | `understand-this-codebase`; Explore subagent for wide parallel lookups |
| **Debug / root cause** | why does it fail, this is broken, root cause | Reproduce it first. One hypothesis at a time, falsified by the smallest experiment that could kill it. Fix the cause, not the symptom; a "why" answer is a causal chain, not a symptom description. | — |
| **Business logic** | where is the rule that says X, who decides Y, why is Z allowed | Find the code that encodes the rule — the landing point — then walk the causal chain back to the source that set it. | `domain-modeling` (`.hapilon/CONTEXT.md`) |
| **Open / trade-off** | which is better, should we, A vs B, what are the options | List the options, trade off each, give a recommendation — never dodge into "it depends". State what would change the answer. | — |
| **How-to / operation** | how do I run/deploy/configure X | Give executable steps, obtained by actually running it or reading the real config / README — never reconstructed from memory. Mark each step verified or unverified. | `run` skill |
| **Blast radius** | what breaks if I change X, who depends on X, impact of | Enumerate every caller and dependency — sweep the whole repo with parallel greps / subagents, not the one path you already know. Output the affected list. | Explore subagent |

## Crossing disciplines — every type

- **Measure, don't guess.** Any number or fact a grep or a command can produce, produce it: counts, versions, line numbers, call sites. Estimate only when nothing can be measured, and say that you estimated.
- **Conclusion first, confidence labeled.** The first sentence is the answer. Keep Confirmed / Inferred / Guessed distinct, and name what you did *not* verify.
- **Stamp the time.** Technical answers: the version they apply to. Project answers: the HEAD / working-tree state they rest on, and whether the tree was dirty.
