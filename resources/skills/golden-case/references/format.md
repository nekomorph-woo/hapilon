# Case File Format (golden-case)

The YAML file is the **single source of truth**. The HTML review view, the test
adapters, and the aggregated reports are all generated from it — never edited
by hand. Users own and review the case file; AI owns the adapters.

Schema version: **v2**. v2 keeps the v1 core (`observe` + `expect` remain the
authoritative expectation surface that every check reads) and adds the review
model on top: `lifecycle` / `health`, structured `verification_points`,
`invariants`, `dependencies`, `tests`, and an optional inlined `latest_run`.
A v1 file still loads: the missing fields are either left empty or derived by
the view's fallback rules, never invented (see *v1 → v2 fallback rules*).

## Terminology

- **case** — one scenario, id `CASE-\d{3}`. The id never changes once assigned.
- **golden** — an Expect value. It comes from the **user**, never from a
  snapshot of the implementation (this is what distinguishes golden-case from
  classic golden-master testing).
- **freeze** — a confirmed copy of Expect values. After freeze, only the user
  may change an Expect.
- **verification point (VP)** — the structured form of one expectation:
  id / name / target / source / operator / expected. `source` is the
  observation-point name that anchors it (`CASE-003:checkpoint_c_total`).
- **invariant** — a property that must hold (balance never negative, same
  payment id charged at most once). References are shared across cases.
- **dependency** — an external collaborator the case needs, plus the mode it
  runs in (`MOCK` / `FAKE` / `LOCAL` / `REAL`). An invariant is a property of
  the world; a dependency is a wiring detail.
- **lifecycle ≠ health ≠ run result** — three independent axes, never collapsed
  into one `status` field. `lifecycle` is where the case sits in review
  (`DRAFT`/`REVIEW`/`CONFIRMED`/`FROZEN`); `health` is whether the case itself
  is trustworthy (`ACTIVE`/`STALE`/`BROKEN`/`DEPRECATED`); the run result is one
  execution's verdict (`PASS`/`FAIL`/`NOT_RUN`/…).

## YAML subset

Scripts ship with a zero-dependency parser that accepts this subset only:

- block mappings / block sequences, and flow style `{k: v}` / `[a, b]`
- list items in flow form (`- {id: VP-001, expected: 88.0}`) or compact block
  form (`- id: VP-001` plus aligned sibling keys)
- comments: full-line `#`, or inline ` #` after a value; `#` is never part of a
  value
- a comma inside quotes or nested brackets is safe (flow splitting is paren- and
  quote-aware)
- scalars: integers, decimals, `true`/`false`, bare or quoted strings
- a flow value must stay on **one line** — the parser is line-based, and a
  continuation line is silently dropped rather than reported; a very long
  `{…}` or `[…]` is normal, showing it as one line

Not supported: anchors/aliases, multi-document, multiline scalars, tabs for
indentation. A decimal (`74.8`) is preserved as text so the view can render
units and freeze-check can compare numerically.

## Case schema

