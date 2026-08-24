# Story 06 — Execution DDL

Epic: `.agents/plan/epics/003-storage.md`
Depends on: Story 05 (`migrations.ts` holds two entries, `test/helpers/rows.ts` seeds the graph).

## Change

### 1. `src/services/storage/migration-0003-execution-and-journal.ts` (new)

```ts
import type { Migration } from "./migration.ts";

export const executionAndJournal: Migration = {
  version: 3,
  name: "0003-execution-and-journal",
  statements: [ … ],
};
```

Ten statements, in this order — `workspace`, `lease`, `run`, the `run_one_active` index, `attempt`, `agent_invocation`, `candidate`, `check_result`, `git_operation`, `event`. The order is the foreign-key order. Each statement is the block of its `docs/proposal/database/<table>.md` file with every `--` comment removed and nothing else changed. The implementer copies each block out of the proposal file, and the parity test under **Verify** proves the copy — this is the largest migration, so the mechanical comparison is what carries the transcription risk, not the prose below.

`docs/proposal/database/run.md` holds **two** statements in one fenced block, the table and the index, so `proposalStatements("run")` returns both in that order and they land in `statements` in that order.

The column lists below name what each table holds, for reading. They are not the source: the source is the proposal file.

The full column lists, in source order:

- **`workspace`** — `id TEXT PRIMARY KEY`, `node_id TEXT NOT NULL UNIQUE REFERENCES node(id)`, `repository_id TEXT NOT NULL REFERENCES repository(id)`, `path TEXT NOT NULL`, `clone_base_oid TEXT NOT NULL`, `upstream_oid_at_clone TEXT NOT NULL`, `profile_blob TEXT NOT NULL REFERENCES blob(hash)`, `convention_version TEXT NOT NULL`, `ambient_blob TEXT REFERENCES blob(hash)`, `state TEXT NOT NULL`, `updated_at INTEGER NOT NULL`. No `CHECK`.
- **`lease`** — `subject_kind TEXT NOT NULL CHECK (subject_kind IN ('node', 'repository'))`, `subject_id TEXT NOT NULL`, `owner TEXT`, `fence INTEGER NOT NULL`, `acquired_at INTEGER`, `renewed_at INTEGER`, `expires_at INTEGER`, `PRIMARY KEY (subject_kind, subject_id)`.
- **`run`** — `id TEXT PRIMARY KEY`, `kind TEXT NOT NULL CHECK (kind IN ('objective', 'task'))`, `node_id TEXT NOT NULL REFERENCES node(id)`, `parent_run_id TEXT REFERENCES run(id)`, `workspace_id TEXT NOT NULL REFERENCES workspace(id)`, `worker TEXT NOT NULL`, `lease_fence INTEGER NOT NULL`, `attempt_limit INTEGER NOT NULL`, `base_oid TEXT NOT NULL`, `head_oid TEXT`, `state TEXT NOT NULL CHECK (state IN ('active', 'ended'))`, `outcome TEXT`, `ended_at INTEGER`, `CHECK ((kind = 'objective') = (parent_run_id IS NULL))`.
- the index, its own statement: `CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'`.
- **`attempt`** — `id TEXT PRIMARY KEY`, `run_id TEXT NOT NULL REFERENCES run(id)`, `attempt_no INTEGER NOT NULL`, `provider_id TEXT NOT NULL REFERENCES provider(id)`, `provider_model TEXT NOT NULL`, `timeout_ms INTEGER NOT NULL`, `base_oid TEXT NOT NULL`, `head_oid TEXT`, `outcome TEXT CHECK (outcome IS NULL OR outcome IN ('accepted', 'rejected', 'failed', 'timed-out', 'cancelled'))`, `ended_at INTEGER`, `UNIQUE (run_id, attempt_no)`.
- **`agent_invocation`** — `id TEXT PRIMARY KEY`, `attempt_id TEXT NOT NULL REFERENCES attempt(id)`, `agent TEXT NOT NULL CHECK (agent IN ('general@1', 'swe@1', 'te@1', 're@1'))`, `adapter_version TEXT NOT NULL`, `prompt_blob TEXT NOT NULL REFERENCES blob(hash)`, `sources_json TEXT NOT NULL`, `tool_definitions_blob TEXT NOT NULL REFERENCES blob(hash)`, `tool_trace_blob TEXT REFERENCES blob(hash)`, `diff_blob TEXT REFERENCES blob(hash)`, `verdict TEXT CHECK (verdict IS NULL OR verdict IN ('accept', 'reject'))`, `reason_blob TEXT REFERENCES blob(hash)`, `usage_json TEXT`, `error_blob TEXT REFERENCES blob(hash)`, `ended_at INTEGER`.
- **`candidate`** — `id TEXT PRIMARY KEY`, `node_id TEXT NOT NULL REFERENCES node(id)`, `run_id TEXT NOT NULL REFERENCES run(id)`, `workspace_id TEXT NOT NULL REFERENCES workspace(id)`, `revision TEXT NOT NULL`, `candidate_oid TEXT NOT NULL`, `landing_base_oid TEXT NOT NULL`, `merge_oid TEXT`, `projected_outcome TEXT NOT NULL CHECK (projected_outcome IN ('done', 'partial'))`, `evidence_blob TEXT NOT NULL REFERENCES blob(hash)`, `profile_blob TEXT NOT NULL REFERENCES blob(hash)`, `convention_version TEXT NOT NULL`, `state TEXT NOT NULL CHECK (state IN ('open', 'approved', 'invalidated'))`, `acknowledged_partial INTEGER`, `publish_requested INTEGER`, `approved_actor TEXT`, `approved_at INTEGER`, `invalidated_at INTEGER`, `invalidated_reason TEXT`, `updated_at INTEGER NOT NULL`, `UNIQUE (node_id, revision)`, `CHECK (state <> 'approved' OR projected_outcome = 'done' OR acknowledged_partial IS 1)`.
- **`check_result`** — `id TEXT PRIMARY KEY`, `subject_kind TEXT NOT NULL CHECK (subject_kind IN ('candidate', 'merge', 'task-diagnostic', 'reconcile', 'profile-gate', 'initiative-e2e'))`, `subject_id TEXT`, `node_id TEXT REFERENCES node(id)`, `run_id TEXT REFERENCES run(id)`, `commit_oid TEXT`, `manifest_blob TEXT REFERENCES blob(hash)`, `check_name TEXT NOT NULL`, `command_json TEXT NOT NULL`, `cwd TEXT NOT NULL`, `env_identity TEXT NOT NULL`, `toolchain_version TEXT NOT NULL`, `timeout_ms INTEGER NOT NULL`, `authoritative INTEGER NOT NULL`, `result TEXT NOT NULL CHECK (result IN ('running', 'passed', 'failed', 'error', 'timed-out', 'cancelled', 'not-applicable'))`, `exit_code INTEGER`, `output_blob TEXT REFERENCES blob(hash)`, `profile_blob TEXT REFERENCES blob(hash)`, `convention_version TEXT NOT NULL`, `invalidated_at INTEGER`, `ended_at INTEGER`, `CHECK (result = 'not-applicable' OR commit_oid IS NOT NULL OR manifest_blob IS NOT NULL)`.
- **`git_operation`** — `id TEXT PRIMARY KEY`, `repository_id TEXT NOT NULL REFERENCES repository(id)`, `intent TEXT NOT NULL CHECK (intent IN ('merge', 'sync', 'publish', 'revert'))`, `node_id TEXT REFERENCES node(id)`, `run_id TEXT REFERENCES run(id)`, `candidate_id TEXT REFERENCES candidate(id)`, `lease_fence INTEGER NOT NULL`, `ref TEXT NOT NULL`, `base_oid TEXT NOT NULL`, `proposed_head_oid TEXT NOT NULL`, `result_head_oid TEXT`, `expected_remote_oid TEXT`, `state TEXT NOT NULL CHECK (state IN ('open', 'complete', 'discarded'))`, `outcome TEXT`, `detail_blob TEXT REFERENCES blob(hash)`, `child_token TEXT`, `completed_at INTEGER`.
- **`event`** — `id TEXT PRIMARY KEY`, `subject_kind TEXT NOT NULL`, `subject_id TEXT NOT NULL`, `type TEXT NOT NULL`, `actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'daemon'))`, `actor_id TEXT NOT NULL`, `payload_json TEXT NOT NULL`.

