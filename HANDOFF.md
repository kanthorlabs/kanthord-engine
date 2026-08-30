# Dashboard Handoff

Document version: 2026-08-30 (revision 4)
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

### 1 — Convert the apps plan tree to the deliverable model

- **Priority** — `BLOCKING`
- **Status** — `NEEDS-COMMITMENT`
- **What the engine needs** — the dashboard team runs the plan conversion against the `kanthord-apps`
  plan tree, finishes every node the conversion report marks `manual`, and imports the result, before
  the engine ships EPIC 057.
- **Why the engine cannot settle it** — the plan tree is apps data, not engine data. The conversion
  also runs every generated check command at its intended commit, per
  `docs/workflow/worker.md` section 12, which needs real checkouts of the apps repositories. The
  engine ships the mechanism in EPIC 049 as `kanthord plan convert`; it cannot supply the repositories
  or the human judgement the report asks for. The tree is 4 initiatives, 29 objectives and 145 tasks,
  and no plan has run, so every node converts as unfinished work.
- **What the engine does in the meantime** — EPIC 049 ships `plan convert`, which writes a converted
  document set and `convert-report.json` and touches no database. The sequence is
  `kanthord plan convert <plan-dir> <out-dir> --template <file> --repo <name>=<path> --at <name>=<ref>`,
  then finish each `manual` node, then `kanthord plan import <out-dir>`. The report is free to produce
  and needs no repository, so running it as soon as EPIC 049 lands tells both teams the size of the
  job.

  **The conversion rule.** The engine's design document held this table until the design and the plan
  were separated. It is a migration rule for this one tree, and it is not a definition of
  `deliverable`.

  | Source                 | Result                        |
  | ---------------------- | ----------------------------- |
  | `worker: claude.te@1`  | `deliverable: test`           |
  | `worker: claude.swe@1` | `deliverable: implementation` |
  | `kind: initiative`     | `deliverable: expansion`      |
  | `kind: objective`      | `deliverable: expansion`      |
  | the `**Input:**` path  | `verify.paths`                |

  The conversion deletes `worker`. A plan document names no worker, and `assignment` replaces it as
  runtime state. A `worker` value outside the two rows above is not mapped, and the node reaches
  `manual` with the reason `worker-unmapped`.

  The `**Input:**` line names one file. A human confirms that the file is the whole write set of the
  node. An initiative and an objective take `paths: []` and `commands: []`.

  `verify.commands` derives from one template per repository. A `test` node inverts the command, so
  the command exits zero while the test fails. An `implementation` node runs the command of the `test`
  node it depends on. 8 implementation nodes declare no `depends_on`. A human pairs those, or they
  take an empty `commands` list.

  The conversion runs every generated command at its intended commit before it writes that command. A
  command that did not run leaves an empty `commands` list, and the node stays ineligible.

  **Six reasons put a node in `manual`:** `input-missing`, `input-ambiguous`, `test-dependency-missing`,
  `test-dependency-ambiguous`, `template-missing` and `command-failed`.

- **Cost of a late answer** — EPIC 057 makes `node.deliverable` and `node.verify_json` mandatory. Its
  migration counts the null columns per project and aborts at daemon startup, naming each project and
  each count. The daemon does not start until the tree is converted. Nothing is lost and nothing is
  corrupted, but the upgrade is blocked for as long as the conversion is outstanding.

### 2 — Re-read `capabilities` after the worker model lands

- **Priority** — `NICE-TO-HAVE`
- **Status** — `NEEDS-COMMITMENT`
- **What the engine needs** — the dashboard client reads `system.health.capabilities` before it calls
  the node operations, and treats a retired capability name as "this shape is gone", not as an
  unknown value to ignore.
- **Why the engine cannot settle it** — the worker model makes four changes that
  `docs/proposal/api/README.md:100` forbids inside `/v1`: `runId` and `fence` become required request
  fields on `node.renew`, `node.release` and `node.report`; `node.heartbeat` is replaced by
  `node.renew`; `worker-unknown` leaves the plan-finding enum; and `worker` leaves the node
  projection. A human ruled that there is no `/v2` and amended the policy in place: a change outside
  the permitted list is legal when a human records the ruling in the epic that makes it, and the
  capability name covering the affected operations is retired and replaced. The engine can announce
  the change; only the client can act on it.
- **What the engine does in the meantime** — EPIC 050 retires `external-drive` and declares
  `worker-model` over `node.claim`, `node.renew`, `node.release` and `node.report`. EPIC 057 retires
  `project-graph` and declares `project-graph-2` over `project.nodes` and `project.graph`. Both
  changes appear in the compatibility record in `docs/proposal/api/README.md`, and `system.health`
  carries them from the moment each epic merges. The engine ships no compatibility shim: no
  permanently-null field, no never-emitted enum member and no duplicate operation id survives.
- **Cost of a late answer** — a client that ignores `capabilities` and calls `node.heartbeat` gets a
  `404`, and one that omits `runId` gets a schema rejection naming the field. Both are loud and
  neither corrupts state, so a late answer costs a broken client session rather than data. A client
  that already reads `capabilities`, as `docs/proposal/api/README.md` asks, sees the retired name and
  stops before it sends the request.

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
