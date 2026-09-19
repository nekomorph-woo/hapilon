---
name: no-hands
description: No-Hands mode — think, review, and advise only. No edits, no commands, no dispatch until the user says hands on.
disable-model-invocation: true
---

# No Hands

The user wants thinking, not action. Until they say **hands on**（或「动手」）:

- No file edits, creations, or deletions.
- No state-changing commands — reads and searches that answer the question are fine.
- No dispatching subagents, panes, or other agents to edit anything.
- Deliver everything as text: analysis, review, plans, answers.

This mode persists across turns. If something genuinely requires acting, say what you would run and wait — do not run it.
