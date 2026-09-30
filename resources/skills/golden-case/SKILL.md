---
name: golden-case
description: Business-specification cases whose golden values belong to the user. Use when the user wants to draft, review, or freeze cases ("起草用例", "审阅 case", "封金"); generate an agent verification prompt; write or repair test adapters for cases (JUnit/pytest/vitest templates, other stacks via the loader contract); audit case coverage; or sediment a bug fix as a permanent regression case. Not for unit-test coverage — L1 all-mock logic checks stay the AI's own unit tests.
---

# golden-case

A **case** is a business specification, not a test: a scenario with an id
(`CASE-001`), a `given`/`when`/`then` in plain language, and — the point — an
`expect` whose values (the **golden values**) come from the user, never from a
snapshot of the implementation. The AI writes the adapters and
the implementation; the user defines and freezes what "correct" means. A run's
verdict is aggregated from the case's **verification points**, and the first
failing point is the debug entry point.

The payoff is the one unit tests cannot give: correctness is defined *before*
the code, so a green suite means the business rule holds, not that the
implementation agrees with itself.

## What a case is for

A case is **business truth independent of the implementation, the test
framework and today's code** — the same artifact is readable by a person,
executable by a machine, and durable enough to carry the business decision
and its change history. A frozen case also carries its **business basis**
(provenance): each `expect` key maps through `expect_basis` to entries in
`business_basis` — a user confirmation, a confirmed authoritative source or a
mechanical derivation — so a reader years later can re-check where each
golden value came from without the conversation or the review receipts.
Review receipts still prove only that review happened; the business basis
lives in the case file itself, protected by freeze-check. In AI coding it works three
shifts: a constraint **before** coding (the implementation is written to it),
an **independent acceptance check** after coding (the reviewer did not write
the implementation), and a **drift guard** during refactoring (green still
means the original business rule, not the current code agreeing with itself).

The division of labour is fixed: the AI drafts, writes adapters, runs suites
and writes review opinions; **the user owns the golden values, the key
business judgements, and every change to a frozen case**. Two consequences
the rest of this skill enforces: code being self-consistent or a suite being
green never proves the business right, and an implementation's observed output
is never copied back into `expect`.

## The six review definitions and the three receipt types

「这个 case 写得怎么样」is not a reviewable question. What is reviewable is
six falsifiable claims — scenario reality, business truth ownership,
verification sufficiency, cross-case induction, fresh-reader review,
anti-cheat review — each with its own failure conditions, required evidence,
and PASS / FAIL / UNKNOWN verdict. The full definitions, the unified output
format (verdict / claim / evidence / counterexample / missing_decision /
suggested_change) and the killer questions live in
`references/review-definitions.md`. Read it before reviewing anything; a
review round that cannot cite original text as evidence did not happen.

Rules that hold across all six:

- **No self-approval, everywhere.** A review runs in a context that did not
  write the thing under review; the drafting model never grades its own
  draft. This covers all six rounds and all stages: the verification-
  sufficiency and anti-cheat rounds at stages 4/5 are run by a fresh
  reviewer who did not write the adapter, and the report author never
  re-reviews its own execution chain.
- **Every verdict is one of PASS / FAIL / UNKNOWN.** No scores, no stars, no
  「基本合理」. FAIL means a fixable defect or a broken process; UNKNOWN means a
  decision only the user can make, listed verbatim in `missing_decision` —
  the model never fills it in. One piece of evidence does not carry both
  labels; which state applies is fixed in the reference definitions.
- **Reviewers verify quotes at their original source.** A reviewer citing
  the user's confirmation opens the original place it was said (conversation
  turn / message id, file path + line or anchor, URL + stable anchor,
  user-provided business record) and copies from there — never from the
  drafter's packet retelling. If the original source cannot be opened, that
  business evidence is UNKNOWN; a round that never ran, or a missing
  receipt, is a process FAIL.
