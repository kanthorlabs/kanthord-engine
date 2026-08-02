# EPIC 008 — Project and plan

Status: **draft**.

## Goal

A human creates a project, binds a repository, imports a hand-written plan, exports it byte-identical, and re-imports it with a decision per node. A re-import never applies a partially valid graph.

This is the largest epic in phase 1, because it carries the conflict resolution of `docs/proposal/phase-1/plan-format.md`.

## Non-goals

- No merge base. A stale `fromRevision` is a hard `409 stale-revision`. The merge-base model is in `after-the-mvp.md`.
- No field-level choice. A choice covers a whole node.
- No deletion through import. An absent node is reported; `node.discard` deletes.
- No status in a plan document, anywhere.

## Stories

- **Project use case** — `project.create`, `project.list`, `project.show`, and `PUT /projects/:id/repositories` to replace the bound set.
- **Graph service on graphology** — the interface, the in-memory model, and the traversals the rest of the epic uses.
- **Document parse** — YAML frontmatter, the body, and the `## Acceptance criteria` split. Body normalization: CRLF and lone CR become LF, and the body ends with exactly one LF. Trailing spaces survive.
- **Submitted path grammar** — a relative POSIX path under `plan/`, ending in `.md`, with no empty, `.` or `..` segment, no backslash and no NUL. Case-sensitive. A duplicate path is `422 plan-invalid`. Array order carries no meaning.
- **Validation** — schema, cycles, unresolved references, unknown worker, unknown repository, duplicate identity, `repo` on a task, missing `repo` on an objective, an objective with no task, an initiative with no objective. Every finding is collected; validation never stops at the first.
- **Identity minting and reference resolution** — ULID first, then relative path. An unresolved or ambiguous reference fails. One ULID payload under two kind prefixes is `422 identity-kind-mismatch`.
- **Canonical rendering** — the frontmatter key order, double-quoted scalars, the sorted `depends_on` block sequence, LF, one trailing LF, and the canonical path derivation with `slug(title)`, the full lowercase ULID per segment, and the Kahn ordinal of width `max(2, digits of the sibling count)`.
- **`plan.validate` and the suggestion engine** — the per-case suggestion table, the differing field names per node, the legality of each choice with its reason, the provisional identities for new nodes, the document hash, and the topology revision. A suggestion set that builds an invalid graph is repaired by resetting each invalid connected component to `database`, repeated until valid.
- **Candidate graph validation** — build the whole graph from every choice and re-run the full validation over it. Apply nothing unless the whole candidate is valid. `422 choices-invalid`, and never a silent repair.
- **Choice completeness and containment legality** — the union of document and database identities; a missing, extra or duplicate choice is `400`. A task changes parent only while `pending` or `blocked` and while it holds no lease, workspace, attempt commit or retained commit; an objective needs that of every descendant.
- **The import transaction** — the `importId` lookup first, then the `fromRevision` comparison inside the transaction, then the legality recompute against current leases, workspaces, commits, descendants and edges, then the commit. `409 choices-stale` when topology moved; `409 choices-changed` when a selected outcome is no longer legal. Both write nothing.
- **Export and the revision lineage** — `plan.export` renders from the rows in the canonical layout with no status; `plan.revisions` returns the lineage with the three blob hashes. `accepted_blob` is the whole resulting graph.
- **The graph queries and the CLI** — `node.list`, `node.show`, `edge.list`, and `kanthord plan import` and `plan export`. Import writes the returned documents and removes every `plan/**/*.md` the response does not name, because the response uses canonical paths and the human's own names would survive as orphans.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/services/graph/**/*.test.ts src/commands/plan/**/*.test.ts \
  && echo "PASS EPIC-008"
```

Hermetic coverage required beyond the Proof:

- A two-objective plan imports, exports byte-identical to the accepted documents, and re-imports at the same revision. A re-import at the previous revision is refused by name.
- A retry of a committed `importId` returns the original revision and writes no second revision, and a reordered document array is still a retry. A different choice set under the same id is `409 idempotency-mismatch`.
- One document with three faults returns three findings.
- `submitted` on a structural edit is refused at `ready`, `running`, `awaiting_approval`, `done`, `partial` and `discarded`, and accepted at `pending` and `blocked`.
- `submitted` on a prose edit is accepted at every state, `discarded` included, and it does not clear `discard_reason`.
- The cycle case: database holds `B → A`, the document holds `A → B`, and taking `submitted` for `A` with `database` for `B` is refused as `choices-invalid`. The suggestion set for that same input is not that combination.
- A missing choice, an extra choice and a duplicate choice are each `400`.