```yaml
cases:
  - id: CASE-005                    # required, stable, CASE-\d{3}
    name: 支付重试幂等（同一支付单最多成功一次）
    description: 支付重放事故的回归沉淀：无论重发几次，钱只扣一次、事件只发一条、钱守恒。
    business: 不变量                # 业务分类；缺 → narrative.group → 未分类
    tags: [payment, idempotence]    # optional; searched
    type: REGRESSION                # HAPPY_PATH | BOUNDARY | STATE | ERROR | CONCURRENCY | REGRESSION
    priority: P1                    # P0 | P1 | P2 | P3
    verification_level: L2           # L1 | L2 | L3 | L4
    lifecycle: FROZEN                # DRAFT | REVIEW | CONFIRMED | FROZEN
    health: ACTIVE                   # ACTIVE | STALE | BROKEN | DEPRECATED
    version: 1                       # current case version; 1 at draft time, +1 per confirmed change
    changes:                         # change log, oldest first; newest entry drives「最近改动」
      - {v: 1, when: 2026-09-17, what: 由支付重放双扣 bug 沉淀的回归 Case}
      # optional per entry: scope: Then | given | VP … , by: <who>
    created: 2026-09-17              # optional; ordering fallback for log-less cases
    given:                           # world state before the action (domain-owned)
      stock: {BOOK: 5}
      balances: {erin: 500.0}
      inputs: []                     # optional: raw request/payload fixtures
      preconditions:                 # optional: world facts not expressible as maps
        - 存在一笔 erin 的历史订单 O-OLD（PAID，金额 88.0）
      environment: local             # optional
    when:                            # one action (flow map)…
      {action: place_order, order_id: O5, user: erin, item: BOOK, qty: 1, payment_id: P5}
    # …or an action sequence (block list) for retry/idempotence cases
    # when:
    #   - {action: place_order, order_id: O5, user: erin, item: BOOK, qty: 1, payment_id: P5}
    #   - {action: place_order, order_id: O5, user: erin, item: BOOK, qty: 1, payment_id: P5}
    then:                            # plain-language outcomes, one per line (human 三问)
      - 扣款次数 = 1（重放 N 次恒成立）
      - 实扣总额 = 74.8
    invariants:                      # properties this case must not break
      - id: INV-001
        description: 同一支付单最多成功一次（重放 N 次恒成立）
        expression: "count(charge where payment_id = P5) == 1"
        severity: critical           # critical | major | minor
        verification_status: FAIL    # PASS | FAIL | PENDING
    dependencies:
      - {name: 支付网关, type: HTTP API, mode: MOCK, configuration: 本地 Fake 网关, mock_behavior: "重放请求返回与首笔相同的成功响应"}
    verification_points:             # structured expectations (humans + view)
      - {id: VP-001, name: 扣款次数（幂等）, target: 支付流水.扣款次数, source: charge_count_P5, operator: "==", expected: 1, severity: critical, example_query: "select count(*) from charge where payment_id='P5'"}
    observe: [charge_count_P5, event_count_P5, total_charged_for_payment, balance_sum_after]
    expect:                          # AUTHORITATIVE: one entry per observe point, must be decidable
      charge_count_P5: 1
      event_count_P5: 1
      total_charged_for_payment: 74.8
      balance_sum_after: 425.2
    tests:                           # Case = spec, Test = machine implementation (1→N)
      - {id: T-005A, case_id: CASE-005, type: ACCEPTANCE, framework: node:test, file: fixtures/tests/ShopGoldenCaseTest.java, status: FAIL, last_run: 2026-09-19, failure_reason: "INV-001 幂等被破坏：重放导致双扣（charge=2）"}
    latest_run:                      # optional: inlined last execution (else use runs.json)
      status: FAIL                   # NOT_RUN | RUNNING | PASS | FAIL | ERROR | SKIPPED
      started_at: 2026-09-19 01:51
      duration_ms: 812
      environment: local
      failure_stage: ASSERTION       # ASSERTION | EXPECTED_RED | FIXTURE
      logs: ""
      results:
        - {vp_id: VP-001, source: charge_count_P5, expected: 1, actual: 2, status: FAIL, message: ""}
    narrative:                       # plain-language metadata; feeds the review view
      scene: 支付重放事故的回归沉淀：钱只扣一次。
      when: erin 用同一支付单 P5 重放两次下单。
      where:                         # observation-point name → plain-language label
        charge_count_P5: 扣款次数
      units:                         # display unit per observation point
        stock_after: 个              # missing key → " 元" for decimals, "" otherwise
        stock_BOOK: 本               # "stock_<ITEM>" keys set the unit used in the given-prose
      group: 不变量                   # legacy business category; superseded by `business`
```

### Identity & review metadata

