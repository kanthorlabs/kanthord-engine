# EPIC 050.1 — The claim — stories

Epic: `.agents/plan/epics/050.1-the-claim.md`
Prereq: EPIC 050, implemented. Every story here reads the run row, the exclusion rules, the claim seams and the budgets that EPIC 050 creates. EPICs 047 and 048 must land before EPIC 050. See **Facts** below.

A claim opens exactly one run, writes the node assignment in the same transaction, evaluates one total refusal order before the first mutation, and expires a due run before it acts. The schema, the pure exclusion rules and the budgets belong to EPIC 050. `node.renew`, `node.release` and `node.report` belong to EPIC 050.2, and the node lease is removed in EPIC 050.4.

## One story, one path

A story that changes a shipped path draws a pair: the baseline, which is the shipped code, and the ship diagram, which is the replacement. A story that writes new code draws one diagram. A story that changes no path — a contract registration, a test helper, a gate script — draws nothing, and the pair rule does not reach it. `.agents/plan/authoring.md` is the grammar, and `scripts/verify-epic-sequence.ts` of Story 8 enforces it.

Four stories carry a diagram: 2, 3, 4 and 5. The other five carry none.

## Dispatch order

Story 1 is a wide fan-out across the contract and must land before Stories 2 to 5, all of which need its request field and its event types.

Story 6 is independent and can run concurrently with Story 1 — it is a test helper and imports no production module beyond types. Stories 2 to 5 each declare it, because each adds a scenario file that only the harness can run.

Story 2 depends on Story 1, Story 6, EPIC 050 Story 2 and EPIC 050 Story 8.

Story 3 is the integration point. It depends on Story 1, Story 2, Story 6, and EPIC 050 Stories 1, 2, 3, 4, 5, 7 and 8.

Story 4 depends on Story 3 and Story 6. Story 5 depends on Story 3, Story 6 and EPIC 050 Stories 6 and 8.

Story 7 depends on Story 6. Story 8 depends on Story 6.

Story 9 depends on every prior story of this epic and on EPIC 050 Story 7 (`07-the-proposal-records-the-run-model`), which creates the document it extends. It states what the code does, so write it last.

A workable serial order: **1 → 6 → 2 → 3 → 4 → 5 → 7 → 8 → 9**.

No story depends on a story later than itself in that order.

## Stories

- 1 — The claim contract → `01-the-claim-contract.md`
- 2 — The expiry pass → `02-the-expiry-pass.md` — draws `expiry-pass-one-due`
- 3 — The claim of a task → `03-the-claim-of-a-task.md` — draws `baseline-claim-task` and `claim-success-task`
- 4 — The claim of an initiative → `04-the-claim-of-an-initiative.md` — draws `baseline-claim-initiative` and `claim-success-initiative`
- 5 — The objective-busy refusal → `05-the-objective-busy-refusal.md` — draws `claim-refusal-objective-busy`
- 6 — The conformance harness → `06-the-conformance-harness.md`
- 7 — The conformance runner → `07-the-conformance-runner.md`
- 8 — The range gate → `08-the-range-gate.md`
- 9 — The proposal records the claim → `09-the-proposal-records-the-claim.md`

## Where this epic came from

EPIC 050 held seventeen stories, and `.agents/plan/authoring.md` caps an epic at ten. The stories here are the claim half. The conformance machinery came with the claim, because the claim's scenarios are its first consumers. The run kind, migration `12`, the run row, the published `assignment`, the two exclusion rules, the budgets and the claim seams stayed in EPIC 050.

**The proposal document is written in three parts, one per epic.** EPIC 050 Story 7 (`07-the-proposal-records-the-run-model`) creates `docs/proposal/phase-2/runs-and-exclusion.md` and records the run model. Story 9 here adds the claim sections. EPIC 050.2 Story 9 adds the authority sections. A single story could not carry the whole document: it would state a rule two later epics implement, and no epic can prove a sentence about code it does not ship.

## Decisions taken during authoring, and now recorded in the EPIC

A human ruled on each. The EPIC carries them; these stories implement them.

