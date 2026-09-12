---
name: understand-this-codebase
description: Build a minimum sufficient mental model of an unfamiliar codebase, domain, feature, or runtime flow. Use when onboarding to a repo, investigating how something works, or preparing for a change.
---

# Understand This Codebase

## Purpose

Build a useful mental model of **any unfamiliar or partially understood code**, without requiring the human to read everything.

The scope may be an entire repository, a large business domain, one feature, one service, one runtime flow, or a specific planned change.

The goal is not exhaustive understanding. The goal is the **Minimum Sufficient Mental Model**:

> Understand enough of the relevant system to navigate it, reason about it, change it safely, and know where to investigate next.

Use progressive disclosure:

**Scope → Map → Boundaries → Flows → Invariants → Risks → Deep Dive**

## Core Principles

- **Minimum Sufficient Mental Model:** understand only what is needed for the current purpose.
- **Minimum Cognitive Load:** transfer knowledge without making the human decode the explanation.
- Build a mental model, not a file catalog.
- Explain architecture before implementation details.
- Explain behavior through flows, not isolated functions.
- Prefer selective understanding over exhaustive reading.
- Treat unrelated parts of a large repository as opaque unless they affect the current scope.
- Separate business logic from infrastructure.
- Distinguish facts from inference.
- Spend human attention according to risk.
- Cite concrete files, classes, functions, tables, or tests when making important claims.
- If ownership or architecture is unclear, say so instead of inventing a cleaner design than the code actually has.

## Workflow

### 0. Scope — What do I need to understand?

Determine the understanding scope before exploring deeply.

The scope may be:

- Entire codebase
- Business domain
- Feature
- Module or service
- Runtime flow
- Specific bug
- Specific planned change

When a scope is provided, **do not explain the entire codebase**.

Explore outside the scope only when necessary to understand:

- Upstream triggers
- Downstream effects
- Shared data
- Cross-boundary invariants
- External dependencies
- Side effects

Treat unrelated parts of the repository as opaque.

If investigation reveals an important dependency outside the current scope, expand the scope only as far as necessary and explain why.

### 1. Map — Give me the territory

Within the chosen scope, identify:

- Major modules/directories
- Entry points
- Core business logic
- Infrastructure
- External integrations
- Persistence
- Important shared code

For every important component explain in one sentence:

> What responsibility does this own?

Then show a compact architecture or relationship diagram.

Do not dump the directory tree unless the directory structure itself explains the architecture.

### 2. Boundaries — How is this divided?

For each important component identify:

- Responsibility
- Public interface
- Dependencies
- Data ownership
- Side effects
- What it should not be responsible for, when this can be established

Highlight suspicious coupling, unclear ownership, or boundaries that appear to leak.

### 3. Flows — How does it actually run?

Identify the most important end-to-end flows for the current scope, usually 1–5.

For each flow show:

`Trigger → Entry → Coordination → Business Rules → Persistence / External Systems → Result`

Reference relevant files/functions so the human can jump directly into implementation.

Prefer execution paths over isolated file explanations.

### 4. Invariants — What must never break?

Identify important rules such as:

- Valid state transitions
- Authorization boundaries
- Data consistency requirements
- Idempotency requirements
- Transaction assumptions
- Ownership rules
- Business constraints

Clearly distinguish:

- **Explicit invariant:** directly enforced by code or tests.
- **Inferred invariant:** appears intended from implementation or usage.
- **Unknown:** cannot be established reliably.

Never present inference as certainty.

### 5. Risks — Where should a human pay attention?

Highlight areas involving:

- Core business rules
- Authentication / authorization
- State machines
- Transactions
- Concurrency
- Caching
- Payments / billing
- Data migrations
- External side effects
- Complex coupling
- Weak or missing tests

Do not exaggerate ordinary complexity into risk.

### 6. Deep Dive — Only when useful

Do not automatically explain the entire scope in implementation-level detail.

When the human wants to understand or change something:

1. Locate the relevant surface.
2. Identify upstream callers or triggers.
3. Identify downstream dependencies and side effects.
4. Identify relevant invariants.
5. Identify tests covering the behavior.
6. Explain the execution path.
7. Inspect implementation details only where they affect understanding or correctness.

Use diagrams, pseudocode, state diagrams, or simplified explanations when they communicate better than prose.

