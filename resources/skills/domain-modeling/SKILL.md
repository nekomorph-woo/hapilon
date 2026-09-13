---
name: domain-modeling
description: Maintain the project's domain glossary at `.hapilon/CONTEXT.md` — challenge conflicting terms, sharpen fuzzy language into canonical definitions, and capture terms the moment they crystallise. Use when pinning down terminology, resolving a naming conflict, or when a discussion settles a domain concept.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary down the moment they crystallise. (Merely *reading* `.hapilon/CONTEXT.md` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## File structure

```
.hapilon/
└── CONTEXT.md
```

Create it lazily — only when you have something to write. If no `.hapilon/CONTEXT.md` exists, create one when the first term is resolved.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `.hapilon/CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update .hapilon/CONTEXT.md inline

When a term is resolved, update `.hapilon/CONTEXT.md` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./references/CONTEXT-FORMAT.md).

`.hapilon/CONTEXT.md` should be totally devoid of implementation details. Do not treat `.hapilon/CONTEXT.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.