- **Splitting is by judgement, not by agent count.** Ordinary changes go
  through the rounds sequentially in one fresh-context reviewer — except the
  fresh-reader round, which always runs blind in its own context (see
  stage 2). High-stakes cases may run rounds in independent parallel
  reviewers. Risk tier only decides *how many* independent reviewers — never
  whether a fresh reviewer exists (high-stakes: money, permissions,
  persistence, privacy/security, cross-system state, irreversible external
  effects). If no fresh context is available, say plainly that the
  independent review did not happen; never degrade into the drafting model
  running the rounds sequentially itself.
- **Scripts first for checkable facts** (anchors, literals, frozen drift);
  the six rounds review only semantics. A script exiting 0 never settles a
  round.

### Receipt types

A **review receipt** proves what independent review was done — it is process
evidence, never proof that a business fact is true. Three kinds, by stage:

- **Draft receipt** — scenario reality, business truth ownership,
  spec-level verification sufficiency. Produced in stage 1.
- **View receipt** — fresh-reader review and cross-case induction. Its
  fresh-reader portion must come from an independent blind read (stage 2).
- **Adapter receipt** — implementation-level verification sufficiency and
  anti-cheat. Can only exist after the adapter is written (stages 4/5).

Freeze requires matching **Draft + View receipts** for the current case
revision; the Adapter receipt comes later. There is no single "six-round
receipt": the anti-cheat round needs a real adapter, so it cannot run
before freeze — any text implying "all six rounds passed before freeze" is
wrong.

Every receipt header records:

- receipt type and which definition(s) actually ran;
- case ids + versions under review;
- an exact digest / immutable artifact id of the reviewed input, generated
  by the host/harness — without a bindable input the receipt is not a
  credential for the current version;
- reviewer role/agent/session, who started it, and its relation to the
  reviewed work's author;
- citations to original evidence (not drafter retellings);
- verdicts, counterexamples, unresolved decisions.

Any change to a case, view or adapter invalidates the affected verdicts; the
affected definitions must be re-run. The skill adds no schema or scripts for
this — it specifies the review metadata the host must provide. Receipts live
wherever the host keeps review artifacts (a hapi team's plan-task dossier is
one instance, not the only one; the user may name a path to keep them).
Independence is recorded, not proven: when the host cannot verify the
reviewer's identity, disclose to the user that independence was not
mechanically verified. A drafting session that resets its own conversation
and declares itself fresh is not independent review; in a single session
with no second context, hand a review bundle bound to the exact input to a
separate session/agent the user starts.

## Layout

One location: everything this skill owns lives under
`<project>/.hapilon/go-case/` (user-decided, follow it verbatim):

| Path | Contents | Owner |
|---|---|---|
| `<project>/.hapilon/go-case/cases.yaml` | The case source. When it spans several domains, split it into `<project>/.hapilon/go-case/cases/`, one `*.yaml` per domain; `--cases` takes the file or that directory. | **用户定义** |
| `<project>/.hapilon/go-case/frozen.md` | The golden snapshot, written on confirmation in stage 3. | **用户定义** |
| `<project>/.hapilon/go-case/manifest.json` | The map from a case to the adapter that implements it. | **用户定义** |
| `<project>/.hapilon/go-case/` (`*.html`, `views/`) | The generated review views — regenerated from the case source, never hand-edited. | **用户定义** |
| `<project>/.hapilon/go-case/runs.json` | The latest run's observed values (anchor → actual). | **用户定义** |
| `<project>/.hapilon/go-case/runs-history/` | One `YYYY-MM.jsonl` per month, current month created on demand; append-only, never rewritten — one line per run. | **用户定义** |

`<project>/.hapilon/go-case/manifest.json` is the map between a case and its
adapter — the skill's own bookkeeping (no script reads or writes it):

