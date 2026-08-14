# Story 16 — The domain document amendment

Epic: `.agent/plan/epics/014-external-drive-contract.md`
Depends on: Story 4 (the actor kinds it names) and Story 10 (the validity scopes it names). Run it last.

Document-only story. It writes no TypeScript.

## Change

Two paragraphs are added to `docs/proposal/phase-1/domain.md`. This is the file `AGENTS.md` points a later reader at, so a split recorded only in `state-machine.md` is a split a reader misses.

### `docs/proposal/phase-1/domain.md`, the `## Domain model` section

Insert one new paragraph after line 16 and before the `## Three entries above persist nothing` heading at line 18, separated by a blank line on each side. The paragraph is exactly:

```
**Plan validity holds two scopes, and each one runs at a different place.** A **structural** finding is a defect in the submitted document set: an unparsable document, a bad path, a duplicate identity, a missing parent, a dependency cycle, a cross-parent dependency, an unknown worker or an unbound repository. A structural finding refuses the write. A **completeness** finding records that a container holds no child: an initiative with no objective, or an objective with no task. Completeness is enforced at the claim only. `plan.import` and a per-node write both report a completeness finding and commit, and a claim under an incomplete node is refused. `src/domain/plan-finding.ts` holds the scope of every finding code, and `src/domain/plan-completeness.ts` holds the completeness function.
```

### `docs/proposal/phase-1/domain.md`, the `## State and events` section

Insert one new paragraph after line 29 and before the `## Storage` heading at line 31, separated by a blank line on each side. The paragraph is exactly:

```
**An event names its actor kind, and there are three.** A `human` decides. A `daemon` writes what it derived on its own. A `harness` is an external agent that claims work and reports an outcome. A `human` and a `harness` each register and hold their own token; a `daemon` registers nothing. EPIC 015 lands the enum, the service-interface type, the request schema, the migration and `../database/event.md` in one change.
```

## Constraints

- **`src/domain/rows.test.ts:59-90` parses this file.** It finds the marker line `` `node:sqlite`. Tables: `` at `docs/proposal/phase-1/domain.md:33`, takes the **first non-empty line after it** as the table declaration line, and asserts the backticked names on that line deep-equal `Object.keys(rows)`. Insert nothing between line 33 and line 35, and change neither line.
- `src/domain/rows.test.ts:46-57` asserts every key of `rows` appears somewhere in this file as a backticked name. Delete no backticked table name.
- Neither new paragraph may add a backticked lowercase-and-underscore word to the table declaration line. Both paragraphs sit outside the `## Storage` section entirely.
- Change no other line of `docs/proposal/phase-1/domain.md`. Change no other file.
- Write no TypeScript. `src/domain/event.ts:6` keeps `["human", "daemon"]`; EPIC 015 widens it.

## Verify

- `node --test src/domain/rows.test.ts` exits 0 with no edit. This proves the marker line, the declaration line and every table name survived.
- `grep -n "Plan validity holds two scopes" docs/proposal/phase-1/domain.md` returns a line inside the `## Domain model` section, above the `## Three entries above persist nothing` heading.
- `grep -n "An event names its actor kind" docs/proposal/phase-1/domain.md` returns a line inside the `## State and events` section, above the `## Storage` heading.
- `grep -n "harness" docs/proposal/phase-1/domain.md` returns at least one line.
- `grep -n "plan-completeness.ts" docs/proposal/phase-1/domain.md` returns at least one line.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014` through the unchanged `src/domain/*.test.ts` glob, which includes `src/domain/rows.test.ts`.
