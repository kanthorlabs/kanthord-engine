# Story 5 — The attempt open records caller and subject

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: Story 1 (`01-migration-16`), for the `attempt.caller` and `attempt.subject` columns;
Story 3 (`03-the-close-writes-the-termination`), for the `openAttempt` call sites its cases add.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.
Two facts carry that, and both are checkable. `test/helpers/sequence-conformance.ts:60` —
`execution.openAttempt` projects `input.runId` alone, so two added input fields change no token. And
`claimNode` needs **no new read**: `src/commands/node/claim-node.ts:107` — `actorId` is already an
input member, and `src/commands/node/claim-node.ts:387` — `openRun` returns the `RunRecord` whose
`worker` this story reads, in the same local binding the call site already holds.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**Both fields are required on the input, not optional.**
`src/commands/node/claim-node.ts:403` — `openAttempt` is the one production writer, and a required
field is what makes `pnpm run build` name any second writer a later epic adds. EPIC 057 makes both
columns `NOT NULL` — `.agents/plan/epics/057-non-null-enforcement-and-legacy-removal.md:63` —
`migration-0018-enforce.ts` — and an optional seam field would let a null reach the row that epic
refuses.

## Change

### 1 — `src/services/execution/index.ts` — two input fields

**Replace `src/services/execution/index.ts:73`** — `OpenAttemptInput`:

```ts
export type OpenAttemptInput = Readonly<{
  runId: string;
  caller: string;
  subject: string;
}>;
```

**`AttemptRecord` gains neither.** Story 3 (`03-the-close-writes-the-termination`) section 1 states
why: no reader in this family reads a caller or a subject back through the service, and
`.agents/plan/epics/111-inspection-and-manual-controls.md:30` — `showAttempt` reads both from the row.
`src/services/execution/sqlite.ts:25` — `ATTEMPT_COLUMNS` therefore does not grow here either, and the
cases below read both columns with raw SQL, in the idiom of
`src/commands/node/claim-node.test.ts:1639` — `SELECT driver FROM attempt`.

**Both are `string`, and neither is narrowed.** `caller` is an actor id today, a grant id from
EPIC 055 and a supervisor id from EPIC 110, per the epic's Decisions; Story 2
(`02-the-attempt-row`) states the same reason for `attemptRow.caller`. `subject` is not typed
`workerId` at the seam because `src/services/execution/index.ts:14` — `worker` on `RunRecord` is
already a plain `string`, and one of the two would have to lie.

### 2 — `src/services/execution/sqlite.ts` — the insert writes both

**Rewrite the statement at `src/services/execution/sqlite.ts:271`** — `transaction.run`:

```ts
transaction.run(
  `INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at, termination, caller, subject)
