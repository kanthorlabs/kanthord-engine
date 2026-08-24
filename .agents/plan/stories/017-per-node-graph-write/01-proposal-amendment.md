# Story 1 — The proposal amendment

Epic: `.agents/plan/epics/017-per-node-graph-write.md`
Depends on: EPIC 016 (sequence order). Every other story of this epic depends on this one, because `src/http/contract/parity.test.ts` reads the route matrix of `docs/proposal/api/graph.md`.

## Change

### `docs/proposal/api/graph.md` — the Routes table at `graph.md:13-21`

Add three rows, in this order, after the existing `edge.list` row. Match the column order and the cell formatting of the rows already present.

```
| node.create | POST | /v1/project/:id/node | phase-1 | routed |
| node.update | POST | /v1/node/:id/update | phase-1 | routed |
| node.delete | POST | /v1/node/:id/delete | phase-1 | routed |
```

Source each row to `013-external-drive-overview.md:23` in the same way the neighbouring rows carry their source.

### `docs/proposal/api/graph.md` — one section per route

Add three sections, in the Routes-table order, in the shape of the existing `plan.import` section. Each names its request fields, its response fields and its declared error codes. The response of each carries `revision` and `completeness`. The `node.delete` response also carries `deleted`.

Add one paragraph, after the three sections, that states exactly these three facts:

- Two concurrency classes exist. A field-only update carries the node revision. A create, a topology change and a delete carry the project revision. A mismatch is `409 stale-revision`, and `details.guard` names the class.
- A structural finding refuses the write with `422 plan-invalid`. It refuses at `plan.import` and at every per-node write.
- A completeness finding refuses nothing. It travels in the success body under `completeness`. The two completeness codes are `initiative-without-objective` and `objective-without-task`.

### `docs/proposal/phase-1/state-machine.md:47`

EPIC 014 Story 10 already replaced the original line. Replace the EPIC 014 text with exactly this line:

```
An objective with no tasks, or an initiative with no objectives, is incomplete. Every write reports the finding and commits. A claim under an incomplete node is refused.
```

If the line already reads exactly that after EPIC 014, change nothing and record that in the commit message.

### `docs/proposal/phase-1/plan-format.md:135`

The line reads today:

```
The database baseline is always valid, so the procedure terminates.
```

Replace it with exactly:

```
The database baseline is always structurally valid, so the procedure terminates.
```

### `docs/proposal/api/README.md:98-104` — the precondition table

Add three rows, in the Routes-table order, each naming `fromRevision` as the precondition token, in the shape of the existing `plan.import` row.

### `docs/proposal/api/README.md:178`

The line states that a removal is refused. Replace its text with exactly:

```
a removal, a containment move or a delete is refused, and `details.blockers` lists what blocks it
```

Keep the surrounding row or sentence structure of `README.md:178` unchanged; replace the description text only.

### `docs/proposal/database/plan_revision.md`

Replace the whole `sql` fence at `plan_revision.md:5-16` with the migration-0006 DDL. Keep the trailing `;`, keep the `-- ` comment style of the existing fence, and keep the column alignment style. The fence must normalize, through `proposalStatements` at `test/helpers/proposal.ts:8-27`, to the exact `CREATE TABLE plan_revision` statement Story 2 puts in `statements`.

### `docs/proposal/database/migration.md`

The migration list at `migration.md:17-22` is a plain-text fence, not a table. It holds rows for versions 1 to 3 only. Add rows for `0004-event-indexes`, `0005-actor` and `0006-revision-origin`, keeping the existing column alignment. Update the prose at `migration.md:24` from "Three rows appear" to "Six rows appear" and from "prints these three versions" to "prints these six versions".

## Constraints

- Edit documents only. Change no file under `src/` and no file under `test/`.
- Add no `node.discard` row. `docs/proposal/api/outcome.md:13` keeps it phase-3.
- Every resource segment stays singular. The paths above use `project` and `node`, never a plural.
- Do not renumber, reorder or reword any existing row of the Routes table.

## Verify

- `node --test src/http/contract/parity.test.ts` — the test reads the matrix through `readRouteMatrix` of `test/helpers/proposal.ts`. It fails on this story alone, because the registry does not yet hold the three operations. Story 12 makes it pass. Record that expected red in the commit message, and do not weaken the test.
- `grep -c "is always valid, so the procedure terminates" docs/proposal/phase-1/plan-format.md` returns `0`.
- `grep -c "0006-revision-origin" docs/proposal/database/migration.md` returns `1`.
- `grep -c "node.create" docs/proposal/api/graph.md` returns at least `2` — one Routes row and one section heading.
- `npm run verify` exits 0 only after Story 12 lands. This story is dispatched first and verified with Story 12.
- Proof: no `PASS` line of its own. It is the precondition of `src/http/contract/*.test.ts` in the Proof block at `.agents/plan/epics/017-per-node-graph-write.md:121`.
