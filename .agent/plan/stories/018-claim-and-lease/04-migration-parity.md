# Story 4 — Migration parity, split in two questions

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 2 and Story 3. **Coupled with both.** This story is what returns the suite to green.

Two different questions need two different assertions. "Did migration 0003 ship the schema version 3 declared" is answered against a **frozen** copy of the version-3 DDL. "Does the schema the daemon reaches today equal the proposal fence today" is answered against `proposalStatements`.

## Change

### `src/services/storage/migration-0003-execution-and-journal.test.ts`

The parity assertion is at `src/services/storage/migration-0003-execution-and-journal.test.ts:403-424`. It compares `executionAndJournal.statements.flatMap(normalize)` with the nine current proposal fences. Story 2 rewrote three of those fences, so the assertion is red.

Follow the precedent `.agent/plan/epics/017-per-node-graph-write.md:67` sets for `plan_revision`. Add three module-level constants above the `describe`, each holding the **version-3** DDL verbatim, already normalized to the single-space form `normalize` produces:

- `historicalRunStatements: readonly string[]` — **two** members, the version-3 `CREATE TABLE run` from `src/services/storage/migration-0003-execution-and-journal.ts:30-45` and the `run_one_active` index from `:46`. It is a list because `proposalStatements("run")` returns two statements today.
- `historicalAttemptStatement: string` — the version-3 `CREATE TABLE attempt` from `:47-60`.
- `historicalLeaseStatement: string` — the version-3 `CREATE TABLE lease` from `:20-29`.

The expectation becomes exactly this, in the original statement order:

```ts
[
  ...proposalStatements("workspace"),
  historicalLeaseStatement,
  ...historicalRunStatements,
  historicalAttemptStatement,
  ...[
    "agent_invocation",
    "candidate",
    "check_result",
    "git_operation",
    "event",
  ].flatMap(proposalStatements),
];
```

The statement order of migration 0003 is `workspace`, `lease`, `run`, `run_one_active`, `attempt`, `agent_invocation`, `candidate`, `check_result`, `git_operation`, `event`. Ten statements. The `it` title keeps the word ten.

Derive each constant by copying the template literal out of `src/services/storage/migration-0003-execution-and-journal.ts` and collapsing whitespace by hand, or by declaring it as a template literal and passing it through the same `normalize` the test already defines at `:404-409`. Prefer the second: it removes the hand-collapsing step and it is a one-line change per constant.

### `src/services/storage/migration-0007-external-execution.test.ts`

Add one assertion to the file Story 3 created:

- `the rebuilt tables equal the three proposal fences` — filter `migration0007ExternalExecution.statements` to the members whose trimmed text starts with `CREATE TABLE run (`, `CREATE UNIQUE INDEX run_one_active`, `CREATE TABLE attempt (` and `CREATE TABLE lease (`, normalize each with the same whitespace collapse, and assert:
  - the `run` table statement and the index statement, in that order, deep-equal `proposalStatements("run")`;
  - the `attempt` statement deep-equals the single member of `proposalStatements("attempt")`;
  - the `lease` statement deep-equals the single member of `proposalStatements("lease")`.

  Filter by prefix and not by array index, so a later step insertion does not silently move the assertion onto the wrong statement.

Add the domain-to-DDL parity assertion in the same file, beside the shape of `assertClauseAgrees` at `src/services/storage/schema-parity.test.ts:49`. Import `runRow`, `attemptRow` and `leaseRow` from `src/domain/`. For each of the three refinements EPIC 014 declared, assert the DDL of the migrated table carries the matching clause:

- `run.driver CHECK agrees with the domain runDrivers` — `assertClauseAgrees(storage, "run", "driver", runDrivers)`.
- `attempt.driver CHECK agrees with the domain runDrivers` — the same over `attempt`.
- `lease.owner_kind CHECK agrees with the domain leaseOwnerKinds` — the same over `lease`.
- `each driver-conditional column carries its SQL CHECK` — read the `run` DDL from `sqlite_master` and assert it includes each of the three clause texts `(driver = 'internal') = (workspace_id IS NOT NULL)`, `(driver = 'internal') = (worker IS NOT NULL)` and `(driver = 'internal') = (base_oid IS NOT NULL)`, and does **not** include a clause naming `head_oid`. Read the `attempt` DDL and assert the four matching clause texts.
- `the domain refinement and the SQL CHECK refuse the same row` — for each of the seven driver-conditional columns, build the row object that `runRow` or `attemptRow` refuses, assert the zod parse fails, and assert the equivalent `INSERT` throws. One `it` per table is enough; loop the columns inside it.

`assertClauseAgrees` is currently a local helper in `src/services/storage/schema-parity.test.ts`. Export it from that file and import it here. Do not copy it.

`runDrivers` and `leaseOwnerKinds` are the literal lists EPIC 014 declares beside `runRow` and `leaseRow`. Import them from `src/domain/run.ts` and `src/domain/lease.ts`. If EPIC 014 named either list differently, import the name it declared; declare no second copy of the list in this file, because `assertClauseAgrees` exists to compare the DDL against the one domain list.

## Constraints

- `src/services/storage/migration-0003-execution-and-journal.test.ts` keeps ten statements in its expectation, and keeps `workspace`, `agent_invocation`, `candidate`, `check_result` and `event` on `proposalStatements`. Only the three rewritten tables move to a frozen constant.
- Do not delete the migration-0003 parity assertion, and do not weaken it to a length check.
- `Object.keys(rows)` in `src/services/storage/schema-parity.test.ts` is unchanged, and its table-name parity assertion at `src/services/storage/schema-parity.test.ts:104-118` needs no edit.
- Add no assertion about the version-3 `run`, `attempt` or `lease` DDL to `src/services/storage/schema-parity.test.ts`: that file asserts the schema the daemon reaches today.
- EPIC 014 owns the three `src/domain/` rows. Add none here; only assert them.

## Verify

- `node --test src/services/storage/migration-0003-execution-and-journal.test.ts src/services/storage/migration-0007-external-execution.test.ts src/services/storage/schema-parity.test.ts` exits 0.
- `npm run verify` exits 0 at the close of this story, except for the `src/http/contract/parity.test.ts` failure Story 1 opened, which Story 14 closes.
- Proof: `PASS EPIC-018`, through `src/services/storage/migration-0003-execution-and-journal.test.ts`, `src/services/storage/migration-0007-external-execution.test.ts` and `src/services/storage/schema-parity.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:182`.
