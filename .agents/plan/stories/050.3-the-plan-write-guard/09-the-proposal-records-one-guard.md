# Story 9 — The proposal records one guard

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Depends on: Stories 1 to 8 of this epic — 01-the-run-covers-node-rule, 02-the-create-node-guard, 03-the-update-node-guard, 04-the-delete-node-guard, 05-the-unblock-node-guard, 06-the-import-plan-guard, 07-containment-stops-reading-the-lease and 08-subtree-busy-joins-the-plan-operations.
Kind: story-foundation

This story records behaviour and moves the version. It draws no path.

## Change

**Extend `docs/proposal/phase-2/runs-and-exclusion.md`** — created by EPIC 050 Story 7
(07-the-proposal-records-the-run-model) and extended by EPIC 050.1 Story 9
(09-the-proposal-records-the-claim) and EPIC 050.2 Story 9
(09-the-proposal-records-the-authority-model) — with the plan-write guard:

- **A plan write refuses while an active run covers the affected graph.** State the closure: the seed the command names, every ancestor of it, and every descendant of it.
- **The seed per command**, as the five-row table of the epic. A reader must be able to answer "does editing this node refuse right now" without reading a command.
- **The refusal is `subtree-busy`**, the same code and the same details a claim raises, because the plan write and the claim answer the same question about the same graph.
- **The liveness boundary.** `expires_at <= now` is expired, and it is the same boundary the claim's exclusion and the worker's authority check use. A plan write is admitted at exactly the instant the stale worker is refused.
- **Coverage is a property of the run, not of the node state.** A node left `running` behind an expired run is editable, because the worker that held it can no longer write. A rule keyed on `node.state = 'running'` would block edits behind a dead worker until the daemon restarted.

State no file path, no dependency key and no SQL. The proposal records behaviour; the stories record
the paths.

**Move `KANTHORD_VERSION`** at `src/domain/version.ts:1 — `KANTHORD_VERSION`` to `28.0.1`. EPIC 050.2
Story 8 (08-the-policy-amendment-and-the-capability-swap) leaves it at `28.0.0`. It is a patch: no request
field, response field, event type, operation id or capability name changes. Story 8 does add
`subtree-busy` to five operations, which is **adding a member to an enum** — permitted inside `/v1`
by `docs/proposal/api/README.md:96`, and a client must tolerate an unknown enum member by the same
document. The code, its status and its details schema are EPIC 050.1's and are untouched, so nothing
here changes what an error code means or the status it maps to, which is the forbidden case at
`:106`. The compatibility record gains no row.

## Constraints

- Extend the shipped document. Do not create a second one.
- Every sentence is a behaviour a test in this epic asserts.
- The version moves by patch. A minor or major bump would claim a wire change.
- Add no compatibility-record row.

## Verify

```
node --test src/http/contract/parity.test.ts src/http/contract/capability.test.ts
```

Add, each as a separate `it`:

1. `"the proposal states the plan-write guard and its seed per command"` — assert the section exists and names all five commands.

2. `"KANTHORD_VERSION is 28.0.1"` — asserted by value.

3. `"declaredCapabilities is unchanged"` — assert by value against the names EPIC 050.2 Story 8 (08-the-policy-amendment-and-the-capability-swap) leaves. No capability is retired and none is declared, so the policy amendment that story wrote is not reached.

4. `"the added error changes nothing but the operation's code set"` — assert `errorStatuses["subtree-busy"]` and the details schema are identical to the values EPIC 050.1 Story 1 (01-the-claim-contract) registered. That is what keeps the change inside the closed list rather than outside it.

5. `"the compatibility record gains no row"` — assert the row count is the one EPIC 050.2 Story 8 (08-the-policy-amendment-and-the-capability-swap) left.

`pnpm run verify` exits 0. It reads `docs/proposal/` for the parity and error-table comparisons, so a
drift between this document and the contract fails there.

Proof: PASS line delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050.3`.
