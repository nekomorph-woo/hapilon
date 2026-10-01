# Visual Directions

A vocabulary of visual and information-design directions for `artifact-assist`.

These are not themes, templates, or presets. They describe useful design traits, tradeoffs, and failure modes that can be selected and combined according to the artifact's purpose.

Use this reference when the appropriate visual direction is not already obvious from the task.

## How to use this reference

Start with the artifact, not with a direction name.

Consider:

- purpose;
- audience;
- primary question;
- information density;
- reading vs. scanning behavior;
- interaction needs;
- presentation environment;
- expected level of formality;
- whether the artifact is primarily narrative, analytical, operational, explanatory, or exploratory.

Then select the traits that support those needs.

A direction may contribute one useful property without determining the entire artifact.

For example:

> A technical analysis page may use the density of Spec Sheet, the comparison discipline of Swiss Grid, and a small amount of Terminal's machine-oriented typography.

Do not treat that as a requirement to visually imitate any of those directions.

Names are shorthand for reasoning, not styling commands.

Do not ask the user to choose a named direction unless visual preference itself materially affects the outcome.

---

# Analytical and structured directions

## Swiss Grid

**Character:** rational, systematic, precise.

**Core traits:**

- strong alignment;
- disciplined grid;
- clear typographic hierarchy;
- asymmetric composition when useful;
- restrained visual vocabulary;
- deliberate use of whitespace;
- strong comparison structure.

**Works well for:**

- analytical summaries;
- comparisons;
- decision documents;
- structured reports;
- technical or strategic explanations;
- pages where relationships between sections matter.

**Use carefully when:**

- long-form prose dominates;
- content hierarchy is highly irregular;
- the material needs a warm or conversational tone.

**Do not reduce it to:**

- red, black, and white;
- giant sans-serif numbers;
- rigid boxes everywhere.

The grid logic and hierarchy matter more than the historical palette.

---

## Spec Sheet

**Character:** dense, functional, exact.

**Core traits:**

- high information density;
- compact spacing;
- explicit labels;
- numbered or strongly structured sections;
- tables and aligned values;
- minimal decorative chrome;
- fast lookup over leisurely reading.

**Works well for:**

- technical specifications;
- inventories;
- audit views;
- test results;
- configuration summaries;
- comparison matrices;
- operational reference pages.

**Use carefully when:**

- the audience is unfamiliar with the domain;
- the artifact needs persuasion or storytelling;
- the primary content is long-form prose.

**Do not reduce it to:**

- making everything small;
- removing all whitespace;
- putting every value in a bordered cell.

Density should improve retrieval, not create visual noise.

---

## Finance Brief

**Character:** authoritative, compact, disciplined.

**Core traits:**

- dense but orderly information;
- restrained emphasis;
- strong numeric hierarchy;
- concise annotations;
- efficient tables;
- clear distinction between headline findings and supporting detail;
- limited, intentional use of accent color.

**Works well for:**

- metric reviews;
- business summaries;
- performance reports;
- financial or operational analysis;
- executive documents with substantial quantitative content.

**Use carefully when:**

- the content is exploratory rather than conclusive;
- the audience needs extensive explanation;
- the artifact is informal or highly interactive.

**Do not reduce it to:**

- red accent color;
- tiny uppercase labels;
- imitating a financial publication.

Its value is disciplined quantitative communication.

---

# Operational and technical directions

## Operational Console

**Character:** immediate, state-aware, efficient.

**Core traits:**

- current state is visible quickly;
- exceptions outrank normal conditions;
- actions appear near the state they affect;
- dense scanning is supported;
- filters and search remain easy to reach;
- feedback is explicit after actions;
- semantic color is reserved for meaningful state.

**Works well for:**

- monitoring;
- administration;
- incident response;
- queues;
- jobs and workers;
- service health;
- internal operational tools.

**Use carefully when:**

- the artifact is primarily explanatory;
- the audience does not understand the operational model;
- actions are rare and reading is the primary task.

**Do not reduce it to:**

- dark mode;
- KPI cards;
- green/red status dots everywhere.

Operational design is about state visibility and action efficiency.

---

## Terminal

**Character:** technical, compact, machine-oriented.

**Core traits:**

- precise alignment;
- compact information;
- strong distinction between human prose and machine output;
- monospace where structure benefits from it;
- clear representation of IDs, commands, logs, paths, errors, and timestamps;
- low decorative overhead.

**Works well for:**

- logs;
- build output;
- developer tooling;
- debugging information;
- command examples;
- machine-generated records.

**Use carefully when:**

- long prose needs comfortable reading;
- the audience is non-technical;
- hierarchy depends on rich visual differentiation.

**Do not reduce it to:**

