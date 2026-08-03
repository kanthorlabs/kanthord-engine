# Story 05 — Graph DDL

Epic: `.agent/plan/epics/003-storage.md`
Depends on: Story 04 (`migrations.ts`, `test/helpers/rows.ts`).

## Change

### 1. `src/services/storage/migration-0002-graph-and-plan.ts` (new)

```ts
import type { Migration } from "./migration.ts";

export const graphAndPlan: Migration = {
  version: 2,
  name: "0002-graph-and-plan",
  statements: [ … ],
};
```

Three statements, in this order — `plan_revision`, `node`, `edge`. `node.revision` references `plan_revision(id)`, so the revision table is created first. Each statement is the `CREATE TABLE` of its `docs/proposal/database/<table>.md` file with every `--` comment removed and nothing else changed. The implementer copies each block out of the proposal file; the parity test under **Verify** proves the copy, so the text below is for reading rather than for retyping:

```sql
CREATE TABLE plan_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_id TEXT REFERENCES plan_revision(id),
  import_id TEXT NOT NULL,
  submitted_blob TEXT NOT NULL REFERENCES blob(hash),
  choices_blob TEXT NOT NULL REFERENCES blob(hash),
  accepted_blob TEXT NOT NULL REFERENCES blob(hash),
  UNIQUE (project_id, import_id)
) STRICT
```

```sql
CREATE TABLE node (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('initiative', 'objective', 'task')),
  parent_id TEXT REFERENCES node(id),
  title TEXT NOT NULL,
  instruction_blob TEXT NOT NULL REFERENCES blob(hash),
  acceptance_blob TEXT REFERENCES blob(hash),
  worker TEXT,
  repository_id TEXT REFERENCES repository(id),
  state TEXT NOT NULL,
  block_reason TEXT,
  discard_reason TEXT,
  revision TEXT NOT NULL REFERENCES plan_revision(id),
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'initiative') = (parent_id IS NULL)),
  CHECK ((kind = 'objective') = (repository_id IS NOT NULL)),
  CHECK ((kind = 'task') = (acceptance_blob IS NOT NULL)),
  CHECK (state IN ('pending', 'ready', 'running', 'blocked',
                   'awaiting_approval', 'done', 'partial', 'discarded')),
  CHECK ((state = 'blocked') = (block_reason IS NOT NULL)),
  CHECK (block_reason IS NULL OR block_reason IN ('attempt-limit', 'dependency-discarded',
                   'stale-base', 'dirty-recovery', 'e2e-failed', 'abandoned')),
  CHECK (state <> 'awaiting_approval' OR kind = 'objective'),
  CHECK (state <> 'partial' OR kind <> 'task')
) STRICT
```

```sql
CREATE TABLE edge (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL REFERENCES node(id),
  to_node TEXT NOT NULL REFERENCES node(id),
  waived_at INTEGER,
  UNIQUE (from_node, to_node),
  CHECK (from_node <> to_node)
) STRICT
```

### 2. `src/services/storage/migrations.ts` — append

```ts
export const migrations: readonly Migration[] = [coreEntities, graphAndPlan];
```

### 3. `test/helpers/rows.ts` — extend

Add to `fixtureIds`: `planRevision: "revision_a"`, `initiative: "initiative_a"`, `objective: "objective_a"`, `task: "task_a"`.

Add `export function seedGraph(transaction: Transaction): void`. It assumes `seedRegistry` already ran, and inserts, in this order:

- one `plan_revision` row — `id = fixtureIds.planRevision`, `project_id = fixtureIds.project`, `parent_id = null`, `import_id = "imp_a"`, the three `*_blob` columns all `fixtureIds.instructionBlob`;
- one `node` row, the initiative — `id = fixtureIds.initiative`, `project_id`, `kind = "initiative"`, `parent_id = null`, `title = "Harden the verify CLI"`, `instruction_blob = fixtureIds.instructionBlob`, `acceptance_blob = null`, `worker = null`, `repository_id = null`, `state = "pending"`, `block_reason = null`, `discard_reason = null`, `revision = fixtureIds.planRevision`, `updated_at = 1`;
- one `node` row, the objective — `id = fixtureIds.objective`, `kind = "objective"`, `parent_id = fixtureIds.initiative`, `repository_id = fixtureIds.repository`, `acceptance_blob = null`, `state = "pending"`, the rest as above;
- one `node` row, the task — `id = fixtureIds.task`, `kind = "task"`, `parent_id = fixtureIds.objective`, `repository_id = null`, `acceptance_blob = fixtureIds.acceptanceBlob`, `state = "pending"`, the rest as above.

## Constraints

- `node.state` carries no default and no `NOT NULL` beyond what the source states. The eight legal values live in the `CHECK` clause only.
- `edge` holds dependency only. Add no `parent_id`, and no index.
- The `CHECK` clauses are the state machine (`docs/proposal/phase-1/state-machine.md`). Do not reorder them, and do not merge two into one.
- `src/domain/` is not modified.

## Verify

