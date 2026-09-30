# Review Definitions

Semantic review splits "how well is this case written" into six falsifiable
propositions. Each review round judges exactly one proposition; the reviewer
must cite evidence from the original text and produce a counterexample that
could break the design. Summary verdicts like "mostly reasonable" or
"generally good" are not allowed — they are unfalsifiable and therefore
count as not having reviewed at all.

The six definitions attack six different failure modes; they are not six
repetitions of the same check:

1. **Scenario reality** — is the scenario invented?
2. **Business truth ownership** — were the golden values stolen from the
   implementation?
3. **Verification sufficiency** — can the verification points be satisfied
   literally?
4. **Cross-case induction** — are the categories and tags induced from the
   full case set?
5. **Fresh-reader review** — can a reader who left the chat understand it
   two weeks later?
6. **Anti-cheat review** — how could the AI turn a wrong business decision
   green?

The criteria for judging live here; when each round runs, see the five-stage process
in `SKILL.md`. Machine-checkable facts (anchors, `expect` literals, snapshot
drift) belong to the scripts; these six definitions review semantics only.
A green script does not mean they pass.

## Unified output

Each review round ends by emitting the following structure. Field names are
adjustable; none of the meanings may be dropped:

```yaml
verdict: PASS | FAIL | UNKNOWN
claim: the single proposition being judged this round
evidence:
  - fragment, field, or source from the original text
counterexample:
  - a scenario that would break the current design
missing_decision:
  - questions only the user can decide
suggested_change:
  - whether to change business content, categories, verification points, or
    downgrade to an invariant
```

`verdict` has exactly three values: PASS = the proposition holds under the
current evidence; FAIL = an instance of the failure condition was found;
UNKNOWN = the proposition depends on a decision only the user can make.
Scores, stars, and any fuzzy conclusion between PASS and FAIL are forbidden.
For UNKNOWN, the `missing_decision` entries must quote each question verbatim
and hand it to the user; the model must not fill it in on the user's behalf —
filling it in is forging a business judgment.

## Review receipt

A review cannot pass on the drafting model's own say-so. The review result is
attested by a **review receipt**, produced by a fresh-context reviewer who
took no part in creating or implementing the reviewed artifact. By receipt
type, independence means specifically: the Draft receipt's reviewer did not
draft the case; the View receipt's fresh reader took no part in the original
discussion and stays blind-read, and the cross-case reviewer did not author
the vocabulary under review; the Adapter receipt's reviewer did not write the
adapter/execution chain (they need not be someone other than the drafter).
A receipt attests what independent review was done, not that the business
facts themselves are true; it records review metadata and raw evidence
references only. Durable business provenance lives elsewhere: schema v3's
`business_basis` + `expect_basis` (written into the case, protected by the
freeze-check); the receipt does not replace them, and they do not replace the
receipt.

Three types, by stage:

- **Draft receipt**: scenario reality, business truth ownership,
  spec-level verification sufficiency (rounds 1–3). Produced at Stage 1.
- **View receipt**: fresh-reader review and cross-case induction
  (rounds 4–5). The fresh-reader round must come from an independent blind
  read.
- **Adapter receipt**: implementation-level verification sufficiency and
  anti-cheat (rounds 3 and 6 re-run against the adapter). Can only be
  produced after the adapter exists — before sealing there is no single
  receipt showing "all six rounds passed"; any claim that "one receipt
  summarizes all six rounds" is invalid.

Every receipt's header must record:

- receipt type and the definitions actually run;
- reviewed case ids + versions;
- the exact digest / immutable artifact id of the reviewed input (generated
  by the host/harness; when no input can be bound, the receipt must not be
  treated as evidence for the current version);
- reviewer role/agent/session, invocation source, and relationship to the
  reviewed author;
