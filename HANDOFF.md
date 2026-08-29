# Dashboard Handoff

Document version: 2026-08-28 (revision 3)
Authors: kanthord engine agents (engine repository)
Addressed to: dashboard team (apps repository)
Reads: `apps/HANDOFF.md`

This document lists every decision, obligation and confirmation the engine needs from the dashboard
team and cannot supply itself. A different team maintains the engine; the dashboard team does not
have the engine's context. This document is the authoritative source for what the engine is waiting
on.

**It is a register of open requests, not a record of answers.** An entry the dashboard resolves is
deleted from the next version, completely. Nothing here restates a settled question, and nothing here
reports work the engine has already specified. An answer lives where behaviour lives: the epic files
under `.agents/plan/epics/`, `docs/proposal/`, and the published OpenAPI document. The dashboard's
commitments live in `apps/AGENTS.md`, section `## Commitments to the engine`.

## Open requests

**None. The engine is waiting on nothing.**

## Document Schema

Each entry carries:

- **Priority** — `BLOCKING` (engine work is stopped, or will ship wrong without an answer) or
  `NICE-TO-HAVE` (the engine has a default and will proceed on it)
- **Status** — `NEEDS-DECISION` (the choice is the dashboard team's) or `NEEDS-COMMITMENT` (the
  engine's design depends on the dashboard doing something)
- **What the engine needs** — the answer or the action, stated as one thing
- **Why the engine cannot settle it** — the constraint, with a file and a line
- **What the engine does in the meantime** — the default it proceeds on if no answer arrives
- **Cost of a late answer** — what has to change if the answer arrives after the epic merges

Schema justification: this mirrors the schema of `apps/HANDOFF.md` so one reader parses both. Two
fields differ, because the direction differs. `apps/HANDOFF.md` asks for capability and therefore
carries request and response schemas. This document asks for decisions, so it carries the default the
engine proceeds on and the cost of changing it later — the two facts a decision-maker needs.
