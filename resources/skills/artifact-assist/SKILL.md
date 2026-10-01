---
name: artifact-assist
description: Context-aware design assistance for users who are weak at frontend, UI/UX, or visual design. Use the current conversation to determine what an HTML artifact should communicate, how its information and interactions should be structured, and what visual direction fits the task. Make routine design decisions autonomously, ask only when an unresolved choice materially changes the result, then produce an artifact-ready prompt. Also use to critique an artifact or turn vague visual feedback into a concrete refinement prompt.
---

# Artifact Assist

Turn an underspecified need for a visual deliverable into a clear design direction and an artifact-ready prompt.

The user should not need frontend knowledge, design vocabulary, or a pre-existing visual concept. Read the context, do the design reasoning, and hand `artifact` the intent it needs to produce the page.

`artifact-assist` designs the artifact. `artifact` implements it.

## Process

### 1. Read the context

Start from the conversation, not from a design questionnaire.

Extract what is already known:

- what the artifact is for;
- who will use or read it;
- what they need to understand, decide, inspect, or do;
- the important entities, data, states, actions, and constraints;
- the expected environment or delivery context;
- any existing product, technical, brand, or content constraints;
- any references, screenshots, pages, or visual feedback the user has supplied.

Do not assume the artifact is a backend tool, dashboard, or application UI. Infer its shape from the actual task.

Do not ask the user to repeat information already present in the conversation.

### 2. Infer the artifact

Decide what the artifact needs to accomplish before deciding how it should look.

Determine:

- **purpose** — the job the artifact performs;
- **audience** — who needs to use or understand it;
- **primary question** — what should become clear first;
- **information hierarchy** — what is primary, supporting, contextual, or optional;
- **interaction model** — what the reader can inspect, filter, compare, navigate, or act on;
- **content density** — how much should be visible at once;
- **artifact character** — operational, analytical, explanatory, editorial, executive, exploratory, promotional, or another appropriate mode;
- **responsive priority** — what must survive when space becomes constrained.

Infer these from context whenever possible.

Do not turn conventional design decisions into user questions.

### 3. Design the experience

Design from task structure outward.

Choose an appropriate:

- page structure;
- section order;
- information grouping;
- navigation model;
- component vocabulary;
- data presentation;
- interaction hierarchy;
- progressive disclosure strategy;
- empty, loading, error, unknown, and exceptional states where relevant;
- responsive behavior;
- visual direction.

Prefer established interaction patterns when they fit the task. Novelty is not a goal.

The first screen should make the artifact's primary purpose legible. The strongest visual emphasis should correspond to the most important information or action, not to decoration.

For data-heavy artifacts, optimize for scanning, comparison, and anomaly detection.

For prose-heavy artifacts, optimize for reading rhythm, hierarchy, and comprehension.

For interactive tools, optimize for task completion, state visibility, feedback, and recovery.

For mixed artifacts, establish a clear dominant mode rather than giving every section equal visual weight.

#### Visual direction

When the appropriate visual direction is not obvious from the task alone, read `references/visual-directions.md`.

Use it as a vocabulary of design principles and tradeoffs, not as a theme picker or preset library.

Select or combine traits according to the artifact's purpose, audience, information density, interaction model, and viewing environment. A named direction may contribute one useful property without determining the entire artifact.

Do not ask the user to choose a named direction unless visual preference itself materially affects the result.

Do not pass direction names to `artifact` as unexplained styling instructions. Translate them into the design intent that matters for this artifact.

For example, prefer:

> Use a dense, disciplined analytical layout with strong comparison structure and restrained semantic emphasis.

over:

> Make it Swiss Grid + Finance Brief.

### 4. Decide before asking

Default to designing, not interviewing.

Make the decision yourself when:

- the context strongly implies the answer;
- a mature UI or information-design convention applies;
- the choice has low impact on the artifact's usefulness;
- `artifact` and its design constitution can resolve the implementation detail;
- multiple choices are acceptable and one can be selected without meaningful risk.

Ask only when missing information creates materially different artifacts.

Good questions are factual or consequential:

- Is this for internal operators or external customers?
- Is the artifact primarily viewed on a desktop or presented on a large screen?
- Can users perform actions here, or is this read-only?
- Does this need to match an existing product or brand?