- raw evidence references (transcribed from the original source, not copied
  from the drafter's packet);
- verdicts, counterexamples, unresolved decisions.

Any change to a case / view / adapter invalidates the affected verdicts and
requires re-running the corresponding definitions: a v1 receipt does not
endorse v2 YAML. Where receipts live is provided by the host as the storage
location for review artifacts (a hapi team's plan-task dossier is one
instance, not the only home; the user may specify a retention path); they do
not go into `.hapilon/go-case/` and add no schema fields. Independence can
only be recorded, never proven by prose: when the host cannot mechanically
verify reviewer identity, it must disclose to the user that "independence was
not mechanically verified"; a drafting session declaring itself fresh or
forging a signature does not count as independent review. When a single
session has no second context, hand the input-bound review bundle to a
separate session/agent the user opens.

Status boundary for business evidence (one status per item, never double
labeled): if the reviewer cannot open a confirmation's original source, that
business evidence is UNKNOWN and goes to the user for verification; a review
round that never ran, or a receipt that should exist but is missing, is a
process FAIL, not UNKNOWN. Sealing must cite Draft + View receipts matching
the frozen input; the drafter saying "the user confirmed it" or "all six
rounds passed" is not evidence.

---

## 1. Scenario reality

**Proposition**: every case describes a real business scenario that would
actually happen, with a concrete initial state, a triggering action, a
business risk, and an observable outcome.

**Risk protected**: fake scenarios waste sealing quota and, worse, fabricate
coverage — "all cases green" hides the fact that the incident we actually
need to prevent was never written up as a case.

**Failure conditions** (any one means FAIL):

- The scenario is a restatement of a requirement clause with no concrete
  state or trigger — "the order fails when the user's balance is
  insufficient" without concrete numbers in `given` and a concrete action in
  `when` is just a clause cut into three pieces.
- The scenario has no business consequence: nobody is harmed when it goes
  wrong.
- The scenario was invented by the AI to fill a coverage category (the five
  observation-point types, the `type` enum).
- One case packs in multiple unrelated scenarios.

**Evidence that must be cited**: `given` (including `preconditions`),
`when`, `description`, `then`, and the source (which requirement, which
incident, which user's exact words). A case whose source cannot be stated is
suspect by default.

**Killer question**: read `description` and `then` to the business-side stakeholder —
will they say "yes, that's exactly what happened last time", or "we don't
have that scenario"? Then build a counterexample: find two real situations
that both satisfy the current description but have different correct
outcomes. If you can, the context boundary is too loose, the scenario is not
specific enough, and the state or trigger needs tightening. Read-only
operations (queries, reports, system jobs) can be valid triggers on their
own; they are not judged fake merely for "having no write action".

**No UI participant required**: system jobs, scheduled data updates, and
incident regressions are real scenarios — but they equally need a concrete
state, trigger, business risk, and observable outcome. "The system runs a
batch at night" is not real; "the inventory snapshot job truncates stock=3
to 0 and silently drops two records" is.

**Verdict**: every case has a concrete state, trigger, risk, and outcome,
and its source is traceable → PASS. Any case hits a failure condition →
FAIL. Scenario reality itself needs no user ruling, but case sources are
user knowledge — when the model cannot confirm the source → UNKNOWN, with
`missing_decision` asking the user "which real requirement or incident does
this scenario correspond to".

## 2. Business truth ownership

**Proposition**: every `expect` golden value comes from the user's business
judgment; not a single value was copied from implementation output, a run
snapshot, or the model's own reasoning.

**Risk protected**: this is the entire difference between golden-case and
golden-master testing. Once a golden value comes from the implementation,
the case degrades into self-approval — "the test agrees with the
implementation" — and green loses all meaning.

**Failure conditions** (any one means FAIL):

- Any `expect` value equals an actual output of this implementation, and the
  user never independently provided that value.
- A golden value claims user confirmation, but the reviewer cannot verify it
  at the original source: the confirmation record must point to a directly
  openable source (conversation turn/message id, file path + line or anchor,
  URL + stable anchor, a business record provided by the user), and the
  reviewer transcribes from that original source, not from the drafter's
  packet. Unopenable original source → that evidence is UNKNOWN. The sentence
  "the user confirmed it" is not evidence by itself.
- A golden value is of the "mechanical derivation" type but no derivation
  chain is shown; or a fresh reviewer independently recomputes the chain and
  it does not match.
- A value marked as a guess in the draft silently becomes a certain value
  without the guess marker in later rounds.
- Post-freeze changes (recorded in `changes`) have no corresponding explicit
  confirmation statement from the user.

**Acceptable evidence for a golden value** (by type, collectively the
**business basis**, answering "why is the expected value correct"):
confirmed bases are registered in schema v3's `business_basis` and bound to
specific expect keys via `expect_basis`; the review must check every
`expect_basis` entry so each golden value can be traced along its binding to
a citable basis entry. The VP `source` field in the schema refers
specifically to where a runtime observed value is taken from; do not put the
business basis into `source`:

1. **Directly confirmed by the user** — values or rules whose confirmation
   record points to an openable original source; confirming the document
   name is not enough — the user must also confirm the interpretation,
   scope, and exceptions this case adopts.
2. **An authoritative source whose applicability the user confirmed**
   (regulations, contracts, product documentation, real business data) —
   cite the original text or a stable anchor; what the user confirmed
   includes not just "which clause applies" but also that clause's
   interpretation, scope, and exceptions for this case's facts.
3. **Mechanically derived** — only deterministic computations with no
   branches and no business choices. Derive by deterministic steps after the
   user confirms the rules and inputs; every rule, parameter, rounding mode,
   priority, exception, and truncation in the chain must each point to
   confirmed business basis; any choice present means UNKNOWN (e.g. the
   model adds banker's rounding on its own while the user never confirmed a
   rounding rule). The derivation chain must be shown; a fresh reviewer's
   independent recomputation only verifies arithmetic and does not replace
   business confirmation. A chain that is correct and contains no
   unconfirmed choices is attributable on its own — the user need not dictate
   every result value verbatim.
4. **Guess or model proposal** — can only be UNKNOWN, must never be sealed.

**Evidence that must be cited**: for each `expect` value, the original
source record for type 1–3 (the confirmation text and its openable source,
the source anchor, or the step-by-step derivation chain), matching the
`expect_basis` bindings in the case one by one: every expect key is bound to
a basis entry that exists and has complete fields; each derivation's
`based_on` chain is complete and acyclic; the `changes` log is checked line
by line; the list of values declared as guesses in the draft and what became
of them afterwards. Binding gaps at DRAFT stage must be visible on the
Explorer and confirmed item by item; a frozen case with gaps is FAIL.

**Killer question**: pick a golden value at random and ask "where did you
get this number?" The answer must be type 1–3 with a citable record
produced. If the answer is "that's what the code logic says", "that's what
it printed", or an unverifiable "the user confirmed it" — FAIL.
Counterexample: deliberately change a coefficient in the implementation and
re-run — if the case's golden values ever moved with the implementation,
ownership is broken.

**Verdict**: every value falls into type 1–3, the mechanical derivation
chains recompute correctly with no unconfirmed choices → PASS. Any value
falls into type 4, or its original source cannot be opened → that value is
UNKNOWN, with `missing_decision` listing "please confirm what X should be
and on what basis"; reasoning must not fill in its place. When any value's
ownership in a case is broken, all remaining values are treated as suspect
until each is re-confirmed one by one. Which values count as "mechanical
derivation after the user confirmed rules and inputs" is delimited by the
user per category — that is a business judgment the model must not make on
its behalf. A review round that never ran, or a missing receipt, is a
process FAIL (see the status boundary under "Review receipt"), not UNKNOWN.

## 3. Verification sufficiency

**Proposition**: the case's verification points together prove the business
outcome `then` claims, and no single verification point can be satisfied
literally by a business-wrong implementation.

**Risk protected**: verification points that are too weak let a wrong
business decision go all green — `api_return == success` passes while the
money was charged twice. This is the round that reviews "all verification
points pass, yet the user would still call the business wrong".

**Failure conditions** (any one means FAIL):

- A business outcome claimed by `then` has no corresponding observation
  point; the observation points cover only a subset of `then`, or
  something unrelated.
- An observation point also passes on an obviously wrong implementation:
  it asserts "there is a return" but not "what the return is", or asserts a
  single value but not a conservation (balance totals, charge counts).
- A property that should be an `invariant` (money conservation, idempotence,
  non-negativity) is written as an ordinary verification point of a single
  case, losing protection the moment the input changes.
- The verification points are so redundant with each other that they test
  the same thing under different names.

**Evidence that must be cited**: a mapping of each `then` clause against
`observe` + `expect` (and `verification_points`, `invariants`); each
verification point's `target` and `operator`.

**Killer question**: write an implementation that is "business-wrong but
literally compliant" — make the bad thing `then` describes happen, and see
which verification points stay green. If one wrong implementation can go
all green, verification is insufficient. Counterexample construction:
translate every plain-language clause of `then` into the minimum observation
point it requires; the missing one is the hole.

**Verdict**: every `then` clause has verification points and the
counterexample construction does not topple → PASS. A wrong implementation
that goes all green exists → FAIL, with `suggested_change` naming which
observation point to add or which verification point to promote to an
invariant. Whether some property should be promoted to an invariant (a
shared constraint affecting all cases) → UNKNOWN, left to the user — an
invariant changes the judgment surface of the entire case set.

## 4. Cross-case induction

**Proposition**: the case set's `business` categories and `tags` come from
induction over the complete case set and the business questions; not a
single category or tag was plucked from keywords in a single case's body
text.

**Risk protected**: categories induced from a single case only make sense
inside that case and are noise at retrieval time. More insidiously, field
names and enum values sneak into tags, passing implementation details off as
business vocabulary.

**Failure conditions** (any one means FAIL):

- A tag describes a single case's plot — such plot words are demoted back
  to `description`. Single-case use by itself only triggers a semantic
  re-check, not an automatic fail: the word must be a stable business
  concept with a clear retrieval purpose, confirmed by the user as a new
  term. High-frequency field names / protocol identifiers cannot become tags
  just by appearing in many cases. Occurrence counts only provide a
  re-check signal; they do not take part in the final ruling.
- Field names, enum values, protocol strings, or verdict words became
  `business` or `tags`.
- Two tags express the same thing ("pay" and "payment" coexisting), or the
  difference between a new word and an existing one cannot be stated.
- A new word fails to answer three things: what it expresses, how it
  differs from existing words, and why the user would filter by it.

**Evidence that must be cited**: the `business` × `tags` distribution
matrix across the full case set; usage counts and the case lists for every
challenged word; the existing vocabulary.

**Killer question**: cover up the tag's origin and ask "would the business
side say this word in a planning meeting?" Then ask "if this case were
deleted tomorrow, should this tag still exist?" If not, it is a single-case
footnote. Counterexample construction: a high-frequency field name can
appear in ten cases and meet the count threshold, yet it is implementation
vocabulary, not a business concern — occurrence count is a signal, not a
ruling.

**Verdict**: the full-set matrix has no single-case footnote tags, no
synonym splits, and no implementation vocabulary mixed in → PASS. Any
failure condition hit → FAIL. **The final decision to create a category,
create a tag, or merge synonyms is always UNKNOWN and goes to the user** —
the vocabulary belongs to the user and the model can only propose:
`missing_decision` lists "create X / merge into existing Y" for the user to
choose.

## 5. Fresh-reader review

**Proposition**: a reader two weeks later, who took no part in this
conversation, looking only at the narrative static view (`gen-view --style
narrative`) or an equivalent SPEC-only export (or, when no view was
generated, the human-prose fields in the case files), can independently
answer: what is this scenario, what is the risk, what is the correct result,
and what remains uncertain. The full interactive Case Explorer must **not**
be used as blind-read input: its Drawer tab shows verification points and
`business_basis` directly, and this round must not see either.

**Blind-read precondition**: the fresh reader must not share context with
any reviewer who has already read the YAML machine fields, the chat, the
business basis, or the verification points. It runs in an independent
context, before any round that opens machine fields; it sees only (a) the
narrative static view or an equivalent SPEC-only export (the human-prose
fields when no view exists) and (b) a standalone unresolved-decisions sheet
in Draft state — the sheet lists open questions only and does not explain
the body. It does not read chat logs, source YAML machine fields, or other
rounds' evidence. A reviewer who has already read the YAML cannot
retroactively run this round; a fresh blind-read context must be started
anew. A post-freeze view must not contain unresolved unknowns.

**Risk protected**: a case's long-term value is that it survives without
the chat log. A case that only makes sense with the context is already dead
by the two-week mark; what remains is a string squatting on sealing quota.

**Failure conditions** (any one means FAIL):

- `description` / `narrative.scene` missing, or containing references only
  this conversation understands ("same as above", "like CASE-002 but
  reversed", "change it as you just said").
- Implementation or protocol identifiers running bare in the human prose:
  invented protocol strings or internal field names appearing unexplained
  in sentences the reader must read.
- Unknowns unmarked: which expects are guesses, which scenarios are
  uncovered — the fresh reader cannot tell fact from guess. (Confirmed
  bases live in schema v3's `business_basis` / `expect_basis`, visible in
  the Explorer; unconfirmed guesses, source excerpts, and missing decisions
  are staged in the review packet / receipt and in the unresolved-decisions
  sheet in Draft state — the latter is the legitimate evidence surface for
  the "what remains uncertain" question. Do not stuff guesses into
  `description`, VP names, or `changes` to pass them off as confirmed
  basis. A frozen case must not retain unresolved guesses — every one must
  be confirmed by the user, deleted, or explicitly excluded from this
  case.)
- Observation points carry machine names only, and `narrative.where` gives
  no human labels.

**Evidence that must be cited**: the visible content of the narrative static
view / SPEC-only export; only when no view was generated, the human-prose
fields of the case files. This review must not consult chat logs, nor open
the source YAML's machine fields to patch in meaning for the human. Check
label coverage for each machine name; check where guess values are marked.

**Killer question**: send the file to a colleague who took no part, with no
verbal add-ons. The first place they get stuck is the FAIL evidence.
Counterexample construction: replace each reference in `description` with
"___" — can the reader still reconstruct the scenario? Only what survives
reconstruction is self-contained.

**This is a semantic review, not a banned-word grep**: no banned-word list
catches an unreadable sentence built from harmless words like "as you said".
The human-voice exit test, in this round's form: the reader can still
understand the scenario, the risk, the correct result, and the unknowns
without the chat log.

**Verdict**: all four fresh-reader questions (scenario / risk / correct
result / unknowns) are answerable → PASS. Any one unanswerable → FAIL.
Which technical identifiers may be shown to external readers → UNKNOWN,
left to the user to set the classification level; whether the explanation
is clear enough is judged by the reviewer against this definition — writing
problems are not escalated to the user.

## 6. Anti-cheat review

**Proposition**: there is no path by which the AI can run this case green
and report a pass while the business judgment is wrong.

**Risk protected**: the AI's pressure always points toward turning green.
Deleting observation points, changing expected values, lowering severity,
over-mocking — each can push a wrong business decision through every
mechanical check. This round reviews the review and execution process
itself.

**Failure conditions** (any one means FAIL):

- An observation point was deleted or weakened (operator changed, expected
  changed, severity lowered) without the user's explicit confirmation —
  check line by line against the `changes` log.
- Dependencies are mocked inside the observation surface (iron law 1): the
  balance, inventory, orders, or event ledger itself is mocked, so what is
  under test becomes the mock.
- An assertion value appears in adapter code (iron law 2's LITERAL), taking
  expectations outside the user's control surface.
- Red is moved out of the report — marking the case STALE / DEPRECATED,
  `--only`-ing out failing cases — while the business problem itself is
  unsolved.
- `verification_level` or `priority` was downgraded (L3→L1, P0→P3), or
  `dependencies[].mode` was switched to an easier-to-pass mode
  (REAL→MOCK): the observation surface is untouched while the business
  guarantee quietly degrades, with no explicit record from the user.
- The adapter's comparison direction was weakened (`==` loosened to `<=`,
  `!=` replaced by a one-sided check), letting a wrong implementation go
  all green.
- source / anchor was moved to a position easier to pass but not
  probative of the business (moved to a tautology or a business-irrelevant
  observation point).
- A `business_basis` entry's content was rewritten or an `expect_basis` was
  rebound — swapping a strict basis (user's verbatim confirmation) for a
  loose one (an "authoritative" source of unclear origin, a loosened
  derivation): the expected value is untouched while the guarantee has
  degraded. After freezing, the freeze-check red-flags such changes
  (BASIS-CHANGED / BASIS-REBIND); before freezing, this round's diff
  comparison catches them.
- The case claims to protect a rule, range, or invariant but verifies only
  a sample input, not the boundary (tests only the number the user gave,
  not boundaries, negatives, empty input). A legitimate single-point golden
  fact — where the rule pins only that point — is not a failure for
  verifying just that point.
- Reviewer and implementer share an unverified assumption: fresh context
  isolates the conversation, not the priors; round 2's ownership evidence
  is the only interrupt point — if the ownership round was not done
  rigorously, check here whether the two rounds' assumptions share a
  source. This residual risk does not vanish because of fresh context: the
  receipt records honestly that "reviewer and implementer may share
  assumptions", and important cases add an independent reviewer.
- The observed values in `latest_run` / runs.json match the expects so
  exactly that copying them back is worth suspecting, and the user has no
  independent confirmation record for that batch of values.

This round is executed by a **fresh reviewer who did not write the
adapter**, the same requirement as stage 4; the adapter author running
anti-cheat themselves cannot produce a valid Adapter receipt.

**Evidence that must be cited**: the `changes` log compared against this
round's diff; the case's `business_basis` content and `expect_basis`
bindings compared against the previous version (or the frozen snapshot) —
was a basis swapped for an easier-to-pass source, was a binding re-pointed
to an irrelevant basis; the assertion surface in adapter code and its real
comparison semantics (direction, operator, whether it asserts the business
surface); dependency modes (`dependencies[].mode`), `verification_level`,
and `priority` compared against the previous version; the mock boundary
list (what is mocked, whether the observation surface is inside it); usage
records of `--only` and lifecycle changes; this round's changes compared
against the previous review receipt / frozen snapshot / `changes` records.
**The diff of frozen.md itself is also on the mandatory checklist**: snapshot
entries rewritten or deleted in the same change trigger no red flag (the
script uses it as the comparison baseline; it cannot prove itself
untouched), so the reviewer must personally inspect frozen.md's diff —
changing the baseline and changing the expectation are the same cheat. Do
not PASS without a baseline to compare against — turn UNKNOWN and state
plainly what evidence is missing.

Round 2 reviews "why the expectation is correct" (ownership); this round
reviews "did the implementation or the process bypass the already-confirmed
expectations" (tampering and degradation). The same change is examined by
both rounds, but the evidence surfaces differ: the ownership round asks for
the source; this round asks for the path.

**Killer question**: assume my current business judgment is wrong; walk
the execution chain step by step — which step would stop me? If no step can
be named, FAIL. Counterexample construction: let an implementer who only
wants to go green (may modify YAML, adapter, and dependency declarations;
may not touch frozen.md) try to go all green, and record every means they
used to succeed — each successful means is a hole.

**Verdict**: all four paths — weakening, mock overreach, literals, silent
degradation — are blocked by mechanism → PASS. Any one is viable → FAIL,
with `suggested_change` naming which hole to plug. Whether a given spot is a
design tradeoff (e.g. allowing the mock variant of an A/B dual adapter to
go first) or a hole → UNKNOWN, left to the user to rule on the tradeoff
boundary.
