# Story 20 — The real-composition-root loop

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: every earlier story. This is the last story of the epic.

## Change

### A new `src/main.report.test.ts`

One test file in the pattern of `src/main.claim.test.ts` of EPIC 018, suite name `"src/main.report.test"`. It uses no injected handler map at any step: it proves the production composition root.

Each `it` follows this fixture shape:

1. Create one temporary home through `test/helpers/home.ts` and remove it in the teardown.
2. Migrate it through the CLI migrate path the EPIC 018 file already uses.
3. Launch the daemon with `launchDaemon` at `test/helpers/daemon.ts:29`, which spawns `src/main.ts`, and `await ready()`.
4. Register a `harness` actor with the bootstrap human token, and keep both tokens.
5. Import one plan holding one initiative, one objective with two dependent tasks, and a second objective that depends on the first and holds one task.
6. Drive HTTP requests against the listening daemon and assert from the database and from the responses.

The named tests:

- `it("the whole loop reaches done through the real composition root", ...)`, in this exact order:
  1. The harness claims the one `ready` task of the first objective.
  2. `node.report` with `accepted`, the live fence and a 40-character object id answers `200`.
  3. The task is `done`.
  4. The objective is still `running`, and the response `objectiveProjection` is `done` for the report that made the last task terminal.
  5. **Read the objective `lease` row before the attestation** and assert `owner` equals the reporting harness actor id and `fence` equals the fence the claim minted.
  6. `node.show` on the objective returns `projection: "done"` and `attestedObjectId: null`.
  7. The harness attests through `node.report` with `attested` and the objective fence; the response is `200` and **not** `409 lease-held`.
  8. The objective is `awaiting_approval`, and its active run carries the attested object id in `head_oid`.
  9. `node.show` returns that same `attestedObjectId`.
  10. A `human` token closes it; the objective is `done`.
  11. The objective run is ended with outcome `done`.
  12. The initiative is still `running`, because the second objective is not terminal. Aggregation rolls up only when every child objective is terminal.
  13. The second objective is `ready`.
  14. The harness claims the task of the second objective, reports it `accepted`, and attests the second objective. A `human` token closes it, and the second objective is `done`.
  15. The initiative is `done`.

  Every state is asserted by identity, never by count.

- `it("two sequential sibling tasks stay with one harness", ...)` — the harness claims the first task, reports it `accepted`, and the second task becomes `ready`. A second registered harness claiming that second task is `409 lease-held`. The first harness then claims it with `200`, reports it, and attests the objective with `200`. This journey fails the moment a task report frees the objective lease.

- `it("the active run survives a daemon restart and adoption is the only recovery", ...)` — report `rejected` under the limit, stop the daemon, launch a second daemon on the same home, and claim again **with the same harness token**. The claim adopts the same run id, mints attempt number 2, and mints a new task fence. The objective lease survives with the same owner and the same fence. The expiry sweep touches nothing: the task lease is free with a null `expires_at`, and the objective lease is live.

- `it("an objective abandoned after a task report is recovered by expiry", ...)` — the harness reports its last task `accepted` and attests nothing. Advance past `leaseTtlMs` and have a second actor claim an unrelated task, which runs the sweep. The objective lease then holds a null owner and the objective is claimable by the second actor. The objective state stays `running` throughout.

- `it("a replayed report under a repeated Idempotency-Key closes no second attempt", ...)` — the same `Idempotency-Key` returns the captured `200`; the `attempt` row count and the node row are compared before and after. The same report sent again with **no** key is `409 illegal-transition`, because the task is already `done`.

- `it("a report by a human token and a close by a harness token are each 403 actor-forbidden", ...)` — over the real `authorize` middleware and the real command, with a byte-identical database before and after each.

- `it("a task blocked at the attempt limit runs again after an unblock", ...)` — drive three `rejected` reports under an `attempt_limit` of 3, so the task is `blocked` with reason `attempt-limit` and its task run is ended with outcome `blocked`. The **configured human token** then calls `node.unblock`: the answer is `200`, the task reads `ready`, and the events are `node.unblocked` naming that human with `clearedReason: "attempt-limit"`, then `node.ready` naming the daemon instance. The same harness claims that task again; the claim carries a **new** run id, asserted not equal to the ended run id, and attempt number 1. It reports the task `accepted`, the task is `done`, and the objective then attests and closes to `done`. Without the unblock that objective is unclosable, which is why this assertion closes the loop rather than the report alone.

- `it("an unblock by a harness token is 403 actor-forbidden", ...)` — over the real `authorize` middleware, with a byte-identical database before and after.

## Constraints

- No injected handler map, no `createTestApp` and no direct command import in this file.
- Advance time through the daemon's own configured TTL and the fixture clock the EPIC 018 file already uses. Do not sleep on the wall clock.
- Remove every temporary home in the teardown, and kill every launched daemon.
- **It proves no packaging.** `package.json` publishes `dist/main.js`, `launchDaemon` spawns `src/main.ts`, and `npm run verify` never runs `npm run build`. Claim no packaged binary.
- Give the file a generous `--test-timeout`; it launches daemons.

## Verify

- `node --test --test-timeout=120000 src/main.report.test.ts` exits 0.
- Run the whole epic Proof block of `019-outcome-report.md:102-128` and confirm it prints `PASS EPIC-019`.
- `npm run verify` exits 0.
- Proof: `src/main.report.test.ts`, and the Proof block as a whole. Hermetic coverage: `019-outcome-report.md:134`, `:141`, `:145`, `:146`, `:174`, and the `403` clauses of `:153`.
