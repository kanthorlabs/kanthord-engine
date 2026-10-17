# Plan 03b: Mission Service and worker host — the storage failover

## Scope

This plan delivers the storage failover of rulings R8 and R10:

- The grant takes the first storage binding of the pinned revision, in list order, whose latest revision holds `available: true` and that no tombstone removed, that the signing call accepts, and that holds no failed upload check.
- A failed upload check: a check that finds a mismatch, finds no object or fails at the store. The check records the binding as failed.
- The refusal when no storage binding is left.
- The host `evidence upload` helper submits again on the next binding after a failed check.

Ulrich ruled two rules on 2026-10-17 (decision D29):

- R15, the key of the failure record: `(node_id, attempt, storage_binding_id)`. The grant skips a binding with a failure row of the open attempt, and a new attempt tries every binding again.
- R16, the refusal when no storage binding is left: 409 `mission.evidence.storage_exhausted`. 503 `mission.evidence.storage_unavailable` keeps its meaning "No object storage is wired" (`src/mission/storage-unavailable.ts:5-18`).

Out of scope:

- The grant on the first storage binding, the pin of the binding and the pinned read and delete. Plan 03 delivers them.
- A move of a published asset to another binding. A read and a delete never move.

## Model

Opus at medium effort. The plan adds a retry loop across two services and a committed record inside a refused request.

## Sources

- `docs/brainstorm/mission-service.md#evidence` — the storage grant, the failed upload check and the pinned read and delete.
- `docs/brainstorm/mission-service.impl.md#object-evidence` — the grant order, the check, the failure record and the tests.
- `docs/brainstorm/project-service.impl.md:175` — `available` of a binding revision.
- `docs/brainstorm/worker-service.md#executions` — the host serves `evidence upload <path>`.

A design citation names a section anchor of the pages at root `5fa6db3`, because these sections changed with the rulings R15 and R16.

## Depends on

- Plan 03 merged.
- Plan 03b runs in parallel with plans 04 to 07. It merges before plan 08.

## Provides

| Seam or shape                       | Signature                                                     | Owner file                  | Consumer plans |
| ----------------------------------- | ------------------------------------------------------------- | --------------------------- | -------------- |
| `mission_evidence_upload_failure`   | `(node_id, attempt, storage_binding_id, asset_id, failed_at)` | `src/mission/migrations.ts` | 08             |
| `MissionErrorCode.StorageExhausted` | `mission.evidence.storage_exhausted`, 409                     | `src/mission/contract.ts`   | 08             |

## Tasks

### 03b.1 Add the failure table and the exhausted code

- Files: `src/mission/migrations.ts`, `src/mission/record-store.ts`, `src/mission/contract.ts`, `src/apps/server/migrations.test.ts` and their tests (edit)
- Do:
  1. In `createExecutionRecordTables` of `src/mission/migrations.ts` add `mission_evidence_upload_failure (node_id, attempt, storage_binding_id, asset_id, failed_at)`. The primary key is `(node_id, attempt, storage_binding_id)` (ruling R15; decisions D2, D29).
  2. `record-store.ts` adds `insertUploadFailure(tx, row)` with `INSERT OR IGNORE` and `failedBindingsOf(tx, nodeId, attempt): string[]`.
  3. Add `MissionErrorCode.StorageExhausted = "mission.evidence.storage_exhausted"`.
- Cite: `mission-service.impl.md#object-evidence`; decision D29.
- Verify: `node --test --test-timeout=30000 src/apps/server/migrations.test.ts src/mission/record-store.test.ts`.

### 03b.2 Grant an upload on the first working storage binding

- Files: `src/mission/evidence-submit.ts`, `src/mission/authorization.ts`, `src/mission/evidence-submit.test.ts` (edit)
- Do:
  1. A storage binding is enabled when its latest revision holds `available: true` and no tombstone removed it (`project-service.impl.md:175`).
  2. `submitEvidence` (`src/mission/evidence-submit.ts:168-214`) walks the storage list of the pinned revision in order for each `object` asset. It skips a binding that is not enabled and a binding of `failedBindingsOf` for the open attempt.
  3. For each remaining binding it calls `intake.storage.put`. These answers move to the next binding: `mission.authorization.refused` with the reason `binding_disabled` or `binding_removed` (`src/mission/authorization.ts:60-67`), and an `s3.*` platform failure (`src/intake/storage.ts:256-266`).
  4. These answers stop the submission with no failover: `mission.authorization.refused` with `claim_not_live`, `attempt_closed`, `node_mismatch` or `service_mismatch`, and a cancelled context.
  5. When no binding is left, the submission answers 409 `mission.evidence.storage_exhausted`.
  6. The commit closure receives the chosen binding of each asset, and `prepareEvidence` (`:186-213`) pins exactly that binding in `storage_binding_id`. The commit never chooses again.