| key | meaning | missing → |
|---|---|---|
| `id` | `CASE-\d{3}`, stable forever | required — the file is rejected without it |
| `name` | short label shown in headings | empty label |
| `description` | one plain sentence: what this case guards against | falls back to `narrative.scene` |
| `business` | 业务分类 used by the business tree and the coverage count (返回与状态 / 副作用 / 检查点路径 / 不变量 / 边界与异常) | `narrative.group` → `未分类` |
| `tags` | free labels; included in full-text search | none |
| `type` | `HAPPY_PATH` / `BOUNDARY` / `STATE` / `ERROR` / `CONCURRENCY` / `REGRESSION` | blank (`—`) |
| `priority` | `P0`–`P3` | blank |
| `verification_level` | `L1` Logic / `L2` Local Integration / `L3` Real Dependency / `L4` E2E | blank |
| `lifecycle` | review state, 4 values | `FROZEN` when the case id has a frozen snapshot, else `DRAFT` |
| `health` | case trustworthy? 4 values | `BROKEN` when some Expect is undecidable, else `ACTIVE` |
| `created` / `created_by` / `updated_by` | provenance, optional | blank |

Values outside the controlled vocabularies are **dropped** (rendered blank), not
guessed — a typo must not silently become a different valid state.

### Version & change log

`version` is the case's current version — 1 at draft time, +1 for each
confirmed change (e.g. an anchor correction from review). `changes` records the
history, oldest first: `v` (version), `when` (date), `what` (one sentence), plus
optional `scope` (which block changed) and `by`. The manager view orders cases
by the newest change's `when`, newest first, falling back to `created` for cases
without a log. Run results never affect ordering — only case edits do.

### Spec block

`given` is the world before the action; `when` is one business action or a
sequence of them (retry/idempotence); `then` is the plain-language outcome list.
None of the three is machine-checked — the machine reads `observe` + `expect`
(and `verification_points`, when the view renders the structured form). Keep
`then` in sync with `expect`: when they disagree, `expect` wins.

`given.preconditions` carries world facts that do not fit the maps (an existing
historical order, a clock setting); `given.inputs` carries raw payload fixtures.

### Verify block

Three layers, one truth:

1. `invariants[]` — properties that must hold; `expression` is the machine
   form, `verification_status` the last verdict (`PASS` / `FAIL` / `PENDING`).
2. `verification_points[]` — the structured 四问 per expectation:
   `id` (`VP-\d{3}`) / `name` (看什么) / `target` (去哪看) / `source` (锚点机器名) /
   `operator` (`==`, `>=`, …) / `expected` / `severity` / `example_query`.
3. `expect{}` — **the authoritative expectation surface**. `freeze-check.mjs`,
   `audit.mjs`, `report.mjs` and `gen-view.mjs` all read it and nothing else, so
   a VP that disagrees with `expect` is a documentation bug, not a second
   opinion. `observe[]` lists the expectation keys in reading order.

`latest_run.results[]` is where a VP's `actual` / `status` / `message` live at
render time; the case file itself does not carry them on the VP.

### Execution block

`dependencies[]`: `name` / `type` (free text: `HTTP API`, `Database`, `LLM`, …)
/ `mode` (`MOCK` | `FAKE` | `LOCAL` | `REAL`) / `configuration` / `mock_behavior`.
API keys are referenced through environment variables — never inlined.

`tests[]`: `id` (`T-\d{3}[A-Z]`) / `case_id` / `type`
(`ACCEPTANCE` | `UNIT` | `INTEGRATION` | `REAL_DEPENDENCY` | `E2E`) /
`framework` / `file` / `status` / `last_run` / `failure_reason`.
`status` defaults to `PENDING`. `EXPECTED_RED` means the feature is not
implemented yet and the red is intentional — it is not the same as an
`UNEXPECTED_FAILURE` (fixture or environment broke) and must not be reported as
one.

### Result block

`latest_run` inlines the last execution when the case file is the only artefact
being passed around; otherwise leave it out and pass a runs file (see
*runs.json*). Fields: `status`, `started_at`, `duration_ms`, `environment`,
`failure_stage`, `logs`, `results[]` (`vp_id` / `source` / `expected` / `actual`
/ `status` / `message`).

The case's own verdict is aggregated from its VPs — the **first failing VP is
the debug entry point**. A run never writes back into `lifecycle` or `health`.