VALUES (?, ?, 'external', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  [id, input.runId, accounting.nextAttemptNo, input.caller, input.subject],
);
```

`termination` is named with an explicit `NULL`, matching the six columns already spelled that way, so
the column list states the whole row rather than relying on defaulting. `driver` stays the hardcoded
`'external'`, and the returned literal at
`src/services/execution/sqlite.ts:276` — the record does not change.

**No refusal is added.** An empty `caller` or an empty `subject` is not refused here: migration `16`
adds no CHECK on either column, and EPIC 057 is the epic that makes them `NOT NULL`. A guard in the
service would be a refusal the database does not state and no case could reach through `claimNode`.

### 3 — `src/commands/node/claim-node.ts` — the derivation

**Rewrite the call at `src/commands/node/claim-node.ts:401`** — `attempt`:

```ts
const attempt = dependencies.execution.openAttempt(transaction, {
  runId: run.id,
  caller: input.actorId,
  subject: run.worker,
});
```

**The call is unconditional, and it was unconditional before this story.** EPIC 050.4 Story 2
(`02-the-claim-of-an-initiative-drops-the-lease`) removed the `runKind === "execution"` arm, because
`checkpoint.attempt_id` is `NOT NULL` for a structural and a review checkpoint alike. This story adds
two fields to that one call and re-introduces no branch on the run kind.

**`caller` is `input.actorId` and comes from the middleware, never from a body.**
`src/http/server/node/claim-node.ts:31` — `actorId: context.actor.id` is the one producer, and
`src/http/server/app.ts:36` — `actor: ActorRow` is set by
`src/http/server/auth.ts:31` — the bearer resolution. No new input member and no new dependency key is
added to `ClaimNodeDependencies`.

**`subject` is `run.worker` and not `routedWorker`.** The two hold the same value on this line —
`src/commands/node/claim-node.ts:391` — `worker: routedWorker` is what `openRun` was given — and the
epic's Decisions say the subject is read from the run row. Reading it off `run` is what keeps the
attempt's subject equal to the run's worker by construction, so a later epic that changes how the run
records its worker cannot leave the two disagreeing.

**Do not read `caller.worker`.** `src/commands/node/claim-node.ts:191` — `caller` is a local binding
for `src/commands/node/claim-node.ts:82` — `ClaimCallerRecord`, which is the **claiming worker**, not
the authenticated principal. The two names collide and the values are different things:
`docs/workflow/worker.md:489` — `Authorization and attribution are separate` is the sentence this
derivation implements.

### 4 — `test/helpers/execution.ts` — mirror the insert

**Rewrite the statement at `test/helpers/execution.ts:424`** — the `openAttempt` INSERT of
`createBackedExecutionFake`, taking the same column list and the same two bound parameters.
`test/helpers/execution.ts:217` — `Mirrors the statements of` states
the obligation. The unimplemented `openAttempt` of `createExecutionFake` at
`test/helpers/execution.ts:93` still calls `unexpected("openAttempt")` and does not change.

### 5 — every test call site of `openAttempt` takes the two fields

`OpenAttemptInput` becomes a three-member object, so `pnpm run build` names each site. They are
`src/services/execution/sqlite.test.ts:361`, `:371`, `:404` and `:423`,
`src/commands/node/claim-node.test.ts:2267`, and every site Story 3
(`03-the-close-writes-the-termination`) added. Pass the file's own actor and worker fixtures —
`src/commands/node/claim-node.test.ts` holds `ACTOR_A`, and
`src/services/execution/sqlite.test.ts:132` — `objectiveRunInput` holds the `worker` value its runs
carry. **Do not introduce a shared default**: a helper that filled both fields would let a site that
should assert the derivation assert the helper instead.

**The build proves every site names both keys and no more than that.** A missed site fails `tsc`, and
every story of this epic ends on `pnpm run verify` exits 0, which runs the build — but a site that
passed two unrelated constants would compile. That is acceptable for the four
`src/services/execution/sqlite.test.ts` sites, whose subject is attempt numbering and not attribution.
It is **not** acceptable for `src/commands/node/claim-node.test.ts:2267`, which is why case 4 asserts
the values that call passed against the stored row.

## Constraints

- `ClaimNodeInput` and `ClaimNodeDependencies` do not change. The derivation reads two values already
  in scope.
- `AttemptRecord`, `ATTEMPT_COLUMNS` and `toAttemptRecord` do not gain `caller` or `subject`.
- `src/http/contract/execution.ts:37` — `nodeClaimRequest` and
  `src/http/contract/outcome.ts:23` — `nodeReportRequest` do not change. Every member of the report
  union is a `z.strictObject`, and that is what refuses a supplied `termination` or `caller`; adding a
  key to reject one explicitly would declare the field it means to forbid.
- The insert writes `driver` as the literal `'external'`. `claimNode` opens no internal run, and
  `src/services/execution/sqlite.test.ts:742` — `an external attempt under an internal run is refused`
  is the shipped case that pins it.

## Verify

```
node --test src/commands/node/claim-node.test.ts src/services/execution/sqlite.test.ts src/http/server/node/report-node.test.ts src/http/server/node/claim-node.test.ts
```

Extend `src/commands/node/claim-node.test.ts`, whose suite is at
`src/commands/node/claim-node.test.ts:677` — `describe`, whose fixture is
`src/commands/node/claim-node.test.ts:100` — `createClaimFixture` and whose driver is
`src/commands/node/claim-node.test.ts:228` — `claim`. `claim` already accepts `callerWorker` and
`authorizedWorkers`, so a second worker needs no new plumbing. Extend
`src/http/server/node/report-node.test.ts` for the transport cases, in the idiom of
`src/http/server/node/claim-node.test.ts:332` — `node.claim with any body member is 400 invalid-request`.

Add, each as a separate `it`:

1. `"a claim stores the caller as the authenticated actor and the subject as the run worker"` — run
   `claim` with `actorId: ACTOR_A` and `callerWorker: "claude@1"`, then read
   `SELECT caller, subject FROM attempt WHERE id = ?` for `result.attemptId` and assert `caller` is
   `ACTOR_A` and `subject` is `"claude@1"`, both by value. Then read
   `SELECT worker FROM run WHERE id = ?` and assert it equals the stored `subject`, so the case
   asserts the derivation and not a coincidence of two fixtures. This is the epic's gate row 9.

2. `"a second claim by a different actor on a different worker stores that pair"` — a second fixture,
   `actorId: ACTOR_B` and `callerWorker: "codex@1"` with `authorizedWorkers: ["codex@1"]`, asserting
   `caller` is `ACTOR_B` and `subject` is `"codex@1"`. This is the control for case 1: two cases with
   four assertions between them, and a hardcoded constant in the insert fails the second. **The epic's gate row 9 now names this pair, and the amendment is applied.** Its earlier wording
   asked for "an internal and an external run"; that pair is unreachable — `claimNode`
   opens external runs only, `src/services/execution/sqlite.ts:273` — `'external'` is hardcoded in the
   insert, and `src/services/execution/sqlite.test.ts:742` — `an external attempt under an internal run is refused` proves the composite foreign key refuses the other. Two distinct
   `(actor, worker)` pairs is the pair with content, and it delivers the row's four assertions. This
   is the epic's gate row 9.

3. `"a claim on a structural node opens one attempt carrying caller and subject"` — claim a node
   whose `runKind` is not `execution`, assert `SELECT COUNT(*) FROM attempt WHERE run_id = ?` is `1`,
   and assert that row's `caller` and `subject` by value. EPIC 050.4 Story 2
   (`02-the-claim-of-an-initiative-drops-the-lease`) made the open unconditional, so this is the
   control that the derivation is not gated on the run kind and that no claim path stores a null pair.

4. `"the re-claim case passes the derived pair through the fake"` — update
   `src/commands/node/claim-node.test.ts:2222` — `a re-claim on the same run numbers the next attempt 2`, whose direct `openAttempt` call at `:2267` now names `caller` and `subject`, and add an
   assertion that the second attempt's stored `caller` and `subject` equal the values that call
   passed. This is what proves `createBackedExecutionFake` mirrors the production insert rather than
   dropping two bound parameters.

5. `"a node.report body carrying termination is refused by the strict schema over the real route"` —
   build the app as `src/http/server/node/report-node.test.ts` already does, `POST` a complete
   `report: "failed"` body plus `termination: "infrastructure"`, and assert `response.status` is
   `400` and `response.body.error.code` is `"invalid-request"`. The control is the same body without
   that key, which must not be `400`. A type-level test does not stand in for this. This is the epic's
   gate row 10.

6. `"a node.report body carrying caller is refused by the strict schema over the real route"` — the
   same shape with `caller: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS"`, asserting `400` and
   `"invalid-request"`. A second sub-case posts `subject: "claude@1"` and asserts the same. This is
   what states the epic's trust boundary as behaviour: the daemon constructs the attribution, and the
   wire refuses to carry it. This is the epic's gate row 10.

7. `"a node.claim body carrying caller is refused over the real route"` — extend
   `src/http/server/node/claim-node.test.ts:332` — `node.claim with any body member is 400 invalid-request` with `{ caller: ACTOR }` and `{ termination: "semantic" }` in its iterated body
   list. `src/http/contract/execution.ts:37` — `nodeClaimRequest` is a `z.strictObject` holding
   `available` alone, and this is the claim-side pair to cases 5 and 6.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/node/claim-node.test.ts` in `PASS EPIC-054`.
