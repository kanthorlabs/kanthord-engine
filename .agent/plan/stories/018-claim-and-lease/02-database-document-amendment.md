# Story 2 — The database document amendment

Epic: `.agent/plan/epics/018-claim-and-lease.md`
**Coupled with Story 3 and Story 4.** Implement 2, then 3, then 4, with no verify gate between them. This story alone turns `src/services/storage/migration-0003-execution-and-journal.test.ts` red, and Story 4 is what makes it green again.

## Change

`proposalStatements(table)` at `test/helpers/proposal.ts:8` reads the **first** ` ```sql ` fence of `docs/proposal/database/<table>.md`, strips `--` comments outside single quotes, splits on `;`, collapses every whitespace run to one space and trims. Every DDL below is therefore compared modulo whitespace and modulo comments, and **not** modulo column order, clause order or clause text.

### `docs/proposal/database/run.md`

The fence starts at `docs/proposal/database/run.md:5`. Replace its whole content with the post-0007 DDL. It holds **two** statements, the table and the index, and it keeps them in that order, because `proposalStatements("run")` returns both today.

```sql
CREATE TABLE run (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('objective', 'task')),
  node_id       TEXT NOT NULL REFERENCES node(id),
  parent_run_id TEXT REFERENCES run(id),
  driver        TEXT NOT NULL CHECK (driver IN ('internal', 'external')),
  workspace_id  TEXT REFERENCES workspace(id),
  worker        TEXT,
  lease_fence   INTEGER NOT NULL,
  attempt_limit INTEGER NOT NULL,
  base_oid      TEXT,
  head_oid      TEXT,
  state         TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  outcome       TEXT,
  ended_at      INTEGER,
  CHECK ((kind = 'objective') = (parent_run_id IS NULL)),
  CHECK ((driver = 'internal') = (workspace_id IS NOT NULL)),
  CHECK ((driver = 'internal') = (worker IS NOT NULL)),
  CHECK ((driver = 'internal') = (base_oid IS NOT NULL)),
  UNIQUE (id, driver)
) STRICT;

CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active';
```

Keep the `--` comments on the columns that carry one today, and add one comment per new column and per new clause. Comments are stripped before comparison, so their text is free. `head_oid` carries **no** driver clause: EPIC 019 records a harness-reported object id there under both drivers.

Add one sentence to the prose below the fence: `UNIQUE (id, driver)` is a second candidate key that exists so `attempt` can declare a composite foreign key; `PRIMARY KEY (id)` is unchanged, and every single-column reference to `run(id)` stays valid.

### `docs/proposal/database/attempt.md`

The fence starts at `docs/proposal/database/attempt.md:5`. Replace its content with:

```sql
CREATE TABLE attempt (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES run(id),
  driver         TEXT NOT NULL CHECK (driver IN ('internal', 'external')),
  attempt_no     INTEGER NOT NULL,
  provider_id    TEXT REFERENCES provider(id),
  provider_model TEXT,
  timeout_ms     INTEGER,
  base_oid       TEXT,
  head_oid       TEXT,
  outcome        TEXT CHECK (outcome IS NULL OR outcome IN
                 ('accepted', 'rejected', 'failed', 'timed-out', 'cancelled')),
  ended_at       INTEGER,
  UNIQUE (run_id, attempt_no),
  CHECK ((driver = 'internal') = (provider_id IS NOT NULL)),
  CHECK ((driver = 'internal') = (provider_model IS NOT NULL)),
  CHECK ((driver = 'internal') = (timeout_ms IS NOT NULL)),
  CHECK ((driver = 'internal') = (base_oid IS NOT NULL)),
  FOREIGN KEY (run_id, driver) REFERENCES run(id, driver)
) STRICT;
```

### `docs/proposal/database/lease.md`

The fence starts at `docs/proposal/database/lease.md:5`. Replace its content with:

```sql
CREATE TABLE lease (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('node', 'repository')),
  subject_id   TEXT NOT NULL,
  owner        TEXT,
  owner_kind   TEXT CHECK (owner_kind IS NULL OR owner_kind IN ('daemon', 'actor')),
  fence        INTEGER NOT NULL,
  acquired_at  INTEGER,
  renewed_at   INTEGER,
  expires_at   INTEGER,
  PRIMARY KEY (subject_kind, subject_id),
  CHECK ((owner IS NULL) = (owner_kind IS NULL)),
  CHECK (owner_kind <> 'actor' OR owner LIKE 'actor\_%' ESCAPE '\')
) STRICT;
```

The `owner` comment changes: it reads that a `daemon` owner is a daemon instance and an `actor` owner is a registered actor identity, and that null means released.

### `docs/proposal/database/workspace.md`

Add exactly one sentence to the prose, after the `node_id` paragraph at `docs/proposal/database/workspace.md:21`: a workspace row exists for an internal run only, because an external harness owns its own working tree.

## Constraints

- Change no other file under `docs/proposal/database/`.
- Do not touch the fence of `docs/proposal/database/event.md`: EPIC 015 owns it.
- Do not touch the fence of `docs/proposal/database/plan_revision.md`: EPIC 017 owns it.
- Write the DDL exactly as Story 3 writes it into the migration. A whitespace difference is legal, a clause-text or clause-order difference is not.
- Do not edit `src/domain/run.ts`, `src/domain/attempt.ts` or `src/domain/lease.ts`. EPIC 014 owns those three refinements.

## Verify

- `node --test src/services/storage/migration-0003-execution-and-journal.test.ts` is **red** after this story, on the parity assertion at `src/services/storage/migration-0003-execution-and-journal.test.ts:403-424`. Story 4 fixes it. Do not edit that test here.
- `node --test test/helpers/proposal.test.ts` exits 0: the three fences still parse, and `proposalStatements("run")` still returns two statements.
- Proof: contributes to `PASS EPIC-018` through `src/services/storage/migration-0003-execution-and-journal.test.ts` and `src/services/storage/migration-0007-external-execution.test.ts`, both closed by Story 4.