### Narrative keys

`narrative` and `units` are display-only. The v2 fields win when both exist;
narrative is the fallback for v1 files.

| key | purpose | missing → |
|---|---|---|
| `scene` | one plain sentence: what this case guards against | heading only, scene line omitted (unless `description` exists) |
| `when` | one plain sentence for the action(s) | rendered from the raw `when` data |
| `where` | plain label per observe point | falls back to the machine name |
| `units` | display unit per observe point; `stock_<ITEM>` for the given-prose | decimals get ` 元`, others get none |
| `group` | legacy scenario category | `business` is used instead; `未分类` when both are absent |

`units` may sit at the case's top level or inside `narrative` — the top level
wins.

### v1 → v2 fallback rules

A v1 case (only `observe` + `expect`) is loaded without rewriting it:

| v2 field | derived when absent | invented? |
|---|---|---|
| `verification_points[]` | one `VP-00n` per `expect` key: `name` ← `narrative.where[key]`, `source` = the key, `operator` = `==` | no, equivalent mapping |
| `lifecycle` | `FROZEN` when a frozen snapshot exists, else `DRAFT` | no — the only lifecycle fact a v1 file implies |
| `health` | `BROKEN` when an Expect is undecidable, else `ACTIVE` | no |
| `latest_run` | computed from the runs file when one is passed (per-anchor `expected` vs `actual`, `numEq`) | no — labelled with its source |
| `business` | `narrative.group` → `未分类` | no |
| `description` | `narrative.scene` | no |
| `type` / `priority` / `verification_level` / `tags` / `invariants` / `dependencies` / `tests` | left empty (UI shows `—` or omits the block) | **no** |

Derived values are produced by the loader, never read from the file, and a
derived VP is tagged `derived: true` in the generated model so nothing
downstream mistakes it for authored data.

### Decidability rule (iron law 5)

An Expect value must be decidable: a number, a boolean, or a short ASCII
symbol (`success`, `PAID`). A value containing non-ASCII text or spaces is a
description, not an expectation — the view red-cards it and the draft is
rejected until fixed. Fix it by splitting into concrete observable points.

## Frozen file

Plain text, comments allowed, one `frozen:` block in the same YAML subset:

```
# Case Freeze 清单 —— CASE-003/005 已于 2026-09-18 由需求方确认
# 自此 Expected 不得变更；改实现、重构、加日志均可。
frozen:
  CASE-003:
    checkpoint_a_price: 88.0
    checkpoint_b_after_coupon: 68.0
    checkpoint_c_total: 74.8
```

`freeze-check.mjs` diffs every frozen case against the case file: changed
values, missing keys, or missing cases are red-carded (exit 1). A frozen id
with no matching case usually means the cheat — editing Expect to make a test
pass. A frozen id also forces `lifecycle: FROZEN` when the case does not declare
one.

Frozen protection is a *human* gate: after freeze, Given/implementation/tests
may change freely, but Then / Expected / Invariant may only change through a new
case version plus a fresh human confirmation.

## Anchors

`CASE-003:checkpoint_c_total` — case id + observe-point name. It is the same
name a VP carries in `source`, so a VP row and a test ID point at the same
thing. The view renders a ⚓ button per row that copies the anchor; the user then
tells the agent "CASE-003:checkpoint_c_total 应该是 76.8" and the agent edits the
YAML. Test IDs and `@DisplayName`s carry the same anchor so reports aggregate by
CASE.

## runs.json

One execution's observed values, keyed by anchor. Consumed by the explorer (and
by `gen-view` variants that render results) when a case has no inlined
`latest_run`:

```json
{
  "_meta": {"source": "demo 2026-09-18-case-demo/shop/service.py 实跑", "captured": "2026-09-19 01:51"},
  "CASE-001:api_return": "success",
  "CASE-003:checkpoint_c_total": 76.8
}
```

