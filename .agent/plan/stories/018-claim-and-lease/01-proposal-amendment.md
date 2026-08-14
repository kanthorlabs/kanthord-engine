# Story 1 — The proposal amendment

Epic: `.agent/plan/epics/018-claim-and-lease.md`

**Scope note.** The three **route rows** of `docs/proposal/api/execution.md` are **not** in this story. They land in Story 14, in the same change as the registry entries, because `src/http/contract/parity.test.ts` compares the two sets and a row added on one side alone turns `npm run verify` red for every story in between. This story carries only the amendments that break nothing: the two prose sections and the state-machine note.

## Change

### `docs/proposal/api/execution.md`

Rewrite the "Leases have no route" section body at `docs/proposal/api/execution.md:90`. Keep the first two sentences unchanged. Append one amendment clause: the lease is still not addressable, and a claim, a heartbeat and a release are actions on the node, spelled `POST /v1/node/:id/claim`, `POST /v1/node/:id/heartbeat` and `POST /v1/node/:id/release`.

Add one new section after it, titled `## The objective scope of a claim`, holding exactly three sentences:

- An external claim holds the objective.
- A task claim holds the objective and the task.
- Two actors never hold two sibling tasks of one objective.

**Add no row to the Routes table at `docs/proposal/api/execution.md:9-20` in this story**, and add no per-route section. `readRouteMatrix` at `test/helpers/proposal.ts:52` reads only table rows, so prose sections naming the three paths are invisible to parity and land safely here.

### `docs/proposal/phase-1/state-machine.md`

The `running → ready` row is `docs/proposal/phase-1/state-machine.md:78`. **The three matrix cells do not change**: `T` stays `✅`, `O` stays `❌`, `I` stays `❌`. Only the Note cell changes. The current Note reads:

```
T: recovery finds an expired lease, a clean tree, and the head at the base. O and I: no operation rewinds a running parent to a claimable state.
```

It becomes:

```
T: recovery finds an expired lease, a clean tree, and the head at the base. A released or expired external claim also returns the task to the pool, and the daemon writes no `dirty-recovery` for a task that has no working tree. O and I: no operation rewinds a running parent to a claimable state.
```

### `src/domain/transition.ts`

The same row is `src/domain/transition.ts:135-141`. Its `note` at `:140` carries the old string. Replace the string with the amended text above, byte for byte. Change `from`, `to`, `task`, `objective` and `initiative` on that row in no way.

## Constraints

- Edit no other row of the matrix, and edit no other `note` string in `src/domain/transition.ts`.
- `docs/proposal/api/graph.md` needs no edit in this story. EPIC 014 already replaced the stale query-parameter paragraph, and Story 15 owns the `node.list` filter wording.
- Add no `deferred` row and no `post-mvp` row.
- Register nothing in `src/http/contract/`, and change no literal in `src/http/contract/parity.test.ts`. Story 14 adds the three proposal rows, the three registry rows and both count literals in one change.

## Verify

- `node --test src/domain/transition.test.ts` exits 0.
  - `transitions.length` is unchanged.
  - The `running → ready` row still reports `task: true`, `objective: false`, `initiative: false`.
  - The note-parity assertion of EPIC 002 reads the amended Note cell of `docs/proposal/phase-1/state-machine.md:78` and finds the identical string in `src/domain/transition.ts`.
- `node --test src/http/contract/parity.test.ts` exits 0, **unchanged by this story**. No route row moved on either side, so parity stays green and `npm run verify` is a live regression gate for every story of this epic.
- **Record the two count literals in the commit message.** Read `src/http/contract/parity.test.ts:16` and `:25` and write both values into the commit message. Story 14 checks them against `62` and `66` and stops when they differ, so this reading is the input to that guard.
- `npm run verify` exits 0.
- Proof: contributes to `PASS EPIC-018` through `src/domain/transition.test.ts`.