Do not ask open-ended aesthetic questions such as:

- What style do you want?
- What colors do you like?
- Should it look modern?
- Do you prefer cards or a table?
- How much border radius do you want?

If the user does not know, that is not missing information. It is a design decision.

### 5. Resolve real design forks

Sometimes more than one direction is genuinely plausible.

If the difference materially changes information density, hierarchy, interaction, or communication strategy, present 2–3 concrete directions and explain the consequence of each.

Prefer semantic choices:

- dense operational view vs. guided overview;
- comparison-first vs. narrative-first;
- persistent detail pane vs. drill-down navigation;
- executive summary vs. analyst workspace.

Do not manufacture choices around superficial styling.

Rendered variants are optional, not the default workflow. Use them when the user cannot evaluate an important design fork from words alone or explicitly wants visual exploration.

Once a direction is clear, continue designing. Do not repeatedly ask for approval on minor decisions.

### 6. Compile the artifact brief

Before handing work to `artifact`, reduce the design reasoning to a concise implementation-independent brief.

Use the sections that matter:

#### Purpose
What the artifact is supposed to accomplish.

#### Audience
Who it is for and what they already understand.

#### Primary question
The first question the artifact should answer.

#### Information hierarchy
The order and relative importance of information.

#### Content and data
The real content, entities, fields, relationships, and states available from context.

#### Primary actions
What the user can or should do, ordered by importance.

#### Interaction model
How users navigate, inspect, filter, compare, reveal detail, or take action.

#### Visual direction
Describe the visual intent that follows from the artifact's purpose: density, tone, hierarchy, reading or scanning behavior, semantic emphasis, and any useful traits selected from `references/visual-directions.md`.

Express the traits themselves rather than relying on direction names.

#### States
Relevant loading, empty, error, unknown, success, partial, disabled, or exceptional states.

#### Responsive behavior
What should remain primary, collapse, wrap, scroll, or move when space changes.

#### Constraints
Technical, product, brand, accessibility, content, or delivery constraints already known.

#### Avoid
Patterns that would actively harm this artifact.

Omit sections that add no useful information.

### 7. Hand off to artifact

Turn the brief into an artifact-ready prompt.

Describe **design intent**, not CSS implementation.

Good:

> Build a dense operational page for technical users. The first view should answer what currently requires attention. Lead with system state and exceptions, then the working dataset, then item-level detail. Optimize the main table for scanning and diagnosis. Use semantic emphasis only where it carries meaning. Keep secondary detail available on demand.

Bad:

> Use a #F8F9FA background, 8px border radius, 14px body text, 24px padding, and cards with box-shadow.

Do not duplicate `artifact`'s design constitution, token system, templates, layout mechanics, or HTML rules.

The prompt should tell `artifact`:

- what it is building;
- why;
- for whom;
- what matters most;
- how the experience should behave;
- what visual character supports that goal;
- what must not be lost.

Let `artifact` decide how to express that through its own design rules.

## Working with weak or vague feedback

Users do not need design vocabulary.

Translate intent-level feedback into design consequences.

Examples:

- **"高级一点"** → reduce decorative elements, increase hierarchy through spacing and typography, narrow the color vocabulary, and make emphasis more selective.
- **"太挤了"** → determine whether the problem is actual information density, weak grouping, insufficient whitespace, or excessive chrome before simply enlarging everything.
- **"太空了"** → strengthen useful information density or grouping rather than adding decoration.
- **"看着很乱"** → inspect hierarchy, alignment, competing emphasis, container count, and inconsistent spacing.
- **"重点不明显"** → re-evaluate information hierarchy before changing colors.
- **"有点像 AI 做的"** → run the anti-default review below.

Do not ask the user to restate vague feedback in design terminology.

If the interpretation is ambiguous, make the smallest plausible correction or offer two concrete interpretations.

## Design reference

`references/visual-directions.md` provides reusable visual and information-design vocabulary.

Read it when visual direction requires additional reasoning. Do not read it mechanically for every artifact when the appropriate direction is already clear from context.

The reference informs design reasoning; it does not override the artifact's purpose or `artifact`'s design constitution.

## User-provided visual references