```json
{
  "cases": ".hapilon/go-case/cases.yaml",
  "frozen": ".hapilon/go-case/frozen.md",
  "adapters": [
    { "case_id": "CASE-001A", "test_file": "src/test/java/shop/ShopGoldenCaseTest.java",
      "framework": "junit5", "command": "mvn test -Dtest=ShopGoldenCaseTest" },
    { "case_id": "CASE-001B", "test_file": "tests/test_golden_case.py",
      "framework": "pytest", "command": "pytest tests/test_golden_case.py" }
  ],
  "generated": {
    "explorer": ".hapilon/go-case/case-explorer.html",
    "views": ".hapilon/go-case/views/",
    "runs": ".hapilon/go-case/runs.json"
  }
}
```

**Iron rule: the tests that actually run live in the project's regular test
directory** — JUnit under `src/test/java/…`, pytest under `tests/…` — and are
versioned with the project. Never put an adapter in `.hapilon/`:
`.hapilon/go-case/` holds the cases, views, run data and the location mapping —
nothing executable, and **never reports** (worker-report / reviewer-report and
any team progress report belong to the task's plan-task dossier, not here).
Recording `test_file` + `command` in `manifest.json` is how
the mapping survives the file being somewhere normal and reviewable.

## The six iron laws

1. **Never mock the observation surface.** Balances, stock, orders and the event
   log *are* what you are observing; mocking them tests the mock. Everything
   outside it — payment gateway, MQ, LLM, clock — is mocked freely.
2. **Zero expectation literals in adapters.** Assertion values load from the
   case file; the anchor string (`"CASE-003:checkpoint_c_total"`) is the one
   allowed literal. This is what kills the two-source drift between spec and
   test.
3. **Adapters never take over unit tests.** L1 all-mock logic verification is
   the AI's own unit-test territory; this skill does not manage it, count it,
   or write it.
4. **After freeze, only the user may change an Expected value.** A frozen
   snapshot diff catches the classic cheat: editing the expectation to make a
   red test green.
5. **Every expectation must be decidable.** A number, a boolean, or a short
   ASCII symbol (`success`, `PAID`). "余额正确" is a description, not an
   expectation — it is rejected at draft time.
6. **Golden values come from a human, never from an implementation snapshot.**
   Observed output may never be promoted to golden by copying it back. This is
   the difference from classic golden-master testing, and the whole point.

## The five-stage workflow

A stage is a **gate**, not a single interaction: one stage may go through
several review/fix rounds. Handle findings uniformly — **FAIL** (fixable by
the AI): fix it, then re-run the affected definitions; do not hand issues
you can fix yourself to the user. **UNKNOWN** (only the user can decide):
stop and ask the user, item by item. **PASS**: the gate opens. Stop for the
user only when a decision is needed or the gate passes; never run ahead into
the next stage uninvited, and never self-approve a golden value.

### 1. Draft — from a requirement or a bug

Write the cases into `.hapilon/go-case/cases.yaml` in the schema of
`references/format.md`: one case per scenario, `given`/`when`/`then` in plain
language plus the structured `observe` + `expect`, and — for every case — a
`description`, a `business` category, a `type`, a `priority`, a
`verification_level`, structured `verification_points` (whose `name` / `target`
carry the plain-language labels) and a `units` map, so a non-author can read the
view without ever meeting a machine name.

Reuse before inventing: read the `business` values and `tags` already in the case
set first and reuse them — a synonym for a category that exists (「付款」 beside
「支付」) splits the filter tree and is never allowed. A new `business` / `tag`
is only for a genuinely new capability area, and when you show the draft you say
so out loud — "created the category / tag X" is the user's call, not yours.

Tag naming — occurrence counts are a review signal, never a verdict:
- A tag is a reusable capability area a teammate would say out loud in a work
  conversation (「输入校验」「容错降级」). A tag only one case uses is not
  automatically wrong: it must be a stable business concept with a clear
  filtering use, confirmed by the user as a new word. This case's storyline
  keywords (「618 大促价」「仅限前 100 单」) are not stable concepts — they belong in the
  description, never in tags.
- Field names, enum values and verdict words (`order_status`, null语义, 静默降级)
  never become tags, no matter how many cases mention them.
- Case prose follows the same bar: write the way a teammate talks about the
  feature; if a name would never be said out loud, rename it.

Run the self-check on every draft before showing it:

- **Decidable** — every `expect` value passes law 5.
- **Three questions** — each observation point answers 看什么 / 去哪看 / 看到什么算对.
- **Five observation categories** — 返回与状态 / 副作用 / 检查点路径 / 不变量 /
  边界与异常. Report which categories this case set does *not* cover; an
  uncovered category is a coverage hole, not a passing grade.
- **Invariants present** — a case that can only break a shared property
  (`balance >= 0`, idempotent charge) must carry that `invariant`.
- **Tag sense** — every tag is a stable business concept a teammate would
  filter by. A single-case tag triggers semantic review, not an automatic
  failure: a word lifted from one case's storyline is demoted to the
  description; a genuinely new stable concept stays only with the user's
  confirmation. A high-frequency field name never becomes a tag by count.

Seed a regression case from a real bug: reproduce the bug, then write the case
that would have caught it (invariant + the concrete observation points), and
have the user confirm the expected values.

After the self-check, run the draft review rounds in a **fresh context**
(new conversation or sub-agent that did not write the draft) — never
self-approve:

1. **Scenario reality** — is every case a real scenario with concrete state,
   trigger, risk and observable result, traceable to a requirement or a bug?
2. **Business truth ownership** — does every golden value trace to acceptable
   evidence: the user's direct confirmation; an authoritative source (law,
   contract, product material, real business data) whose applicability the
   user confirmed, cited verbatim; or a mechanical derivation from
   user-confirmed rules and inputs, shown as a derivation chain the reviewer
   recomputes? Guesses and bare model proposals stay UNKNOWN, never frozen.
