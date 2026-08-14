# Story 1 — The proposal amendment

Epic: `.agent/plan/epics/018-claim-and-lease.md`

## Change

### `docs/proposal/api/execution.md`

The Routes table sits at `docs/proposal/api/execution.md:9-20`. Append three rows after the `worker.list` row at `:19`, in this exact order and with these exact cell values:

```
| `node.claim`     | `POST /v1/node/:id/claim`     | phase-1      | routed  | `013-external-drive-overview.md`, the claim |
| `node.heartbeat` | `POST /v1/node/:id/heartbeat` | phase-1      | routed  | `013-external-drive-overview.md`, the claim |
| `node.release`   | `POST /v1/node/:id/release`   | phase-1      | routed  | `013-external-drive-overview.md`, the claim |
```

`readRouteMatrix` at `test/helpers/proposal.ts:52` reads a table row only when it holds five cells and the third cell is a member of `introducedInValues`. Keep exactly five cells per row.

Rewrite the "Leases have no route" section body at `docs/proposal/api/execution.md:90`. Keep the first two sentences unchanged. Append one amendment clause: the lease is still not addressable, and a claim, a heartbeat and a release are actions on the node, spelled `POST /v1/node/:id/claim`, `POST /v1/node/:id/heartbeat` and `POST /v1/node/:id/release`.

Add one new section after it, titled `## The objective scope of a claim`, holding exactly three sentences:

- An external claim holds the objective.
- A task claim holds the objective and the task.
- Two actors never hold two sibling tasks of one objective.

Add one section per new route, after that one, in the table order: `## node.claim`, `## node.heartbeat`, `## node.release`. Each section states the request body, the response members and the refusal codes named in Story 14.

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
- Register nothing in `src/http/contract/`, and change no literal in `src/http/contract/parity.test.ts`. Story 14 adds the three registry rows and raises both count literals in one change.

## Verify

- `node --test src/domain/transition.test.ts` exits 0.
  - `transitions.length` is unchanged.
  - The `running → ready` row still reports `task: true`, `objective: false`, `initiative: false`.
  - The note-parity assertion of EPIC 002 reads the amended Note cell of `docs/proposal/phase-1/state-machine.md:78` and finds the identical string in `src/domain/transition.ts`.
- `src/http/contract/parity.test.ts` is **red from this story until Story 14**, on `missingFromRegistry` holding the three new operation ids and on both count literals. That is the intended coupling of a proposal-first amendment. Do not add a registry row and do not move a literal here to hide it. `npm run verify` therefore passes at Story 14 and not before.
- **Record the two pre-edit literals in the commit message.** Read `src/http/contract/parity.test.ts:16` and `:25` before this story writes anything, and write both values into the commit message. Story 14 checks them against `62` and `66` and stops when they differ, so this reading is the input to that guard.
- Proof: contributes to `PASS EPIC-018` through `src/domain/transition.test.ts`.
