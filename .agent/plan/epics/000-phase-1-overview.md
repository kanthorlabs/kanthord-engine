# Phase 1 — epic overview

Status: **draft**. The Stories lists are agreed. The Verification Gates are sketches, and each epic is finalised just before `/author` runs on it.

Source: `docs/proposal/phase-1/`, `docs/proposal/api/`, `docs/proposal/database/`.

Phase 1 goal: every entity, service interface, command and query exists, and a human drives the daemon end to end. No agent is connected.

Exit criterion: Ulrich onboards his real repository from a second machine over the VPN, imports a two-objective plan, exports it identical, and reads status. Every execution route answers `not-implemented`.

## Order

Foundation layers first, then vertical use cases, then the contract sweep, then the scenarios. An epic must be verifiable when it closes, so a use case that cannot be driven through a route does not close.

| #   | Epic                     | Stories | Capability at close                                                                  |
| --- | ------------------------ | ------- | ------------------------------------------------------------------------------------ |
| 001 | Runtime foundation       | 7       | The daemon starts, reads its configuration, and owns its home exclusively.           |
| 002 | Domain and state machine | 8       | The machine is defined and unit tested. Every service interface exists.              |
| 003 | Storage                  | 8       | Every phase-1 table exists. Migrations are idempotent. Secrets and blobs persist.    |
| 004 | Transport skeleton       | 7       | A request reaches a handler under the full transport policy, and the CLI carries it. |
| 005 | Test infrastructure      | 3       | A fixture remote answers real git HTTP and passes its own acceptance list.           |
| 006 | Git primitives           | 5       | A ref write is a compare-and-swap. The three ref roles never blur.                   |
| 007 | Repository registration  | 7       | A human registers a real remote and reads it back, end to end.                       |
| 008 | Project and plan         | 13      | A human imports, exports and re-imports a plan with per-node conflict choices.       |
| 009 | Contract completion      | 5       | Status, blobs, events, and every later-phase route answering `501`.                  |
| 010 | End-to-end scenarios     | 5       | P1-E1, P1-E2 and P1-E3 produce evidence bundles.                                     |

Total: 68 stories.

## Dependencies

```
001 ─> 002 ─> 003 ─> 004 ─┬─> 005 ─> 006 ─> 007 ─┬─> 009 ─> 010
                          │                       │
                          └───────────────────────┴─> 008
```

008 needs 004 for its routes and 007 for the repository an objective binds. 009 sweeps what 007 and 008 left. 010 proves the whole thing through the packaged binary.

## Decisions taken outside the proposal, then merged into it

Each of these came out of a debate round and now lives in the proposal files named.

| Decision                                                                           | Landed in                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `provider.register`, `provider.list` and `provider.show` move to phase 1           | `api/credential.md`, `api/new-decisions.md` |
| Validation collects every finding                                                  | `phase-1/plan-format.md`, `api/graph.md`    |
| `repository register --upstream <branch>` gives the confirmation non-interactively | `api/repository.md`                         |
| `plan.export` writes no status                                                     | `phase-1/plan-format.md`, `api/graph.md`    |
| Byte identity is against the accepted document, with a canonical rendering         | `phase-1/plan-format.md`                    |
| The import body is path-and-content pairs, with a decided path grammar             | `api/graph.md`, `api/new-decisions.md`      |
| Re-import is a binary per-node choice, validated as a whole candidate graph        | `phase-1/plan-format.md`, `api/graph.md`    |
| `fromRevision` stays a hard reject; the merge-base model is deferred               | `api/new-decisions.md`, `after-the-mvp.md`  |
| `choices_blob`, and `accepted_blob` holds the whole resulting graph                | `database/plan_revision.md`                 |