3. **Verification sufficiency** — construct the business-wrong-but-literal-
   green implementation; if one exists, the draft needs another observation
   point or an invariant.

Tag and category choices are **not** settled by the draft itself — they are
reviewed at the case-set level in stage 2 (cross-case induction); a new word
is a proposal to the user, never a settled fact.

**Stop** and show the draft — including which categories are uncovered and
which values you are guessing at — together with the **Draft receipt** (see
「Receipt types」 for its header). The receipt cites each business basis at a
place the reviewer actually opened: conversation turn / message id, file
path + line or anchor, URL + stable anchor, or a user-provided business
record — copied from the original source, never transcribed from the
drafter's packet. Evidence whose original source cannot be opened goes
UNKNOWN; a round that never ran, or a missing receipt, is a process FAIL. As
part of this stop, show the user every user-related confirmation excerpt
alongside its original source and ask them to verify the quote is theirs —
anything they cannot verify goes UNKNOWN. A receipt records that review
happened; it is never durable business provenance and never substitutes for
the user's own confirmation — once the user confirms a value, record its
basis in the case's `business_basis` and bind it through `expect_basis`
(schema v3, see `references/format.md`); the receipt stays process evidence
only. Receipts live wherever the host keeps review artifacts; in a single
session the structured verdicts are shown in the conversation where the user
can see them. They never enter `.hapilon/go-case/`. While still drafting,
the review packet holds the guesses, business-basis citations and open
`missing_decision`s; DRAFT cases may leave `expect_basis` incomplete, and
the explorer shows every gap. The user answers with corrections, not you.

### 2. View / review — the HTML is generated, never edited by hand

Generate both faces into `.hapilon/go-case/`:

```
node <skill>/scripts/explorer.mjs --cases .hapilon/go-case/cases.yaml \
     --title "<project>" --out .hapilon/go-case/case-explorer.html

node <skill>/scripts/gen-view.mjs --cases .hapilon/go-case/cases.yaml --style manager \
     --out .hapilon/go-case/views/manager.html
# add  --frozen .hapilon/go-case/frozen.md ,  --runs .hapilon/go-case/runs.json ,  and
# --history .hapilon/go-case/runs-history  to the explorer once they exist
```