Every table ends `) STRICT`.

### 2. `src/services/storage/migrations.ts` — append

```ts
export const migrations: readonly Migration[] = [
  coreEntities,
  graphAndPlan,
  executionAndJournal,
];
```

### 3. `test/helpers/rows.ts` — extend

Add to `fixtureIds`: `workspace: "workspace_a"`, `objectiveRun: "run_a"`, `taskRun: "run_b"`, `attempt: "attempt_a"`.

Add `export function seedExecution(transaction: Transaction): void`. It assumes `seedRegistry` and `seedGraph` already ran, and inserts, in this order:

- one `workspace` row — `id = fixtureIds.workspace`, `node_id = fixtureIds.objective`, `repository_id = fixtureIds.repository`, `path = "workspaces/objective_a"`, `clone_base_oid = "a".repeat(40)`, `upstream_oid_at_clone = "a".repeat(40)`, `profile_blob = fixtureIds.profileBlob`, `convention_version = "coding/v1"`, `ambient_blob = null`, `state = "ready"`, `updated_at = 1`;
- one `run` row, the objective run — `id = fixtureIds.objectiveRun`, `kind = "objective"`, `node_id = fixtureIds.objective`, `parent_run_id = null`, `workspace_id = fixtureIds.workspace`, `worker = "general@1"`, `lease_fence = 1`, `attempt_limit = 3`, `base_oid = "a".repeat(40)`, `head_oid = null`, `state = "active"`, `outcome = null`, `ended_at = null`;
- one `run` row, the task run — `id = fixtureIds.taskRun`, `kind = "task"`, `node_id = fixtureIds.task`, `parent_run_id = fixtureIds.objectiveRun`, the rest as above;
- one `attempt` row — `id = fixtureIds.attempt`, `run_id = fixtureIds.taskRun`, `attempt_no = 1`, `provider_id = fixtureIds.provider`, `provider_model = "claude-opus-5"`, `timeout_ms = 60000`, `base_oid = "a".repeat(40)`, `head_oid = null`, `outcome = null`, `ended_at = null`.