- black background;
- green text;
- monospace everywhere;
- fake command prompts used as decoration.

Use terminal traits only where machine-oriented content benefits from them.

---

## Blueprint

**Character:** structural, explanatory, engineered.

**Core traits:**

- relationships are more important than decoration;
- clear grouping and connection;
- annotation supports understanding;
- diagrams and structure carry the explanation;
- visual language feels systematic and constructed.

**Works well for:**

- architecture explanations;
- systems;
- workflows;
- process relationships;
- technical overviews;
- dependency maps.

**Use carefully when:**

- the artifact is dominated by tabular data;
- the relationships are simple enough for prose;
- decorative diagram styling would overwhelm the content.

**Do not reduce it to:**

- blue backgrounds;
- grid paper;
- engineering drawing cosplay.

The useful property is structural explanation.

---

# Editorial and explanatory directions

## Editorial

**Character:** narrative, expressive, paced.

**Core traits:**

- strong reading rhythm;
- deliberate transitions between sections;
- typography carries hierarchy;
- selected content receives visual emphasis;
- quotes, images, diagrams, or key facts can interrupt prose meaningfully;
- composition supports a story rather than a uniform grid.

**Works well for:**

- explainers;
- retrospectives;
- external narratives;
- case studies;
- research stories;
- content where sequence matters.

**Use carefully when:**

- users need rapid lookup;
- data density is high;
- frequent interaction is required;
- the content itself is too thin to support editorial pacing.

**Do not reduce it to:**

- serif display fonts;
- oversized pull quotes;
- magazine imitation.

Editorial design is primarily about pacing and narrative hierarchy.

---

## Newspaper

**Character:** information-rich, authoritative, reading-oriented.

**Core traits:**

- strong headline hierarchy;
- multiple levels of information importance;
- compact but readable composition;
- sections can coexist without becoming card walls;
- rules, spacing, and typography organize content;
- good use of columns when the reading environment supports them.

**Works well for:**

- recurring reports;
- summaries with many independent findings;
- briefings;
- news-like updates;
- information-dense reading pages.

**Use carefully when:**

- the page contains highly interactive controls;
- narrow mobile screens dominate;
- large tables are central;
- the content lacks enough substance for layered hierarchy.

**Do not reduce it to:**

- beige backgrounds;
- serif fonts;
- drop caps;
- literal newspaper columns everywhere.

The useful property is layered information hierarchy.

---

## Memo

**Character:** direct, informal, low-friction.

**Core traits:**

- narrow scope;
- straightforward hierarchy;
- minimal ceremony;
- readable prose;
- emphasis through typography rather than containers;
- a sense that the content matters more than presentation.

**Works well for:**

- internal notes;
- short plans;
- decisions;
- meeting summaries;
- lightweight explanations;
- one-purpose documents.

**Use carefully when:**

- the artifact needs executive presence;
- large datasets are involved;
- multiple workflows or interactions are required.

**Do not reduce it to:**

- typewriter fonts;
- fake paper;
- intentionally unfinished styling.

The goal is clarity without ceremony.

---

# Presentation and executive directions

## Annual Report

**Character:** spacious, selective, high-impact.

**Core traits:**

- fewer elements receive stronger emphasis;
- key numbers or findings can dominate a section;
- generous pacing;
- charts and visuals can act as primary evidence;
- supporting detail remains subordinate;
- composition feels intentional at presentation distance.

**Works well for:**

- annual or quarterly summaries;
- major outcomes;
- milestone reviews;
- executive presentations;
- retrospective highlights.

**Use carefully when:**

- users need dense lookup;
- the artifact is used daily;
- the content contains many equally important metrics;
- screen space is limited.

**Do not reduce it to:**

- giant numbers;
- excessive whitespace;
- oversized KPI cards.

Large-scale emphasis only works when the content deserves it.

---

## Executive Brief

**Character:** concise, decision-oriented, composed.

**Core traits:**

- conclusions appear before supporting detail;
- sections answer specific decision questions;
- visual hierarchy distinguishes signal from evidence;
- detail is available without dominating;
- comparisons and tradeoffs are explicit;
- decoration is subordinate to confidence and clarity.

**Works well for:**

- leadership reviews;
- proposals;
- decision briefs;
- project status;
- strategic comparisons;
- recommendation documents.

**Use carefully when:**

- the artifact is intended for hands-on operation;
- the audience needs to discover rather than consume conclusions;
- raw detail is itself the product.

**Do not reduce it to:**

- corporate blue;
- four KPI cards followed by a chart;
- excessive "executive" whitespace.

Executive design is about decision efficiency.

---

# Quiet and minimal directions

## Nordic Minimal

**Character:** calm, spacious, restrained.

