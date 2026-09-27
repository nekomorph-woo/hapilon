---
name: human-voice
description: Anti-slop writing discipline for user-facing Chinese and English output — plans, design docs, decision notes, READMEs, code comments, and naming (categories, tags, modules, domain terms). Use when writing any of those, when the user calls output "AI 味" / "AI slop", or for auditing or rewriting existing text (audit / rewrite verbs).
---

# Human voice

Write text a busy teammate would actually read. AI 味 is not a style preference: noun stacking, buzzwords, and template phrases make the reader distrust the content itself.

The rules here came from a 2026-09 four-source survey (arXiv vocabulary-shift studies, the Wikipedia editors' field guides, GitLab/Microsoft/Google style guides, and the X community). Every rule is testable: forbidden pattern + bad → good pair. No rule says "be natural" — that is not executable.

## Verbs

| Invocation | What it does |
| --- | --- |
| *(default)* | Write with the rules below. Before handing back any document or name, run the [gates](references/gates.md) once. |
| `human-voice audit <text or file>` | Read-only. Sweep the gates, report each hit with the quoted line, the violated gate, and a suggested fix. End with a 0-10 score. |
| `human-voice rewrite <text or file>` | Audit first, then rewrite per the findings. Show before → after for every changed passage; keep the facts and judgments, change only the expression. |

If the user gives no verb: 「太 AI 了，改一下」→ rewrite; 「帮我看看这段」→ audit.

## Rules (Chinese)

Read these before writing. Full checklist in [references/gates.md](references/gates.md).

Reader and voice: the reader is a teammate mid-task. Test every sentence — would you say it to a colleague out loud? If not, rewrite it. The core of AI 味 is no author present: flawless, risk-free-sounding conclusions with no concrete scene, no tradeoff, no source. Grounding each claim in a fact, example, or source beats any amount of polishing.

1. Fact first, judgment second. Bad: 该方案显著提升了系统的可维护性。Good: 改完后新增一种支付方式只动 payments/ 一个目录。
2. Be present: state what you saw, the dead end you hit, the option you rejected. No data? Say the limitation plainly — never 「效果良好」.
3. Verbs over nominalizations: 「进行配置」→「配置」;「完成数据的读取」→「读数据」;「上下文装配」→「把相关文件读进来」.
4. Parallelism ≤ 2 items. 「更快、更稳、更智能」→ keep only the one you measured.
5. 「不是 X，而是 Y」 usually collapses to just Y — unless the negation carries the
   diagnosis (「不是超时，是限流」 keep it). 互不可推的并列（验收标准、不变量）不是排比，不删。
6. No throat-clearing openers (「随着……的不断发展」「在……的背景下」) — first sentence carries the point. No grand closings (「综上所述」「未来可期」).
7. Don't list what one sentence says. Each list item is one sentence.
8. Comments and doc prose answer why, never restate what the code does.

Buzzword blocklist (one hit is a note, not a verdict; two hits in one piece, or
stacked with sentence/structure tells, is a violation. Exempt: quotes, code,
bad→good examples, real domain terms. The list drifts over time — prune it so it
doesn't become the new AI tell): 赋能、抓手、闭环、沉淀、打通、拉齐、链路、颗粒度、心智、底层逻辑、打法、范式、值得注意的是、不仅……更是……、总而言之、说实话、不得不说、有一说一.

## Rules (English)

Same bar, English tells:

1. No throat-clearing: "It is important to note", "This guide will walk you through" — the first sentence makes the point.
2. Claims become observable facts. Bad: "requests may fail under certain circumstances". Good: "requests return 429 when the rate limit is exceeded". Drop "seamless / robust / powerful / effortlessly".
3. Nominalizations: "in order to" → "to"; "the implementation of X" → "implementing X"; "utilize" → "use".
3. "not just X, but Y" / "it's not X, it's Y" — usually delete the negation, state Y.
4. Lists of three: cut to two or one.
5. Filler tells drift (delve, tapestry, pivotal, underscore, showcasing, fostering, testament, landscape) — a word that reads as padding gets replaced by a plain verb.
6. End on the fact. No "marks a new chapter" closings.
7. "serves as" / "boasts" / "features" where "is" would do — use "is".

## Naming (categories, tags, modules, domain terms — both languages)

- Use words the business side already says. The name answers "what is this", not "how it works inside". 静默降级 → 出错就跳过; 上下文装配 → 挑相关文件读进来.
- Say-it-out-loud test: if you wouldn't say the term to a colleague, rename it.
- One concept, one word. No self-invented compounds (中英混拼, verb-object pastes) — unpack them.
- Bare English abbreviations in Chinese sentences: say it in Chinese, or give a Chinese name on first use. Engineers say these out loud, so the say-it-out-loud test passes them wrongly — use the week-later reader test: understandable with no explanation?
- Session-grown code names and internal shorthand are fine mid-conversation but poison deliverables: on first use in a document, expand once for the reader who lacks the context.
- Before creating a category or tag, reuse what exists; a tag attached to only one item is a drafting failure, not a category.