An anchor missing from the file leaves its VP `NOT_RUN`; the case verdict is
`FAIL` if any VP fails, `PASS` if at least one ran and none failed, `NOT_RUN`
otherwise. Values are compared with `numEq`, so the text-preserved decimal
`74.8` compares numerically against a JSON number.

## Tooling

| script | reads | writes |
|---|---|---|
| `yaml-lite.mjs` | — | the shared parser (`parseYaml` / `numEq` / `isUndecidable` / `isDecimal`) |
| `explorer.mjs` | cases + frozen + runs | `case-explorer.html` — the only consumer of the v2 fields |
| `gen-view.mjs` | cases (+ runs) | the six案卷审阅 styles; v1 `observe`/`expect` only |
| `freeze-check.mjs` | cases + frozen | red-card report, exit 1 on drift |
| `audit.mjs` | cases + test sources | coverage report (UNOWNED / ORPHAN / LITERAL), exit 1 on findings |
| `report.mjs` | console output of a test run | per-anchor result table |

`explorer.mjs`:

```
node explorer.mjs --cases cases.yaml [--frozen frozen.md] [--runs runs.json]
     [--title <品牌名>] --out case-explorer.html
```

The HTML is single-file and self-contained (data and client code inlined, no
CDN, no build step, no external requests). It is read-only with respect to the
case file: UI preferences go to `localStorage`, review notes to `IndexedDB`.

## Adapter templates

Iron law 2: **zero expectation literals**. Assertion values are loaded from
the case file; the anchor string is the one allowed literal. Mock anything
outside the observation surface (gateways, MQ, LLM, clock) — never the
observation surface itself (balances, stock, orders, event log).

### Java (JUnit 5)

```java
import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Golden-case adapter. Expectation values come ONLY from the case file —
 * zero expectation literals here (anchor strings are the one allowed literal).
 * Mock freely OUTSIDE the observation surface; never mock the ledger itself.
 */
public class ShopGoldenCaseTest {

    static final CaseSet CASES = CaseSet.load("cases/cases.yaml");

    @Test
    @DisplayName("CASE-001:api_return")
    void case001_apiReturn() {
        GoldenCase c = CASES.get("CASE-001");
        assertEquals(c.expect("api_return"), run(c).observe("api_return"));
    }

    @Test
    @DisplayName("CASE-003:checkpoint_c_total")
    void case003_checkpointCTotal() {
        GoldenCase c = CASES.get("CASE-003");
        assertEquals(c.expect("checkpoint_c_total"), run(c).observe("checkpoint_c_total"));
    }

    // One fixture per case: builds `given`, performs `when`, returns the
    // observation surface. Fixture code is adapter-owned — mock the payment
    // gateway and the clock there, never the balances/stock/event log.
    private ShopResult run(GoldenCase c) {
        return new ShopFixture(c).run();
    }
}
```

New observe point ⇒ new test method, same shape. `audit.mjs` flags any
assertion literal that shadows a golden value.

### Python (pytest)

```python
"""Golden-case adapter: expected values load from the case file (zero
expectation literals here). Test IDs carry the anchor:
test_golden[CASE-001:api_return]. Mock only OUTSIDE the observation surface.
"""
import pytest

from case_loader import CaseSet

CASES = CaseSet.load("cases/cases.yaml")
POINTS = [(c.id, p) for c in CASES for p in c.observe]


@pytest.mark.parametrize(
    ("cid", "point"), POINTS, ids=[f"{cid}:{p}" for cid, p in POINTS]
)
def test_golden(cid, point, shop):
    result = shop.run_case(cid)  # fixture: builds given, performs when
    assert result.observe(point) == CASES[cid].expect(point)
```

## Report input contract

`report.mjs` parses plain console text. Any line whose test name/display name
contains an anchor counts:

- Gradle/JUnit: `ShopGoldenCaseTest > CASE-001:api_return PASSED|FAILED`
  (following indented lines attach to the failure as its detail)
- pytest short summary: `FAILED tests/test_shop.py::test_golden[CASE-001:api_return] - assert ...`
- pytest verbose: `tests/test_shop.py::test_golden[CASE-001:api_return] PASSED`