**Core traits:**

- generous whitespace;
- subtle grouping;
- limited visual noise;
- gentle contrast;
- typography carries much of the hierarchy;
- only a small number of elements compete for attention.

**Works well for:**

- focused explanations;
- small amounts of important content;
- reflective summaries;
- lightweight public-facing pages;
- single-purpose artifacts.

**Use carefully when:**

- information density is high;
- many values must be compared;
- users need fast operational scanning;
- the artifact contains numerous controls.

**Do not reduce it to:**

- pale gray everything;
- enormous empty margins;
- thin typography with weak contrast.

Minimalism should remove distraction, not information.

---

# Expressive directions

## Brutalist

**Character:** direct, confrontational, deliberately raw.

**Core traits:**

- strong contrast;
- visible structure;
- minimal polish for its own sake;
- typography and boundaries can feel intentionally forceful;
- hierarchy may be blunt rather than subtle.

**Works well for:**

- internal experiments;
- creative one-pagers;
- intentionally unconventional communication;
- artifacts where attitude is part of the message.

**Use carefully when:**

- trust, neutrality, or broad accessibility is important;
- the audience expects conventional professional presentation;
- the content is already visually complex.

**Do not reduce it to:**

- thick black borders;
- ugly-on-purpose styling;
- arbitrary misalignment.

Rawness must be intentional and coherent.

---

# Environment-specific directions

## Dark Monitoring

**Character:** low-light, persistent, state-focused.

**Core traits:**

- comfortable sustained viewing in dark environments;
- status and exceptions remain distinguishable;
- contrast is controlled rather than maximal;
- charts and state indicators remain readable;
- surfaces create hierarchy without excessive glow or borders.

**Works well for:**

- monitoring displays;
- operations centers;
- persistent dashboards;
- night-time or low-light environments.

**Use carefully when:**

- printing matters;
- bright projectors or daylight viewing dominate;
- the artifact contains long-form reading;
- dark mode is being chosen only because it "looks technical."

**Do not reduce it to:**

- black backgrounds;
- neon colors;
- glowing charts;
- cyberpunk decoration.

Darkness is an environmental choice, not a visual personality.

---

# Combining directions

Most good artifacts do not need to belong to one named direction.

Combine traits when the task benefits from them.

Examples:

### Technical analysis

Use:

- Spec Sheet density;
- Swiss Grid comparison structure;
- Terminal treatment for machine-oriented values.

Avoid turning the entire artifact into a terminal.

### Engineering incident review

Use:

- Operational Console state hierarchy;
- Editorial sequencing for the timeline and explanation;
- Spec Sheet treatment for evidence and event data.

### Executive performance report

Use:

- Executive Brief decision hierarchy;
- Finance Brief quantitative discipline;
- Annual Report emphasis only for genuinely important outcomes.

### Architecture explainer

Use:

- Blueprint structural reasoning;
- Editorial pacing for explanation;
- Swiss Grid alignment for supporting facts and comparisons.

### Lightweight internal update

Use:

- Memo directness;
- selective Swiss Grid alignment where structure helps.

Do not name combinations merely to sound sophisticated. The combination should explain an actual design decision.

---

# Choosing a direction

Use the artifact's needs as evidence.

Prefer **Spec Sheet / Operational Console** traits when:

- scanning speed matters;
- the audience already understands the domain;
- information density is high;
- states and actions matter.

Prefer **Swiss Grid / Finance Brief** traits when:

- comparison matters;
- quantitative evidence matters;
- the artifact should feel disciplined and analytical.

Prefer **Editorial / Newspaper** traits when:

- sequence and explanation matter;
- the reader needs context;
- narrative hierarchy is more useful than operational density.

Prefer **Executive Brief / Annual Report** traits when:

- the audience needs conclusions quickly;
- only a few findings deserve dominant emphasis;
- presentation and decision-making matter more than exploration.

Prefer **Memo / Nordic Minimal** traits when:

- the artifact has a narrow purpose;
- content volume is modest;
- visual quiet improves comprehension.

Prefer **Terminal / Blueprint** traits only where technical or structural content benefits from them.

Prefer **Dark Monitoring** because of viewing environment, not because the artifact is technical.

Prefer **Brutalist** only when deliberate visual attitude serves the communication goal.

---

# Principles above directions

A named direction never overrides the artifact's actual needs.

Always prefer:

- hierarchy over decoration;
- meaning over visual novelty;
- readability over stylistic purity;
- useful density over arbitrary whitespace;
- semantic color over decorative color;
- established interaction patterns over novelty;
- content structure over container proliferation;
- audience needs over designer taste.

If no named direction adds useful reasoning, do not use one.

A good artifact does not need a style name.