## Constraints

- `run_one_active` is a separate statement, and it is the only index this epic creates.
- `workspace.state`, `run.outcome`, `git_operation.outcome`, `event.type` and `event.subject_kind` carry **no** `CHECK`. The source declares none, and a narrower schema would refuse a row SQLite accepts.
- `event` carries no `updated_at` and no trigger. **Append-only is an application-layer invariant, not a property of this DDL**: the table stays freely updateable and deletable at the SQL level, and triggers are forbidden here. `docs/proposal/database/event.md:23` states the rule, and the write commands of later epics carry it. Do not claim the migration enforces it.
- `src/domain/` is not modified.

## Verify

`node --test src/services/storage/migration-0003-execution-and-journal.test.ts` — new file, one suite named `"src/services/storage/migration-0003-execution-and-journal.test"`. Every case builds a `SqliteStorage` over `createTemporaryDatabase()` with the full `migrations` array, calls `migrate()`, then `transact((t) => { seedRegistry(t); seedGraph(t); seedExecution(t); })`.

Refusals are asserted the way Story 04 fixes: `errcode & 0xff === 19`, an unchanged row count, and the named-column message only where it is written out below.

Parity, the load-bearing case:

- `executionAndJournal.statements` deep-equals `["workspace", "lease", "run", "attempt", "agent_invocation", "candidate", "check_result", "git_operation", "event"].flatMap(proposalStatements)` after each authored statement is put through the same normalization. That is ten expected statements from nine tables, because `run` yields two, and it asserts every column, type, nullability, default, foreign key and `CHECK` of the nine densest tables at once.
- `executionAndJournal.version` is `3` and its `name` is `"0003-execution-and-journal"`, and `docs/proposal/database/migration.md` contains that literal.
- `migrations` deep-equals `[coreEntities, graphAndPlan, executionAndJournal]`, and its versions map to `[1, 2, 3]`.
- No trigger and no view: `SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')` returns an empty array.

- The table inventory maps to exactly these nineteen names, in this order:
  `["agent_invocation", "attempt", "blob", "candidate", "check_result", "edge", "event", "git_operation", "lease", "migration", "node", "plan_revision", "profile", "project", "project_binding", "provider", "repository", "run", "workspace"]`.
- Every one of the eighteen product tables is `STRICT`, asserted as in Story 04.
- `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'` maps to exactly `["run_one_active"]`.
- `run_one_active`:
  - A second `run` row with `node_id = fixtureIds.task` and `state = "active"` is refused, with the message containing `"UNIQUE constraint failed: run.node_id"`.
  - After `UPDATE run SET state = 'ended' WHERE id = ?` on the task run, a new `active` run for the same node succeeds.
  - Two `ended` runs for one node coexist.
- `run` `CHECK`s: `kind = "objective"` with a non-null `parent_run_id` is refused; `kind = "task"` with a null `parent_run_id` is refused; `state = "paused"` is refused; `kind = "epic"` is refused. `parent_run_id` pointing at a missing run is refused by the foreign key, and `workspace_id` likewise.
- `workspace`:
  - `profile_blob` pointing at an unstored hash is refused, with the message containing `"FOREIGN KEY constraint failed"`, and pointing at `fixtureIds.profileBlob` succeeds. That is the phase-2 pin `docs/proposal/database/workspace.md:13` requires.
  - `ambient_blob` accepts `null`, and an unstored hash is refused.
  - A second `workspace` for the same `node_id` is refused, with the message containing `"UNIQUE constraint failed: workspace.node_id"`.
  - `state = "anything"` succeeds. That one sample does not prove the column is unconstrained; the parity test proves the absence of a `CHECK`, and this case only shows the column is usable.