The explorer is the working review surface (Card/List, filters, Drawer, notes,
prompt composer); `gen-view.mjs` renders a static one-page view for reading and
for handing to someone else. Pick the style that matches the question being
asked (`manager` default, `workbench` for coverage, `ledger` for expected-vs-
actual, `dossier` for the case-file ritual, `narrative`/`index` for prose).

Review order matters — read before judging:

1. **Fresh-reader review** first, and **blind**: it runs in an independent
   context that has not read the YAML machine fields, the chat, the business
   basis or the verification points, and must run before any round that
   opens machine fields. It sees only (a) a narrative static view
   (`gen-view --style narrative`) or an equivalent SPEC-only export — the
   interactive Case Explorer is **not** a blind-read input: its Drawer tabs
   expose verification points and `business_basis`, which this round must
   not see — otherwise the human-language fields of the case file, and (b)
   while the case is still a draft, a separate
   unresolved-decisions sheet listing the open questions without explaining
   the case body. A frozen view must have no unresolved unknowns. A reviewer
   who has already read the YAML cannot retroactively become a fresh reader
   — that round is invalid; start a blind context. Whether a technical
   identifier may be shown at all is the user's call; whether an explanation
   is clear enough is the reviewer's, never punted to the user as a writing
   question. This is a semantic review, not a banned-word grep.
2. **Cross-case induction** second, over the full case set: every `business`
   and `tags` value induced from the whole set and the business question, not
   excerpted from one case's prose. Occurrence counts are a signal, not a
   verdict; a new word must say what it expresses, how it differs from the
   existing one, and why a user would filter by it. **The vocabulary is the
   user's** — model proposals go out as questions.

The user reads a view, copies an anchor with ⚓, and says one sentence —
"CASE-003:checkpoint_c_total 应该是 76.8". You edit the YAML, regenerate the
view, and report the **before → after diff**. Never edit the HTML: a generated
file is regenerated, and a correction flows back through the source.

The two rounds compile into the **View receipt** for the current revision.
Any YAML revision after this invalidates the View receipt (and any Draft
receipt covering the changed cases); re-run the affected definitions.

**Stop** after presenting the diff of the case file — the user decides whether
the case is now right. An anchoring correction that changes an Expected on a
frozen case goes through stage 3's rules, not straight into the file.

### 3. Freeze — the user confirms, the snapshot is written

Only on the user's explicit confirmation, write the frozen values into
`.hapilon/go-case/frozen.md` as a **v3 structured snapshot** (format in
`references/format.md`): `version` + `expect` + `expect_basis` +
`business_basis`. Freeze-check refuses incomplete provenance — every expect
key must map to at least one existing basis id before the freeze can go
through. Set the case's `lifecycle` to `FROZEN` in the same change: the
explicit declaration is what lets the reverse check (`LIFECYCLE-UNBACKED`)
catch a later deletion of the snapshot. From then on, the implementation,
refactors, logging and tests may
change freely, but an Expected value only changes through a **new case
version plus a fresh human confirmation** — record it in `changes`
(`{v, when, what, scope}`), bump `version`, and re-freeze. The same holds
for the basis: after freeze, changing any basis content or any
`expect_basis` binding is itself a golden-value change — bump version, get
a fresh human confirmation on the new basis, and re-freeze.

Gate every later edit:

```
node <skill>/scripts/freeze-check.mjs --cases .hapilon/go-case/cases.yaml --frozen .hapilon/go-case/frozen.md
```

It red-cards a changed value, a deleted expectation key, a frozen case that
disappeared from the case set, and provenance drift: changed basis content,
re-bound or removed bases, a v3 case still protected by an old-style
snapshot (`BASIS-NOT-FROZEN`), incomplete or structurally invalid
provenance, and version mismatches (exit 1). A case that declares
`lifecycle: FROZEN` without a snapshot in `frozen.md` is red-carded
`LIFECYCLE-UNBACKED`. A frozen id with no matching
case usually means the expectation was edited out of the way.

