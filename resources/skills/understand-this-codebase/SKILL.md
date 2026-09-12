---
name: understand-this-codebase
description: Build the minimum useful mental model of unfamiliar or partially understood code — scoped to the current goal, following end-to-end flows rather than file lists, with conclusions labeled Observed / Inferred / Unknown. Use when onboarding to a repo, investigating how a feature or runtime flow works, or preparing a change.
---

# Understand This Codebase

## Purpose

Build the minimum useful mental model of unfamiliar or partially understood code.

The goal is not to read or explain everything. Understand enough of the relevant system to navigate it, reason about it, make a change safely, and know where to investigate next.

## Principles

- Scope understanding to the current goal.
- Treat unrelated parts of a large codebase as opaque unless they affect the current scope.
- Understand behavior and architecture before low-level implementation details.
- Prefer end-to-end flows over file-by-file explanations.
- Spend attention according to business importance and risk.
- Distinguish what the code proves from what is only inferred.

## Workflow

### 1. Scope

Determine what needs to be understood:

- Whole system
- Business area
- Feature
- Module or service
- Runtime flow
- Bug
- Planned change

When a scope exists, do not explain the whole repository.

Expand outside it only when necessary to understand upstream triggers, downstream effects, shared data, important constraints, or external dependencies.

### 2. Map

Build a compact map of the relevant area:

- Entry points
- Important components
- Business logic
- Persistence
- Infrastructure
- External integrations

Explain each important component by responsibility, not merely by filename.

Use a small diagram when it makes the relationships easier to understand.

### 3. Trace

Follow the most important end-to-end flows for the current goal.

For each flow explain:

- What triggers it
- Where it enters
- Which components participate
- Where important decisions happen
- What data changes
- Which side effects occur
- What result is produced

Reference concrete files, classes, functions, or tests when useful.

### 4. Boundaries

Identify:

- Who owns important behavior and data
- Important dependencies
- Public interfaces or contracts
- Side-effect boundaries
- Suspicious coupling or unclear ownership

Do not invent a cleaner architecture than the repository actually has.

### 5. Rules

Identify the constraints that matter to the current scope:

- Business rules
- Important invariants
- Consistency assumptions
- Authorization or ownership rules
- Other conditions that must remain true

Label conclusions as:

- **Observed** — directly supported by code, configuration, or tests.
- **Inferred** — likely intent based on evidence.
- **Unknown** — cannot be established reliably.

### 6. Risk & Next Depth

Highlight only the areas where deeper understanding is valuable:

- Core business behavior
- Important side effects
- Data consistency
- Concurrency or transactions
- Security boundaries
- Complex coupling
- Weak or missing tests

Recommend a small number of useful deep dives, then stop.

## Change Mode

When the goal is a specific change, focus the analysis around:

**Current Behavior → Change Surface → Dependencies → Invariants → Risks → Verification**

Understand only enough surrounding code to make the change safely.

After implementation, compare the actual change with the expected change surface and report meaningful unexpected impact.

## Default Output

Keep the first pass compact:

1. Scope
2. System in one paragraph
3. Relevant map
4. Critical flows
5. Important rules and invariants
6. Risk areas
7. Where to look next

Do not automatically continue into exhaustive implementation details.

## Guardrails

- Do not dump the repository tree.
- Do not explain unrelated modules.
- Do not equate a list of files with understanding.
- Do not hide uncertainty behind confident language.
- Do not expand into deep implementation details unless they help the current goal.
- Stop when the human has enough context to make the next decision.

## Communication

Use plain, concrete language.

- Translate unclear project terminology into plain language while preserving real identifiers for search.
- Explain unfamiliar abbreviations on first use.
- Prefer concrete execution flows over abstract descriptions.
- Keep identifiers attached to their meaning and responsibility.
- Separate observed facts, inference, and unknowns.
- Avoid invented terminology, slogans, filler, repeated summaries, and unnecessary headings.
- Start simple and add detail only when needed.

