---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source. Cite the commit SHA (or doc version) the findings rest on, so a later reader can check for drift.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, write it to `docs/research/YYYY-MM-DD-<topic>.md` and tell the user where it went. If the user names a location, use that instead.
