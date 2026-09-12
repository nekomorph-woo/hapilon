---
name: design-before-code
description: Turn an idea or requirement into a clear engineering model before writing code. Use when planning a major change, new feature, or system design — before implementation begins.
disable-model-invocation: true
---

# Design Before Code

## Purpose

Turn an idea, requirement, or major change into a clear engineering model **before implementation begins**.

The goal is not to create a perfect architecture document. The goal is to make the system understandable enough that a human can own the important decisions while AI handles most implementation details.

**Do not write production code during this process unless explicitly asked.**

## Core Principles

- **Minimum Sufficient Design:** design only what is needed to implement safely and coherently.
- **Minimum Cognitive Load:** explain things in the simplest language that preserves the important meaning.
- Human owns **intent, boundaries, invariants, and important tradeoffs**.
- AI should expose meaningful alternatives instead of silently making important decisions.
- Prefer business language over invented technical terminology.
- Prefer the simplest architecture that satisfies current requirements.
- Avoid speculative abstractions and architecture for hypothetical future needs.
- Distinguish business logic from infrastructure.
- Make important state transitions and side effects explicit.
- Stop for human judgment when an unresolved decision could materially change the system.

## Workflow

**Explore → Model → Design → Contract → Plan → Human Checkpoint**

Keep each stage concise. Spend detail only where a decision, ambiguity, or risk exists.

### 1. Explore — What are we building?

Clarify:

- Who uses it?
- What are their main goals?
- What are the critical use cases?
- What is explicitly out of scope?
- What assumptions are being made?
- What important questions remain unanswered?

Do not prematurely choose technologies, frameworks, patterns, or architecture.

### 2. Model — How does the system behave?

Identify:

- Core entities and concepts
- Relationships between them
- Important states and state transitions
- Business rules
- Invariants that must always remain true
- Important edge cases

Prefer a small state or relationship diagram when it communicates better than prose.

### 3. Design — What owns what?

Define the major modules or components.

For each important module state:

- Responsibility
- What it explicitly does **not** own
- Dependencies
- Data it owns
- Side effects it may perform

Then show:

- System boundaries
- Dependency direction
- Main data flows
- External systems
- Failure boundaries

Architecture should follow the problem and domain, not merely mirror framework conventions.

### 4. Contract — How do the pieces communicate?

Define important boundaries before implementation:

- Inputs
- Outputs
- Interfaces / APIs
- Events, when genuinely useful
- Error behavior
- Ownership
- Side effects

Focus on contracts that allow components to be understood and changed independently.

Do not specify trivial internal implementation details.

### 5. Plan — How should AI build it?

Break implementation into small **vertical, verifiable capabilities**, not arbitrary file-writing tasks.

Each task should contain:

- Goal
- Relevant modules
- Expected behavior
- Constraints
- Acceptance criteria
- Verification method

Prefer:

> User can create and persist a Task.

over:

> Create controller.ts, service.ts, and repository.ts.

Identify work that can safely happen in parallel, but do not split work in ways that obscure ownership or require fragile coordination.

### 6. Human Checkpoint — Are we ready?

Before implementation, summarize:

#### System
- What we are building
- Core model
- Architecture
- Critical flows

#### Decisions
- Important design decisions and why
- Invariants implementation must preserve

#### Plan
- Implementation sequence
- Parallelizable work
- Highest-risk areas

#### Open Questions
- Decisions that still require human judgment

If an unresolved question could materially change architecture, ownership, data, security, or core behavior, **stop and ask before coding**.

Otherwise mark:

`READY FOR IMPLEMENTATION`

## Communication Rules

Optimize for **human understanding, not impressive-sounding explanations**.

### Use plain language

- Prefer common, concrete words over jargon.
- Do not use a technical term when ordinary language communicates the same idea.
- When a technical term is useful, explain it briefly the first time.
- Never assume the reader knows project-specific terminology.

Prefer:

> `OrderService` coordinates the steps needed to create an order.

Instead of:

> `OrderService` serves as the orchestration layer for the order lifecycle.

### Do not invent terminology prematurely

Prefer names already used by the business or user.

If the requirement says:

`Task → Agent Run → Review`

do not casually rename it into abstractions such as:

`ExecutionOrchestrationContext → RuntimeCoordinator → ReviewArtifactPipeline`

Introduce a new term only when a concept genuinely needs a distinct name.

### Expand unfamiliar abbreviations

Do not introduce unexplained abbreviations or acronyms.

On first use:

> Role-Based Access Control (RBAC)

After that, `RBAC` is acceptable.

Common terms such as HTTP, API, SQL, JSON, URL, and ID usually do not need expansion.

Project-specific abbreviations always need explanation.

### Avoid AI writing habits

Avoid:

- slogans and dramatic conclusions
- repeated summaries
- fake quotations
- rhetorical filler
- excessive headings or bold text
- unnecessary analogies
- unexplained buzzwords
- vague words such as "robust", "seamless", "comprehensive", or "leverages" without concrete meaning
- recurring conversational catchphrases

Do not make a simple concept sound sophisticated.

### Prefer concrete explanations

Whenever possible explain:

**Who → does what → to what → under what condition → with what result**

Prefer:

> When the user submits a task, the system creates a workspace, starts the agent, records its result, and waits for review.

Instead of:

> The task pipeline orchestrates multiple domain and infrastructure concerns.

### Progressive detail

Explain in this order when possible:

**Purpose → Behavior → Model → Boundaries → Details**

Start simple. Add detail only when it helps a current decision.

### Separate certainty levels

When discussing an existing constraint or related system, distinguish:

- **Known:** supported by requirements, code, tests, or explicit user input.
- **Assumed:** being used temporarily to move the design forward.
- **Unknown:** requires clarification or investigation.

Never silently convert an assumption into a design fact.

## Output Style

The default output should be compact and decision-oriented.

Use diagrams when they reduce explanation time. Avoid giant architecture documents unless the user explicitly asks for one.

The desired result is:

> A human understands the system well enough to remain its owner, while AI has enough structure to implement it safely.
