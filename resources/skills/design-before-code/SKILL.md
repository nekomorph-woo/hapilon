---
name: design-before-code
description: Turn a confirmed requirement into a small, coherent design before implementation — frame the scope, trace the end-to-end flow, derive the model and boundaries, then challenge it and plan verifiable steps. Use when planning a feature, change, or system design, before any code is written.
disable-model-invocation: true
---

# Design Before Code

## Purpose

Help turn a confirmed requirement into a small, coherent design before implementation.

The goal is not to design the complete future system. Build enough shared understanding that the human can make the important decisions and AI can implement with clear constraints.

Do not write production code unless explicitly asked.

## Principles

- Design for the current confirmed business need, not imagined future requirements.
- Make the main end-to-end flow coherent before going deep into local details.
- Prefer the smallest design that preserves clear semantics, ownership, and important constraints.
- Avoid speculative abstractions, extension points, and framework-driven structure.
- Let new requirements evolve the design when they actually arrive.
- AI should explore options, expose risks, and challenge assumptions. The human owns important tradeoffs and final decisions.

## Workflow

### 1. Frame

Clarify the current design scope:

- Who needs what?
- What outcome must this iteration achieve?
- What is explicitly out of scope?
- What assumptions or unknowns could materially affect the design?

Keep the problem space separate from implementation choices.

### 2. Flow

Describe the smallest meaningful end-to-end flow that delivers the required outcome.

Start with the normal path. Make sure it reaches a real completion point before expanding into secondary cases.

Identify only the failure or alternative paths required for the current flow to be trustworthy.

### 3. Model

Derive the concepts and rules required by the flow:

- Core business concepts
- Important relationships
- Data or state that must persist
- Rules and invariants that must remain true

Do not model concepts solely because they may be useful later.

### 4. Boundaries

Decide where important responsibilities belong:

- Who owns important data and behavior?
- Where do side effects happen?
- Which components or external systems must interact?
- Which boundaries need an explicit contract?

Define only boundaries required by the current flow.

### 5. Challenge

Before committing to the design, ask AI to attack it:

- What assumption may be wrong?
- What important case is missing?
- Is any responsibility unclear or duplicated?
- Is any abstraction unnecessary?
- Can the design be simpler without losing correctness?
- What decision would be expensive to reverse?

Separate real current risks from hypothetical future concerns.

### 6. Plan

Turn the accepted design into small vertical, verifiable implementation steps.

For each step define:

- Goal
- Expected behavior
- Relevant area
- Important constraints
- How it will be verified

Prefer capabilities over file-writing tasks.

## Human Checkpoint

Before implementation, summarize:

- Current scope
- End-to-end flow
- Core model
- Important invariants
- Responsibility boundaries
- Key design decisions
- Implementation sequence
- Remaining risks or unknowns

If an unresolved decision materially affects the next step, stop for human judgment.

Otherwise mark:

`READY FOR IMPLEMENTATION`

## Guardrails

- Do not design the complete future system.
- Do not add abstractions only for possible future reuse.
- Do not expand every edge case automatically.
- Do not confuse implementation structure with business design.
- Do not silently make important product or architecture decisions.
- Do not mechanically complete every stage when a human decision is needed.

## Communication

Use plain, concrete language.

- Explain unfamiliar project terms and abbreviations on first use.
- Prefer concrete flows and responsibilities over abstract jargon.
- Separate known facts, assumptions, and unknowns.
- Avoid invented terminology, slogans, filler, repeated summaries, and unnecessary headings.
- Start simple and add detail only when it helps the current decision.



