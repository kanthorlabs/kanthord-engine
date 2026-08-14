# Story 1 — The proposal amendment

Epic: `.agent/plan/epics/019-outcome-report.md`

This story is **independently green**. The Routes-table row and the header sentence of `docs/proposal/api/outcome.md` are **not** here: they moved into Story 18, because the proposal row and the registry row are the two sides of one parity assertion and no story may leave the suite red for the sixteen stories between them.

## Change

### `docs/proposal/api/outcome.md`

Add one new section after the Routes table and before `## One path for abandon` at `:16`, titled `## node.report`. It states, one sentence per rule:

- One route, and the node kind decides the behaviour. It repeats no text of `## One path for abandon`; it names that section instead.
- A task report carries one of `accepted`, `rejected`, `failed` and `cancelled`. `accepted` moves the task `running → done` and records the reported object id. `rejected`, `failed` and `cancelled` close the attempt and return the task to `ready` under the attempt limit, and reach `blocked` with reason `attempt-limit` at the limit.
- `timed-out` is not a reported outcome, because an external attempt carries no timeout budget.
- A task report requires a live lease on the task: a matching owner, a matching fence and an unexpired row. Every refusal is `409 lease-held`.
- The authenticated actor is the owner. The request body carries no owner field.
- An objective report with `attested` carries the combined object id, moves the objective `running → awaiting_approval` and releases the objective lease. The daemon infers no objective result.
- An objective report with `closed` carries `acknowledgePartial` only. The daemon derives `done` or `partial` from the task states. A derived `partial` with no acknowledgement is `409 acknowledgement-required`.
- A report on an initiative is `400 invalid-request`.
- A task report admits a `harness` actor, an attestation admits a `harness` actor, and a close admits a `human` actor.

### `docs/proposal/phase-1/state-machine.md`

Line 118 reads:

```
- Attempt accounting belongs to the domain. Each rejection increments the attempt counter. The limit moves the task to `blocked` with reason `attempt-limit`. The default limit is 3, from configuration.
```

Replace it with:

```
- Attempt accounting belongs to the domain. The attempt counter is `MAX(attempt_no)` of the active task run. Every closed attempt spends a try, whatever its outcome. The limit moves the task to `blocked` with reason `attempt-limit`. The default limit is 3, from configuration.
```

### `docs/proposal/database/attempt.md`

Line 24 ends with `` `attempt_no = attempt_limit` with an `outcome` of `rejected` moves the task to `blocked` with reason `attempt-limit`. `` Replace that sentence with:

```
`attempt_no = attempt_limit` with any non-null `outcome` moves the task to `blocked` with reason `attempt-limit`.
```

Edit the prose of `:24` only. The `sql` fence at `:5-19` does not move one byte; the `outcome` `CHECK` at `:15-16` already admits the four reported values.

## Constraints

- Edit no other file. `docs/proposal/api/README.md:98-104` gains no precondition row: a lease fence is a lease guard, not a revision precondition. `docs/proposal/api/README.md:176-184` already holds `acknowledgement-required` at `:180` and `lease-held` at `:181`.
- **Add no row to the Routes table and do not touch line 5.** Story 18 owns both, together with the registry row and the two parity counts.
- **Do not touch the `node.unblock` row and write no `node.unblock` section.** Story 19a owns that row's status change, its phase change and its section, together with the registry lifecycle flip. A `node.unblock` edit here turns `src/http/contract/parity.test.ts` red until Story 19a lands.
- The aggregation table at `docs/proposal/phase-1/state-machine.md:37-41` gains nothing.
- Move no `sql` fence in any proposal file. `test/helpers/proposal.ts` compares fences with comments stripped, so a fence edit breaks migration parity.
- Do not renumber, reorder or reword any other row of the Routes table.
- The commit hook runs prettier over staged markdown. Verify the table after the hook runs and re-check the parity test if a cell wrapped.

## Verify

- `node --test test/helpers/proposal.test.ts` exits 0, which proves the route-matrix reader still parses `docs/proposal/api/outcome.md`.
- `node --test src/services/storage/migration-0003-execution-and-journal.test.ts` exits 0, which proves no `sql` fence of `docs/proposal/database/attempt.md` moved.
- `node --test src/http/contract/parity.test.ts` exits 0 **in this story**, because the Routes table is unchanged here.
- `npm run verify` exits 0.
- Proof: this story delivers no Proof path on its own. It is the proposal-side precondition of `src/http/contract/parity.test.ts`, which Story 18 closes.