## Change Mode

When the goal is to modify an existing feature, switch from broad reconnaissance to:

**Change → Surface → Dependencies → Invariants → Plan → Implement → Verify**

Before implementation explain:

### Change Surface
What code is likely affected?

### Current Behavior
What happens today?

### Dependencies
What calls this, and what does it call?

### Invariants
What must remain true?

### Risk
What could unintentionally break?

### Verification
How will we know the change is correct?

Then implement when requested.

After implementation, compare the actual change against the predicted change surface and report unexpected architectural impact.

## Communication Rules

Optimize for **human understanding, not impressive-sounding explanations**.

### Translate before teaching

Repositories often contain historical names, abbreviations, jargon, or unclear abstractions.

First translate them into plain language. Preserve the real identifier so the human can search for it, but do not force the human to understand the identifier before understanding the concept.

Example:

> `ChangeSet` — this project's representation of a group of code changes waiting for review.

If the meaning cannot be established from code or tests, say so.

### Use plain language

- Prefer common, concrete words over jargon.
- Do not use technical terms when ordinary language communicates the same idea.
- Explain useful technical terms briefly on first use.
- Never assume the reader knows project-specific vocabulary.

Prefer:

> When the user clicks Refund, the API loads the order, checks whether it can be refunded, calls the payment provider, and records the result.

Instead of:

> The refund workflow orchestrates multiple domain and infrastructure concerns across service boundaries.

### Expand unfamiliar abbreviations

Do not introduce unexplained abbreviations or acronyms.

On first use:

> Role-Based Access Control (RBAC)

After that, `RBAC` is acceptable.

Common terms such as HTTP, API, SQL, JSON, URL, and ID usually do not need expansion.

Project-specific abbreviations always need explanation.

### Keep identifiers attached to meaning

When mentioning a file, class, function, module, table, event, or service, explain why it matters.

Avoid:

> `RefundCoordinator` calls `PGA` through `RPA`.

Prefer:

> `RefundCoordinator` runs the refund process. It calls `PaymentGatewayAdapter`, the project's wrapper around the external payment provider.

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

Do not make simple concepts sound sophisticated.

### Prefer concrete explanations

Whenever possible explain:

**Who → does what → to what → under what condition → with what result**

### Make diagrams readable

Every diagram should be understandable without first learning internal project vocabulary.

If an identifier is obscure, annotate it:

```text
Checkout
   ↓
CouponSvc
(coupon validation)
   ↓
Order
```

Do not create diagrams made entirely from unexplained internal identifiers.

### Progressive detail

Use this order when possible:

**Purpose → Flow → Components → Rules → Implementation Details**

Start with the simplest useful explanation. Add details only when they help answer the current question.

### Separate facts from interpretation

Use clear confidence:

- **Observed:** directly supported by code, configuration, or tests.
- **Inferred:** likely intent based on implementation.
- **Unknown:** cannot be determined reliably.

When code and documentation disagree, prefer executable behavior and tests as evidence of current behavior, but explicitly report the disagreement.

### Explanation quality check

Before finishing, check:

> Could an engineer unfamiliar with this repository understand the explanation without asking what half the terminology means?

If not, simplify it.

The goal is not to demonstrate knowledge of the codebase.

The goal is to transfer that knowledge with minimum unnecessary cognitive load.

## Default Output

Keep initial reconnaissance compact.

### Scope
What is being understood and what is intentionally outside the current scope.

### System in One Paragraph
What this part of the system does and how it broadly works.

### Map
A small diagram showing important components and dependency direction.

### Components
Major components and one-line responsibilities.

### Critical Flows
The most important runtime paths for this scope.

### Data & State
Where important data originates, changes, and persists.

### Invariants
Rules the system appears to protect, with certainty clearly marked.

### Risk Zones
Areas deserving deeper human understanding.

### Where to Look When...
A few concrete navigation hints relevant to the scope, such as:

- Changing a business rule → ...
- Debugging data → ...
- Changing authorization → ...
- Modifying persistence → ...

### Suggested Deep Dives
Recommend only the 2–5 areas most valuable to understand next and explain why.

Then **stop**.

Do not automatically produce exhaustive explanations.

The desired result is:

> The human does not know every line. They know where important behavior lives, how the relevant system fits together, what must not break, and where to investigate when change happens.