- **The expiry pass deletes no candidate ref.** The namespace `refs/kanthord/candidate/<runId>/<attemptNo>` is declared by EPIC 051.1 (`.agents/plan/epics/051.1-the-candidate-and-the-git-primitives.md`), nothing in this range creates one, and `services/git` carries no delete primitive — `RefUpdateInput.nextOid` at `src/services/git/index.ts:51` is a non-null `string`. EPIC 051.1 adds the expiry path as a fourth caller of its own deletion. See `02-the-expiry-pass.md`.
- **The claim records the project's newest plan revision, not the node's.** The claim reads `plan.newestRevision(transaction, node.projectId)` (`src/services/plan/index.ts:75`) and never `node.revision`, which `docs/proposal/database/node.md:44` defines as the revision that last _wrote_ the node — pinning it would make EPIC 052 refuse a run that raced nothing. See `03-the-claim-of-a-task.md`.
- **The claiming worker comes from a server-owned caller record.** `ClaimNodeDependencies` carries `{ worker, authorized }`; `main.ts` binds `{ worker: "claude@1", authorized: ["claude@1"] }`. It is never derived from `input.actorId`, an `actor_<ULID>` authentication identity, and never read from the wire — a `worker` request field would create two worker authorities once EPIC 055 lands. The command intersects `authorized` with `capableWorkers` before calling `routeWorker`, because EPIC 048 throws on an unintersected input. See `03-the-claim-of-a-task.md`.
- **A refusal rolls the expiry back with everything else, and that is correct.** `src/services/storage/connection.ts:83` rolls back the whole callback on a throw, and the engine exposes no savepoint and no nested transaction. An expired-but-unswept run authorizes nothing, because every operation runs the pass before it evaluates authority. Splitting the expiry into its own transaction would break one command, one transaction, open a window for another claim, and break the rule that a refusal writes nothing. A claim that _succeeds_ commits the expiry and the replacement run atomically, so `run_one_active` never sees two active rows. See `02-the-expiry-pass.md` and `03-the-claim-of-a-task.md`.
- **The claim has one path, and every legacy construct is deleted.** `node.deliverable` is `NOT NULL` after migration `12`, so there is no legacy node to branch for. `openOrAdoptRun`, the own-lease replay path, `initiative-not-claimable` and `run-driver-mismatch` are deleted, not deferred. One total refusal order governs the single path, and every refusal fires before the first mutation. See `03-the-claim-of-a-task.md` and `04-the-claim-of-an-initiative.md`.
- **A review claim refuses `review-head-unavailable` in this epic.** No workspace record exists, so no head can be pinned into `judged_oid`, and writing `NULL` now and filling it in EPIC 051 would record a commit chosen after the claim — the retrospective choice the pin exists to prevent. See `03-the-claim-of-a-task.md` and `01-the-claim-contract.md`.

## Decisions the baseline comparison forced

Drawing the shipped claim before drawing its replacement produced four corrections. The EPIC carries them.

- **The claim reads the lease of every relative, and the diagram draws one step per read.** `claim-node.ts:157` calls `liveLeasesOf` over `relativesOf`, which returns the target, the parent, the children and the siblings. The fixture takes three reads, not one.
- **The own-lease read at `claim-node.ts:179` dies with the replay path.** Two reads of one subject carry one token twice, which the parser refuses. Deleting the replay path is what makes the path drawable.
- **The expiry pass is a capability key, not a function-valued dependency.** `sweepExpiredExternalLeases` at `claim-node.ts:58` holds no `<key>.<method>` token, so `ClaimNodeDependencies` takes `expiry: Expiry` instead.
- **A run-scoped seam projects the run id.** `execution.openAttempt` receives a run id, so it renders `:R` and never `:T`. A projection nobody can compute is a step nobody can check.

## Still open

Nothing blocks dispatch once EPIC 050 lands.

## Facts (needed for implementation)

### The routing function is not implemented

`routeWorker` — `{ registry, kind, deliverable, authorized, available }` returning `{ routed: true, worker }` or `{ routed: false, refusal: "unroutable", failedSet: "capable" | "authorized" | "available" }`. EPIC 048 Story 3. `available` is a `readonly string[]`; the wire field is a boolean, and Story 3 maps one to the other.