Trust boundary: `frozen.md` is itself the baseline `freeze-check` diffs
against, so the script cannot prove the baseline was not rewritten in the
same change — it does not guard against a snapshot and case being edited or
deleted together. Baseline integrity rests on version control (commit
`frozen.md`), the review receipt / anti-cheat diff, and the rule that
`frozen.md` is only updated on the user's explicit confirmation. Never
describe the script as a complete anti-tamper system.

The gate before writing the snapshot is human plus receipted, not self-
narrated: every FAIL resolved (fixed and re-reviewed), every UNKNOWN
explicitly adjudicated by the user, and the freeze must cite **Draft + View
receipts whose recorded case ids + versions + digest match the exact input
being frozen**. A receipt for revision v1 never endorses revision v2; after
any change, re-run the affected definitions and re-receipt. No matching
receipt, any unresolved FAIL, or any business UNKNOWN without a user ruling
— all block the freeze. A self-narrated "all rounds passed" from the
drafting model is not a receipt. When no fresh context is available, say so
plainly (「未完成独立审查，独立性未机械验证」), hand the bound review bundle to a
separate session/agent the user starts, and stop until its receipt arrives;
the model never auto-fills a user decision and then seals the gold.

**Stop** and show the user what is being frozen, and later, every red card
before touching anything.

### 4. Adapter — the AI's half

Write or repair the adapters from the templates in `references/format.md`
(JUnit 5, pytest, vitest; other stacks translate the nearest template and follow
the loader contract), into the project's real test directory, then record the file and its
run command in `manifest.json`. Rules that decide whether the adapter is any good:

- One test per verification point, the anchor in the test name
  (`@DisplayName("CASE-001:api_return")` / `test_golden[CASE-001:api_return]`).
- Values loaded from the case file; zero expectation literals (law 2).
- Mock only outside the observation surface (law 1); the dependency's `mode` in
  the case (`MOCK` / `FAKE` / `LOCAL` / `REAL`) says which world the case is for.
- A case may carry A/B adapters — a mock-dependency one and a real-dependency one
  (the real one needs a key from the environment; `configuration` refers to the
  variable, never the secret). A green A with a red B means the business is fine
  and the model layer is not.

Before trusting the suite, a **fresh reviewer who did not write the
adapter** runs the two rounds aimed at 「测试能绿但业务仍错」 — the adapter
author never grades its own execution chain:

- **Verification sufficiency** against the adapter: does the assertion set
  still cover every `then` claim once the adapter is real code, or did the
  translation from spec to test quietly drop the invariant?
- **Anti-cheat** against the execution chain: no mock inside the observation
  surface, no assertion literals, no weakened/deleted observation points, no
  `verification_level` or `priority` downgrade, no `dependencies[].mode`
  flipped to an easier-to-pass world, no weakened comparison operator in the
  adapter (`==` relaxed to `<=`), no source/anchor moved to a surface that
  passes but proves nothing about the business — none of these without the
  user's explicit record. Verifying only the sample input is a FAIL **only**
  when the case claims to protect a rule, range or invariant; a legitimate
  single-point golden fact may be verified at that point alone. No red case
  silently excluded via lifecycle or `--only`. Ask: if my business judgement
  were wrong, which step would stop me? If none — the chain is the bug. The
  rounds compile into the **Adapter receipt**. Residual risk, recorded not
  solved: a fresh context isolates the conversation, not the priors — when
  reviewer and implementer share an unproven assumption, say so in the
  receipt, and add an independent reviewer for high-stakes cases.