When the user provides a screenshot, page, product, or visual reference, extract the underlying design properties rather than copying pixels.

Look for:

- information density;
- hierarchy;
- composition;
- typography character;
- spacing rhythm;
- container strategy;
- navigation model;
- interaction patterns;
- color semantics;
- data-display conventions;
- degree of visual restraint.

Apply the useful principles to the user's artifact and content.

A reference is evidence of preference, not a command to clone.

## Artifact review

After `artifact` produces a page, review the result against the original intent.

Check in this order:

1. **Purpose** — does the artifact answer the primary question quickly?
2. **Hierarchy** — is visual emphasis aligned with importance?
3. **Comprehension** — can the intended audience understand the structure without explanation?
4. **Interaction** — are important actions discoverable and states visible?
5. **Density** — is the amount of visible information appropriate for the task?
6. **Semantics** — do color, position, typography, and components communicate the right meaning?
7. **Responsive behavior** — does the important content survive constrained widths?
8. **Visual quality** — does anything feel generic, decorative, inconsistent, or machine-generated?

Fix structural problems before cosmetic ones.

When revision is needed, produce a prioritized refinement prompt. Do not return a vague review such as "make it cleaner."

## Anti-default review

Treat these as warning signs, not as a substitute for judgment.

### Structure

- Three equal cards where the content does not naturally have equal importance.
- A wall of cards used where typography, a table, or simple grouping would communicate better.
- Cards nested inside cards without semantic reason.
- Every section placed in its own bordered container.
- Everything centered regardless of reading behavior.
- Repeating eyebrow labels above every heading.
- Large hero areas on task-oriented or data-heavy pages.
- Excessive dashboard KPI tiles that consume space without helping decisions.

### Color and decoration

- Decorative gradients without semantic purpose.
- Purple-blue gradient banners used as generic "modern" styling.
- Glassmorphism, glows, auroras, or floating blobs that do not communicate anything.
- Accent colors applied everywhere until nothing is emphasized.
- Red and green used decoratively or as the only carrier of status meaning.
- Pure decoration competing with operational or analytical information.

### Components

- Icons added because empty space felt uncomfortable.
- Emoji used as functional interface icons.
- Mixed icon styles.
- Pills used for ordinary labels that do not represent status, category, filter, or action.
- Progress bars used for values that are not meaningfully progress.
- Charts used when a number, sentence, or table communicates the answer more clearly.

### Typography and numbers

- Decorative or italic headings without a communication reason.
- Too many type sizes or weights competing for hierarchy.
- Monospace applied broadly instead of to content that benefits from it.
- Numeric tables without tabular figures.
- IDs, timestamps, errors, and machine-oriented values formatted in ways that reduce scanning.

### Responsive behavior

- Desktop composition merely shrunk onto mobile.
- Important information disappearing before secondary decoration.
- Uncontrolled horizontal overflow.
- Tables made unreadable just to avoid horizontal scrolling.
- Controls wrapping into an ambiguous order.

Do not mechanically eliminate every pattern on this list. Eliminate patterns that do not earn their place.

## Integrity

Never invent content or data to make a design look complete.

- Do not fabricate metrics, labels, records, trends, quotes, or status values.
- Preserve meaningful zero values.
- Distinguish `0`, empty, unavailable, unknown, and not applicable.
- Use `—`, `Unknown`, `Not available`, or another context-appropriate state when information is missing.
- Do not hide uncertainty through visual polish.
- Do not leave placeholder copy in a deliverable.

If realistic structure is useful but real data is unavailable, design the structure without pretending sample values are real.

## Boundaries

`artifact-assist` owns:

- interpreting the current context;
- inferring artifact intent;
- product and UX reasoning;
- information architecture;
- interaction strategy;
- high-level visual direction;
- resolving meaningful design forks;
- compiling artifact-ready prompts;
- reviewing results and producing refinement prompts.

`artifact` owns:

- its design constitution;
- visual tokens;
- detailed typography and spacing;
- templates and slots;
- HTML and CSS implementation;
- self-containment;
- implementation-level quality checks;
- saving and opening the final deliverable.

Do not compete with `artifact` on implementation details.

The handoff contract is simple:

**`artifact-assist` decides what the artifact should be and how it should work. `artifact` decides how to render it well.**