---
name: recon
description: Recon a target area the user names — build a structured understanding, then report it by mouth (no files written) to ground a follow-up discussion.
disable-model-invocation: true
---

# recon

Directed reconnaissance of a target area the user names. Build a structured understanding, then **report it by mouth** — nothing written to disk. The report only grounds the next conversation.

A target can be anything with internal structure — a code module, a skill or doc, a config file.

## Depth

The user's wording sets the depth; with no signal, default to **medium**.

| Level | Trigger words | What you do |
|-------|---------------|-------------|
| quick | quick, skim, glance | Read the entry files plus the core types / interfaces / config. Overview only. |
| medium | (default) | quick, then trace the core flow, the key relations, and the patterns shaping the area. |
| deep | deep, thorough, careful | medium, then chase the full dependency graph, edge cases, hidden assumptions, and latent problems. |

## Process

### 1. Confirm the target

When the user's description is vague, clarify before reading:

- the concrete path or name of the target;
- the intent — what they want to understand, what the follow-up discussion is about.

**Completion:** target path/name and exploration intent are both stated; no remaining ambiguity would change *where* you read.

### 2. Recon the area

Read and analyse the target at the chosen depth with Read, Glob, and Grep. Decide the target's type first, then pick the analytical lens that fits.

**Completion:** every entry file and every core type / interface / config the depth demands has been read; nothing on that depth's reading list is unread.

### 3. Report by mouth

Deliver the report in the structure below.

**Completion:** every section the depth requires is covered, the report ends on a readiness check, and no file has been written.

## Report structure

#### Responsibility

One line on the problem the area solves and the role it plays.

#### Structure

The key files and sub-directories in the area: the role each plays and how they relate.

#### Key paths

Adapt to the target's type:

| Target type | What this answers |
|-------------|-------------------|
| Code module | The core call chain and data flow, 2–5 key nodes. |
| Skill / rule / doc | Trigger → process → output; the key steps. |
| Config / resource | Who references it, what behaviour it shapes, the blast radius of a change. |

#### Patterns and Smells

Two faces of the same read — surface them as a pair.

**Patterns** — the organisational conventions, naming styles, and design decisions the area leans on; where it resembles its peers.

**Smells** — the unclear spots, latent contradictions, tech debt, and improvement opportunities (*quick* skips this face). Flag *where*, not how to fix.

#### Readiness check

One line declaring the recon done and waiting for direction. Free wording — e.g. "Got a read on this — what's next?"

## Boundaries

- **Speak, don't write.** The report lives in the conversation; leave the filesystem untouched. This is the skill's defining constraint.
- **Stay in bounds.** Read only the named target. Pull in a neighbour only when the user widens the scope.
- **Briefing, not document.** Each section runs only as long as the follow-up discussion needs. Cut anything it won't lean on.