- Cite: `mission-service.md#evidence`; `mission-service.impl.md#object-evidence`; decision D29.
- Verify: `node --test --test-timeout=30000 src/mission/evidence-submit.test.ts src/mission/authorization.test.ts` with "an unavailable first binding grants the second", "a removed first binding grants the second", "an s3 failure of the signing call grants the next binding", "a lost claim during signing stops with no failover", "a binding with a failure row of the attempt is skipped" and "no binding left answers mission.evidence.storage_exhausted".

### 03b.3 Record a failed upload check

- Files: `src/mission/evidence-complete.ts`, `src/mission/evidence-complete.test.ts` (edit)
- Do:
  1. `completeEvidence` (`src/mission/evidence-complete.ts:66-110`) records a failure row on three answers of `intake.storage.check`: `intake.storage.object_mismatch` with an object of another size or digest, the same code with no object (`src/intake/storage.ts:116-124`), and an `s3.*` platform failure.
  2. The failure row commits in its own transaction before the refusal. The refusal of the request never rolls the row back.
  3. The asset stays unpublished. The answer keeps the code of the check.
- Cite: `mission-service.md#evidence`; `mission-service.impl.md#object-evidence`; decision D29.
- Verify: `node --test --test-timeout=30000 src/mission/evidence-complete.test.ts` with "a mismatch records the binding", "a missing object records the binding", "a store failure records the binding" and "the failure row stays after the refusal".

### 03b.4 Submit again on the next binding from the host helper

- Files: `src/apps/worker/evidence-upload.ts`, `src/apps/worker/evidence-upload.test.ts` (edit)
- Do:
  1. `uploadEvidence` (`src/apps/worker/evidence-upload.ts:213-270`) treats a failed transfer and a refused `evidence.asset.complete` with a recorded failure as a failed upload.
  2. After a failed upload it submits the evidence again. The server grants the next binding, because the failure row of task 03b.3 holds the failed one.
  3. It submits at most once for each storage binding of the node. It stops on `mission.evidence.storage_exhausted`, and on every other refusal.
  4. The answer to the agent names the evidence identity and the object URI of the published asset. It never names a presigned URL.
- Cite: `worker-service.md#executions`; `mission-service.md#evidence`.
- Verify: `node --test --test-timeout=30000 src/apps/worker/evidence-upload.test.ts` with "an unreachable first store publishes through the second binding" and "two failed stores answer mission.evidence.storage_exhausted".

### 03b.5 Update the CLI page

- Files: `docs/cli/mission.md` (edit)
- Lane: main session (decision D20).
- Do: state the grant order, the failed upload check and the failover. Add the row `mission.evidence.storage_exhausted` with 409. Keep the row 503 `mission.evidence.storage_unavailable` (`docs/cli/mission.md:1064`).
- Cite: decision D22.
- Verify: `pnpm exec prettier --check docs/cli/mission.md`.

### 03b.E Run the gate

- Do: run the gate row 03b of `00-index.md`.
- Verify: every command of the row exits 0.

## E2E

`e2e-storage-grants.test.ts` adds these rows. Setup creates an `implement` node with two storage bindings in the order `primary`, `secondary`.

| Id      | Commands                                                                             | Exit | Expect                                                      |
| ------- | ------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------- |
| EF03b.1 | `binding apply` with `available: false` on `primary`; `evidence upload`              | 0    | the asset pins `secondary`                                  |
| EF03b.2 | both bindings available; the store of `primary` answers no object; `evidence upload` | 0    | the asset pins `secondary`; one failure row names `primary` |
| EF03b.3 | both stores fail; `evidence upload`                                                  | 1    | stderr starts with `mission.evidence.storage_exhausted:`    |
| EF03b.4 | `evidence get` of the asset of EF03b.2 after `primary` recovers                      | 0    | the read uses `secondary`                                   |

## Blockers