Run the suite, then collect the per-anchor observed values into
`.hapilon/go-case/runs.json` (anchor → actual, `_meta` block first; one small
collector that reads the same observation surface the adapters assert on — the
demo's `collect-runs.py` is a one-file example). `runs.json` is a build artifact:
it lives in `.hapilon/go-case/` and never in version control.

**Stop** and report: adapters written, where they live, the command to run them,
and the run result.

### 5. Report / audit

```
node <skill>/scripts/report.mjs --cases .hapilon/go-case/cases.yaml <test-output.txt> ...
node <skill>/scripts/audit.mjs  --cases .hapilon/go-case/cases.yaml --tests src/test/java,tests
```

`report.mjs` eats the adapters' run output (console text or JUnit XML — see the
input contract in `references/format.md`), groups it by case from the anchors in
the test names, and puts the first failing verification point at the top of each
case block (exit 1 unless every case is green and no orphan anchor appears).
Fail-closed on coverage: an expected observation point missing from the output
is **undetermined, not passing** — the case goes ⚠️ non-green. To verify a
subset on purpose, declare it upfront with `--only CASE-001,CASE-002`: the
report and the exit code then answer only for the declared cases, and anchors
outside the scope are ignored (not orphan-flagged). The report author only
assembles evidence from `report.mjs` / `audit.mjs` output; judging this
round's changes against the Adapter receipt, the frozen snapshot and the `changes` log is done by the reviewer who produced
the Adapter receipt, or by another fresh reviewer. The report author does
not re-review their own execution chain and never upgrades their own
execution chain from UNKNOWN/FAIL to PASS; with no comparable baseline the
round can only be downgraded to UNKNOWN. `audit.mjs` reconciles case ↔ test
code and reports three findings: `UNOWNED` case (no test references it),
`ORPHAN` anchor (a test cites a case that does not exist), `LITERAL` (an
assertion line with a golden value written into it — law 2 drift). Report
what the audit found even when the answer is uncomfortable: an unowned case
is an unimplemented specification, not a rounding error. The report is
where anti-cheat earns its keep: a green report with deleted observation
points, downgraded severities, or narrowed `--only` scope is a cheat with a
receipt — the reviewer compares this round's changes against the Adapter
receipt, the frozen snapshot and the `changes` log before believing green.
With no comparable baseline the round cannot PASS: it goes UNKNOWN, stating
plainly what evidence is missing.

The run ledger: append this run to
`.hapilon/go-case/runs-history/YYYY-MM.jsonl` (current month, created on demand)
**before** overwriting `runs.json` — the invariant is that the last line agrees
with the `runs.json` you just wrote. One line per run:
`{when, cases: {CASE-id: verdict}, first_fail: {CASE-id: VP-id}}`. It is
append-only, never rewritten; `explorer.mjs --history <dir>` renders it as the
Drawer's HISTORY tab, but the verdicts still come from `runs.json`.

## Scripts

All zero-dependency Node (`node:fs` + regex); no build step, no `dist` sync.
`<skill>` below is this file's directory (`resources/skills/golden-case` in the
hapilon repo, the skills directory when installed).

| Script | Purpose |
|---|---|
| `scripts/yaml-lite.mjs` | Library, not a CLI. The case-file YAML subset parser plus `numEq` / `isUndecidable` / `isDecimal`, shared by the others. |
| `scripts/cases-source.mjs` | Library, not a CLI. Resolves `--cases` (single file, a directory of `*.yaml` merged in filename order, or a comma-separated list); parsing still belongs to `yaml-lite.mjs`. |
| `scripts/gen-view.mjs` | Static review views, one file per style. |
| `scripts/explorer.mjs` | The interactive explorer: one self-contained HTML, data and client code inlined. |
| `scripts/freeze-check.mjs` | Expected-vs-frozen diff. |
| `scripts/audit.mjs` | Case ↔ test coverage reconciliation. |
| `scripts/report.mjs` | Test output → per-case report. |