### Line anchors the EPIC cites that are stale

- `src/commands/node/claim-node.ts` — the EPIC cites lines 99, 104 and 105. The real sites are: `storage.transact` opens at **:104**, `clock.now()` at **:105**, the lease sweep at **:107-110**, `plan.readAllNodes` at **:112**, `ClaimRefusal` at **:27-35**.
- `docs/proposal/api/README.md:100` — the EPIC's anchor is stale twice over. The forbidden list now opens at **:101**, and `add a required request field;` is no longer in it: a human moved it to the permitted list on 2026-09-03 and it is line **98**. The closing sentence EPIC 050.2 Story 8 replaces is still line **108**.

### Commands

- `src/commands/run/` does not exist. Story 2 creates it, and EPIC 050.2 adds `renew-run.ts` to it.
- `Transaction` (`src/services/storage/index.ts:1-5`) has exactly `run`, `get` and `all`. `transact` is synchronous and refuses a thenable (`connection.ts:90-101`), and re-entrant `transact` throws (`sqlite.ts:143-150`) — so a nested transaction is impossible and `expireRuns` must take the caller's transaction.
- `EventLog.append(transaction, input)` at `src/services/event/index.ts:50`; the canonical call site is `src/commands/node/claim-node.ts:300-317`.
- `Clock` is `{ now(): number }`. Every command reads it once as the first statement inside `storage.transact`.
- Test fixture: `createMigratedStorage()` and `databaseBytes()` from `test/helpers/database.ts`, `createMockClock({ start: 1700000000000 })`, `createMockIdGenerator({ ulids })`, and the row seeders in `test/helpers/rows.ts` (`seedRegistry` `:21`, `seedGraph` `:102`, `seedNodeState` `:267`, `seedRunRow` `:658`).
- The refusal test convention is: seed, snapshot `databaseBytes`, call the `refused` helper, assert `error.refusal`, assert `error.details` with `assert.deepEqual`, assert the bytes are unchanged — `src/commands/node/claim-node.test.ts:550-562`.

### Contract

- There is no `src/http/contract/node.ts`. The four node operations live in `execution.ts` (`node.claim` `:246-264`, `node.heartbeat` `:265-283`, `node.release` `:284-302`) and `outcome.ts` (`node.report` `:135-157`).
- `actionSegments` at `src/http/contract/path.ts:40-65` is a bytewise-sorted closed array of 24. `"renew"` sorts **after** `"rename"` and before `"report"`. `src/http/contract/path.test.ts:40` pins the count.
- The registry total is **73** and routed is **48** (`registry.test.ts:49-51`, `:64-73`). A rename moves neither.
- `parity.test.ts` reads **every** `*.md` under `docs/proposal/api/` except `README.md` and `new-decisions.md`, and compares four fields: `method`, rendered `path`, `introducedIn`, `status`. Its comparable count is pinned at 73 at `:16`.
- `runtime-matrix.test.ts` reads `docs/proposal/phase-1/runtime-capability-matrix.md`, requires the rows in registry order, pins the count at 48, and requires exactly nine cells per row.
- The harness operation list is duplicated in **three** places: `registry.test.ts:27-46`, `authorization.test.ts:17-36` and `system.test.ts:359-436`. All three move together.
- `errorStatuses` at `errors.ts:7-31` is ordered by ascending HTTP status, and every 409 is a `PreconditionCode` whose `httpError` overload **requires** a `details` argument (`errors.ts:95-111`).
- `eventPayloads` at `event-payload.ts:71` is typed `Readonly<Record<EventType, ZodType>>`, so a new event type without a payload fails type checking. The shared `fence` alias is at `:29-35`.
- `src/http/contract/system.ts:84` is already stale: it lists three capabilities where the live registry declares four.
- `coverage.test.ts:273` asserts every `z.enum` in the contract traces to a `domain/` import, and `:355` requires a line in `field-decisions.fixture.ts` for every registry field.

### Verify

`pnpm run verify` is `format && typecheck && test && lint && node scripts/verify-db-status.ts && verify:guards`. It emits and validates the master OpenAPI document and every feature slice in a temporary directory.
