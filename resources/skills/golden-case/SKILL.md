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
nothing executable. Recording `test_file` + `command` in `manifest.json` is how
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

Each stage is one interaction with the user. Do the stage, then stop and report;
do not run ahead into the next one without the user, and never self-approve a
golden value.

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

Run the four-eye self-check on every draft before showing it:

- **Decidable** — every `expect` value passes law 5.
- **Three questions** — each observation point answers 看什么 / 去哪看 / 看到什么算对.
- **Five observation categories** — 返回与状态 / 副作用 / 检查点路径 / 不变量 /
  边界与异常. Report which categories this case set does *not* cover; an
  uncovered category is a coverage hole, not a passing grade.
- **Invariants present** — a case that can only break a shared property
  (`balance >= 0`, idempotent charge) must carry that `invariant`.

Seed a regression case from a real bug: reproduce the bug, then write the case
that would have caught it (invariant + the concrete observation points), and
have the user confirm the expected values.

**Stop** and show the draft — including which categories are uncovered and
which values you are guessing at. The user answers with corrections, not you.

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

The user reads a view, copies an anchor with ⚓, and says one sentence —
"CASE-003:checkpoint_c_total 应该是 76.8". You edit the YAML, regenerate the
view, and report the **before → after diff**. Never edit the HTML: a generated
file is regenerated, and a correction flows back through the source.

**Stop** after presenting the diff of the case file — the user decides whether
the case is now right. An anchoring correction that changes an Expected on a
frozen case goes through stage 3's rules, not straight into the file.

### 3. Freeze — the user confirms, the snapshot is written

Only on the user's explicit confirmation, write the frozen values into
`.hapilon/go-case/frozen.md` (format in `references/format.md`). From then on, the
implementation, refactors, logging and tests may change freely, but an Expected
value only changes through a **new case version plus a fresh human
confirmation** — record it in `changes` (`{v, when, what, scope}`), bump
`version`, and re-freeze.

Gate every later edit:

```
node <skill>/scripts/freeze-check.mjs --cases .hapilon/go-case/cases.yaml --frozen .hapilon/go-case/frozen.md
```

It red-cards a changed value, a deleted expectation key, and a frozen case that
disappeared from the case set (exit 1). A frozen id with no matching case
usually means the expectation was edited out of the way.

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
outside the scope are ignored (not orphan-flagged). `audit.mjs` reconciles case ↔ test code and
reports three findings: `UNOWNED` case (no test references it), `ORPHAN` anchor
(a test cites a case that does not exist), `LITERAL` (an assertion line with a
golden value written into it — law 2 drift).

Report what the audit found even when the answer is uncomfortable: an unowned
case is an unimplemented specification, not a rounding error.

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
