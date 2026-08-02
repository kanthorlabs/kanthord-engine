# 04 — Verification and integration

Freeze the work, judge it, write the refs. Owns [`candidate`](../proposal/database/candidate.md), [`check_result`](../proposal/database/check_result.md) and [`git_operation`](../proposal/database/git_operation.md).

The name says verification, not approval. `check_result` covers six subject kinds, and only two of them are about a candidate. A task diagnostic belongs to the execution story of [03-execution](03-execution.md), and a profile gate belongs to no run at all.

```mermaid
erDiagram
  node {
    TEXT id PK
  }
  run {
    TEXT id PK
  }
  workspace {
    TEXT id PK
  }
  repository {
    TEXT id PK
  }
  candidate {
    TEXT id PK
    TEXT node_id FK "objective being approved"
    TEXT run_id FK "objective run that froze it"
    TEXT workspace_id FK
    TEXT revision "the approval request must carry it"
    TEXT candidate_oid "the frozen commit"
    TEXT landing_base_oid "the compare-and-swap expects it"
    TEXT merge_oid "a recompute replaces it"
    TEXT projected_outcome "done or partial"
    TEXT evidence_blob FK
    TEXT profile_blob FK "profile in force"
    TEXT convention_version
    TEXT state "open, approved or invalidated"
    INTEGER acknowledged_partial
    INTEGER publish_requested
    TEXT approved_actor
    INTEGER approved_at
    INTEGER invalidated_at
    TEXT invalidated_reason
    INTEGER updated_at
  }
  check_result {
    TEXT id PK
    TEXT subject_kind "six values"
    TEXT subject_id "prefixed; no FK"
    TEXT node_id FK
    TEXT run_id FK
    TEXT commit_oid
    TEXT manifest_blob FK
    TEXT check_name "key in the profile checks map"
    TEXT command_json "argv exactly as executed"
    TEXT cwd
    TEXT env_identity
    TEXT toolchain_version
    INTEGER timeout_ms
    INTEGER authoritative "0 gates nothing"
    TEXT result "explicit, never inferred"
    INTEGER exit_code
    TEXT output_blob FK
    TEXT profile_blob FK
    TEXT convention_version
    INTEGER invalidated_at
    INTEGER ended_at
  }
  git_operation {
    TEXT id PK
    TEXT repository_id FK
    TEXT intent "merge, sync, publish or revert"
    TEXT node_id FK
    TEXT run_id FK
    TEXT candidate_id FK
    INTEGER lease_fence "repository lease generation"
    TEXT ref "local for a merge, remote for a publish"
    TEXT base_oid "value the ref must hold before"
    TEXT proposed_head_oid
    TEXT result_head_oid "differs after a recompute"
    TEXT expected_remote_oid "publish only"
    TEXT state "open, complete or discarded"
    TEXT outcome
    TEXT detail_blob FK
    INTEGER completed_at
  }
  blob {
    TEXT hash PK
  }

  node       ||--o{ candidate : "node_id"
  run        ||--o{ candidate : "run_id"
  workspace  ||--o{ candidate : "workspace_id"
  node       |o--o{ check_result : "node_id"
  run        |o--o{ check_result : "run_id"
  repository ||--o{ git_operation : "repository_id"
  node       |o--o{ git_operation : "node_id"
  run        |o--o{ git_operation : "run_id"
  candidate  |o--o{ git_operation : "candidate_id"
  blob       ||--o{ candidate : "evidence_blob, profile_blob"
  blob       ||--o{ check_result : "manifest, output, profile"
  blob       ||--o{ git_operation : "detail_blob"

  check_result }o..o| candidate : "subject_id, subject_kind = 'candidate'"
  check_result }o..o| git_operation : "subject_id, subject_kind = 'merge'"
```

## What `check_result` judges

`subject_kind` holds six values, and they do not map one to one onto six tables. Only two of them fill `subject_id`.

| `subject_kind`    | `subject_id`      | Attributed through          |
| ----------------- | ----------------- | --------------------------- |
| `candidate`       | a `candidate_` id | `node_id`, `run_id`         |
| `merge`           | a `gitop_` id     | `node_id`, `run_id`         |
| `task-diagnostic` | null              | `run_id` of the task run    |
| `reconcile`       | null              | `node_id` may be null       |
| `profile-gate`    | null              | neither                     |
| `initiative-e2e`  | null              | `node_id` of the initiative |

`node_id` and `run_id` are both nullable, so a profile gate needs neither. `CHECK (result = 'not-applicable' OR commit_oid IS NOT NULL OR manifest_blob IS NOT NULL)` says a real check names either a commit or a manifest. A deferred initiative check uses the manifest.

## What the shape says

**A candidate freezes the evidence.** `evidence_blob`, `profile_blob` and `convention_version` are all `NOT NULL`. A later profile edit cannot redefine an approval. `UNIQUE (node_id, revision)` gives one candidate per objective revision, and the approval request must carry that revision.

**An approval is a state, not a table.** No `approval` table exists. `state`, `approved_actor` and `approved_at` sit on `candidate`. `CHECK (state <> 'approved' OR projected_outcome = 'done' OR acknowledged_partial = 1)` blocks a silent partial approval.

**An invalidation is a column pair.** `invalidated_at` and `invalidated_reason` fire when the workspace stops matching the freeze. `check_result.invalidated_at` does the same for a result whose subject changed.

**`git_operation` is a journal, not a log.** A row opens before the write and closes after git answers. `state = 'open'` is the recovery signal, and startup reconciles every open row. `base_oid` and `proposed_head_oid` are the compare-and-swap, and `result_head_oid` differs after a recompute.

**The publish is chained, not separate.** `candidate.publish_requested` asks for it, and `repository.publish_on_approval` is the default. Both produce a `git_operation` row of `intent = 'publish'`, with `expected_remote_oid` holding what the remote ref had. A null there means the ref must not exist.

**`lease_fence` is the write authority.** It is the `repository` lease generation from [03-execution](03-execution.md). A stale holder cannot write a ref.

## Boundary

`node` belongs to [02-plan-graph](02-plan-graph.md). `run` and `workspace` belong to [03-execution](03-execution.md). `repository` belongs to [01-registration](01-registration.md). `blob` belongs to [05-cross-cutting](05-cross-cutting.md).