- `agent_invocation.agents`, against a **frozen literal** `["general@1", "swe@1", "te@1", "re@1"]` declared in this test file. This migration is history: it must not import `src/domain/agent.ts`, because a later release that adds an agent kind through migration `0004` would otherwise pressure a maintainer into editing `0003`.
  - Each of the four values inserts and succeeds.
  - `"mr@1"` and `"tdd@1"` are each refused.
  - `verdict = "maybe"` is refused; `null`, `"accept"` and `"reject"` all succeed.
- `attempt`: a second row with the same `(run_id, attempt_no)` is refused, with the message containing `"UNIQUE constraint failed: attempt.run_id, attempt.attempt_no"`; `attempt_no = 2` succeeds; `outcome = "nonsense"` is refused; each of the five legal outcomes and `null` succeed; `provider_id` pointing at a missing provider is refused.
- `candidate`:
  - `state = "approved"` with `projected_outcome = "partial"` and `acknowledged_partial = null` is refused.
  - The same with `acknowledged_partial = 0` is **also refused**. The clause is `acknowledged_partial IS 1`, and a defective `= 1` evaluates to `NULL` on a null column. SQLite fails a `CHECK` only on false, so `= 1` accepts the null case — an unacknowledged partial integration. `IS` compares across null and returns false.
  - The same with `acknowledged_partial = 1` succeeds.
  - `state = "approved"` with `projected_outcome = "done"` and `acknowledged_partial = null` succeeds.
  - `state = "open"` with `projected_outcome = "partial"` and `acknowledged_partial = null` succeeds — the clause gates the approval, not the freeze.
  - `projected_outcome = "blocked"` is refused; `state = "closed"` is refused.
  - A second row with the same `(node_id, revision)` is refused, with the message containing `"UNIQUE constraint failed"`.
- `check_result`:
  - `result = "passed"` with both `commit_oid` and `manifest_blob` null is refused.
  - `result = "not-applicable"` with both null succeeds.
  - `result = "passed"` with a `commit_oid` succeeds, and with only a `manifest_blob` succeeds.
  - `subject_kind = "nonsense"` is refused; each of the six legal `subject_kind` values succeeds.
  - Each of the seven legal `result` values succeeds with a `commit_oid` set.
- `lease`: the composite key refuses a duplicate `(subject_kind, subject_id)`, with the message containing `"UNIQUE constraint failed"`; `subject_kind = "project"` is refused; `owner = null` succeeds; the same `subject_id` under the other `subject_kind` succeeds.
- `git_operation`: `intent = "rebase"` is refused; each of the four legal intents succeeds; `state = "pending"` is refused; each of the three legal states succeeds; `outcome = "anything"` succeeds.
- `event`: `actor_kind = "robot"` is refused; `"human"` and `"daemon"` succeed; `type` and `subject_kind` accept a string this test picks, and their unconstrained-ness comes from the parity test rather than from that sample.

`node --test src/services/storage/schema-parity.test.ts` — new file, one suite named `"src/services/storage/schema-parity.test"`. This is the **one** place the live schema is compared with the current domain enums, so the historical migrations keep frozen literals and no future migration pressures a maintainer into editing an old one. It migrates a temporary database with the full `migrations` array, then reads `sqlite_master`:

- The `node.state` `CHECK` and `nodeStates` from `src/domain/state.ts` agree: every member of `nodeStates` appears as a quoted literal in the `node` DDL text, the count of quoted literals inside the `state IN (…)` clause equals `nodeStates.length`, and the extracted list in order deep-equals `nodeStates`.
- The `node.block_reason` `CHECK` and `blockReasons` agree, by the same three assertions.
- The `agent_invocation.agents` `CHECK` and `agentKinds` from `src/domain/agent.ts` agree, by the same three assertions. The expected member list is built from `agentKinds` rather than typed twice, and the clause text is extracted before the comparison so a match inside a wider permissive expression cannot pass.
- The `node.kind` `CHECK` and `nodeKinds` agree.
- Extraction is one helper in this file: given the table DDL and a column name, return the ordered list of quoted literals inside that column's `IN (…)` clause. A missing clause fails the test rather than returning an empty list.

That is the drift guard the EPIC asks for — "the two cannot drift" — placed where a domain change breaks one test that names the disagreement, instead of breaking a migration test that must never change.

`test/helpers/rows.test.ts` gains: after all three seed calls, the row counts of `workspace`, `run` and `attempt` are `1`, `2` and `1`.

`npm run verify` exits 0.

Proof: contributes `src/services/storage/migration-0003-execution-and-journal.test.ts` and `src/services/storage/schema-parity.test.ts` to `node --test src/services/storage/**/*.test.ts`. Delivers the EPIC's hermetic requirements on `workspace.profile_blob` and on the `agent_invocation.agents` drift guard.