```
gen-view.mjs     --cases <yaml|dir> [--frozen <md>] [--title <h1>] [--out <html>]
                 [--style workbench|ledger|dossier|narrative|index|manager]
                 [--runs <json>] [--variants <dir>]
                 # --layout is a legacy alias of --style; default style manager;
                 # --out is required unless --variants is given, and --variants
                 # writes manager/index/dossier in one pass

explorer.mjs     --cases <yaml|dir> --out <html> [--frozen <md>] [--runs <json>]
                 [--history <dir|file>] [--title <name>] [--subtitle <text>]
                 [--business <name>]
                 # --cases and --out are required; --history takes the
                 # runs-history/ directory, or a legacy single .jsonl file;
                 # --business renders only that business's cases (name the
                 # --out file after it); --subtitle defaults to 本地只读审阅面

freeze-check.mjs --cases <yaml|dir>[,<yaml|dir>...] --frozen <md>

audit.mjs        --cases <yaml|dir> --tests <dir|file>[,<dir|file>...]

report.mjs       --cases <yaml|dir> <test-output.txt> [...]
```

`--cases` on every script accepts one `.yaml`, a directory (all `*.yaml`
merged in filename order, later ids winning), or a comma-separated list.

Exit codes: `explorer.mjs` and `gen-view.mjs` exit 2 on a missing required
argument; `freeze-check.mjs` exits 1 on any red card (2 on missing arguments);
`audit.mjs` exits 1 when it finds anything; `report.mjs` exits 1 unless every
case is green and no orphan anchor showed up. So each script is usable as a CI
gate as-is.

The case-file schema itself — every key, the controlled vocabularies, the
runs.json shape, the adapter templates — is `references/format.md`. Read it
before writing or editing a case; do not invent keys.

## Anti-patterns

- **Asking yourself 「写得怎么样」.** The drafting model grading its own draft
  is self-approval; reviews run in a fresh context against one of the six
  claims, never as a self-congratulatory summary.
- **A keyword blacklist in place of semantic review.** Grepping a banned-word
  list is not the fresh-reader round; only a reader who cannot see the chat
  and still understands the case passes it.
- **Golden values from an implementation snapshot.** Observed output copied
  into `expect` (see law 6 and the business-truth round) makes green mean
  nothing.
- **Inventing a category or tag from a single case.** Classification is
  induced from the full case set and the business question; single-case
  storyline keywords belong in the description. A single-case tag is not
  auto-rejected by count, but a genuinely new stable concept needs the
  user's confirmation.
- **Requirement clauses stuffed into given/when/then.** 「余额不足时下单失败」
  is a clause, not a scenario — no concrete state, no trigger, no risk
  (scenario-reality round).
- **All green, business still wrong.** Verification points that a
  business-incorrect implementation satisfies literally (verification
  sufficiency round) — the whole reason the round exists.
- **Turning a wrong business green.** Deleting observation points, changing
  `expected`, downgrading severity, over-mocking, marking a red case STALE,
  or `--only`-ing the failure out of the report. Every one of these without
  the user's explicit record is the cheat the anti-cheat round hunts.

- **Unit tests.** Not this skill's job, not its coverage metric, not its
  business (law 3). Do not add cases to raise a unit-test number.
- **A KPI dashboard.** The views are working tools: high density, flat, few
  shadows, small radii, neutral palette with one accent. No gradient or
  glassmorphism backgrounds, no oversized cards, no KPI hero numbers, no
  decorative illustrations, no animation for its own sake. A view that looks
  like an analytics product has failed even if every field is present.
- **Hand-editing generated HTML.** The view is a build artifact of the YAML.
  Corrections go to the source, then regenerate (stage 2).
- **Inventing golden values.** Never fill an `expect` with what the code
  happens to do, and never "fix" a red case by editing the expectation — that is
  the cheat law 4 exists to catch. Guessed values are labelled as guesses to the
  user, not written as facts.
- **Renumbering cases.** `CASE-003` keeps that id forever; anchors, test names
  and reports are keyed on it.
- **Committing the skill's directory.** Everything this skill owns sits under
  `.hapilon/go-case/` (`.hapilon/` is local, not part of the repo tree): cases,
  snapshot, manifest, views and run data alike. The only versioned part is the
  executable adapters, and those live in the project's real test directory.