`node --test src/services/storage/migration-0002-graph-and-plan.test.ts` — new file, one suite named `"src/services/storage/migration-0002-graph-and-plan.test"`. Every case builds a `SqliteStorage` over `createTemporaryDatabase()` with `migrations: [coreEntities, graphAndPlan]`, calls `migrate()`, then `transact((t) => { seedRegistry(t); seedGraph(t); })`.

Refusals are asserted the way Story 04 fixes: `errcode & 0xff === 19`, an unchanged row count, and the named-column message only where it is written out below. Reuse the `assertRefused` helper shape.

Parity, the load-bearing case:

- `graphAndPlan.statements` deep-equals `["plan_revision", "node", "edge"].flatMap(proposalStatements)` after each authored statement is put through the same normalization. Statement count, order, every column and every `CHECK` are asserted at once, which is what proves the eight `node` `CHECK` clauses are present, unreordered and unmerged.
- `graphAndPlan.version` is `2` and `graphAndPlan.name` is `"0002-graph-and-plan"`, and `docs/proposal/database/migration.md` contains that literal.
- `migrations` deep-equals `[coreEntities, graphAndPlan]`.
- No extra schema object: the `index`, `trigger` and `view` inventory of `sqlite_master` is still empty after this migration.

- The table inventory maps to exactly
  `["blob", "edge", "migration", "node", "plan_revision", "profile", "project", "project_binding", "provider", "repository"]`.
- All three new tables are `STRICT`, asserted the same way as Story 04.
- The eight states, driven by a **frozen literal** in this test file: `["pending", "ready", "running", "blocked", "awaiting_approval", "done", "partial", "discarded"]`. This migration is history and must never change, so its test does not import `src/domain/state.ts`. A later release that adds a state adds migration `0004` and leaves this test alone. The live-schema comparison against the current domain enums is one test, `src/services/storage/schema-parity.test.ts`, delivered by Story 06.
  - Each of `"pending"`, `"ready"`, `"running"`, `"done"`, `"discarded"` inserts on a **task** shaped row and succeeds.
  - `"blocked"` on a task with a `block_reason` of `"attempt-limit"` succeeds.
  - `"awaiting_approval"` on an **objective** shaped row succeeds.
  - `"partial"` on an **objective** shaped row succeeds.
  - `"nonsense"` is refused. The set is exactly eight because the parity test pins the `CHECK` text; an accepted sample and one refused outsider cannot prove that on their own.
- The two level rules the EPIC names:
  - A **task** row with `state = "partial"` is refused.
  - A **task** row with `state = "awaiting_approval"` is refused.
  - An **initiative** row with `state = "partial"` succeeds, so the refusal is about the kind and not about the value.
- The block-reason pair:
  - `state = "blocked"` with `block_reason = null` is refused.
  - `state = "ready"` with `block_reason = "attempt-limit"` is refused.
  - A loop over the frozen literal `["attempt-limit", "dependency-discarded", "stale-base", "dirty-recovery", "e2e-failed", "abandoned"]`: each of the six with `state = "blocked"` succeeds.
  - `block_reason = "nonsense"` with `state = "blocked"` is refused.
- Containment. Each of the three `CHECK` clauses is an equivalence over all three kinds, so the cases cover every kind on both sides. A clause special-cased for the tested kinds only would otherwise pass:
  - `parent_id`: an initiative with a non-null `parent_id` is refused; an objective with a null `parent_id` is refused; a **task with a null `parent_id` is refused**; an objective and a task with a valid parent both succeed.
  - `repository_id`: an objective with `null` is refused; a task with a non-null value is refused; an **initiative with a non-null value is refused**; an initiative and a task with `null` both succeed.
  - `acceptance_blob`: a task with `null` is refused; an objective with a non-null value is refused; an **initiative with a non-null value is refused**; an initiative and an objective with `null` both succeed.
  - `kind = "epic"` is refused.
- `edge`:
  - An edge from the task to itself is refused.
  - Two edges with the same `(from_node, to_node)` — the second is refused, with the message containing `"UNIQUE constraint failed: edge.from_node, edge.to_node"`.
  - `from_node = "task_missing"` is refused, with the message containing `"FOREIGN KEY constraint failed"`.
  - `waived_at` accepts `null` and an integer.
- `plan_revision`:
  - A second row with the same `(project_id, import_id)` is refused, with the message containing `"UNIQUE constraint failed: plan_revision.project_id, plan_revision.import_id"`.
  - The same `import_id` under a second project succeeds.
  - `parent_id` pointing at a missing revision is refused; pointing at `fixtureIds.planRevision` succeeds.
  - `submitted_blob` pointing at an unstored hash is refused, and so is each of `choices_blob` and `accepted_blob`.

`test/helpers/rows.test.ts` gains: after `seedRegistry` and `seedGraph`, `SELECT COUNT(*) AS c FROM node` is `3` and `SELECT COUNT(*) AS c FROM plan_revision` is `1`.

`npm run verify` exits 0.

Proof: contributes `src/services/storage/migration-0002-graph-and-plan.test.ts` to `node --test src/services/storage/**/*.test.ts`. Delivers the EPIC's hermetic requirements on `partial`, `awaiting_approval` and the block reason.
