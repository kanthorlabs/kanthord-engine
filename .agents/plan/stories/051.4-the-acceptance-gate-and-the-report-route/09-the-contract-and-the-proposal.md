# Story 9 — The contract and the proposal

Epic: `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md`
Depends on: nothing of this epic. It dispatches **before** Story 8
(`08-the-report-route-enforces-the-gate`), which reads every code and field it adds.
Kind: story-foundation

## Change

**The contract moves before its reader, and that is a sequencing rule.** `httpError` at
`src/http/contract/errors.ts:111` — `httpError` takes an `ErrorCode`, and `ErrorCode` is the key set
of `src/http/contract/errors.ts:7` — `errorStatuses`, so
`src/http/server/node/refusals.ts:67` — `reportOutcomeRefusal` cannot name a code this story has not
added. `repositoryId` is the mirror case: the handler passes
`src/http/server/node/report-node.ts:36` — `parsed` straight to the command, so the schema and the
command's body union must gain the field in one story or `pnpm run typecheck` fails between them.

### 1 — `repositoryId` on the wire

`src/http/contract/outcome.ts:24` — `z` is the `accepted` member of `nodeReportRequest`. Add
`repositoryId: identity("repository")` after
`src/http/contract/outcome.ts:27` — `objectId`, importing `identity` from `../../domain/identity.ts`
beside the existing `src/http/contract/outcome.ts:3` — `objectId` import. Only the `accepted` member
gains it; the other five are unchanged.

Add the same field to `src/commands/outcome/report-outcome.ts:26` — `accepted`, as
`repositoryId: string`. Nothing reads it until Story 8.

Add `repositoryId` to the example request at
`src/http/contract/outcome.ts:75` — `request`, beside a new
`REPORT_REPOSITORY_ID` constant declared next to
`src/http/contract/outcome.ts:72` — `REPORT_OBJECT_ID`.

**The `/v1` policy needs no edit.** `docs/proposal/api/README.md:98` — `required` already permits a
required request field, and `docs/proposal/api/README.md:110` — `moved` records the human ruling of
2026-09-03 that put it there and the condition under which it returns. This story adds the field under
a permission that exists, so it retires no capability and moves no version.

### 2 — the six refusal codes, in four tables that must agree

`src/http/contract/errors.ts:7` — `errorStatuses` gains six entries at `409`, inserted after
`src/http/contract/errors.ts:29` — `subtree-busy`, the last 409 today, in this order:
`candidate-unreachable`, `multi-repository-unsupported`, `ancestry-broken`, `path-undeclared`,
`command-failed`, `contended`.

**All six are 409, and each carries details.**
`src/http/contract/errors.ts:41` — `PreconditionCode` makes a `details` argument mandatory for a 409,
and every one of the six holds a value the worker needs — the ref and the reported oid, the two
repository ids, the base and the head, the sorted undeclared paths, the command index and string, and
the expected and observed oids. Each is a conflict with recorded state, which is what the 409 band
means at `docs/proposal/api/README.md:251` — `stale-revision` through
`docs/proposal/api/README.md:266` — `subtree-busy`.

`src/cli/exit-code.ts:13` — `exitCodes` gains the same six at `170` to `175`, inserted after
`src/cli/exit-code.ts:39` — `subtree-busy`. The 409 band `150` to `169` is full, so the six open a new
range; every value stays an integer in `1..255`, distinct, and never `0`.

`docs/proposal/api/README.md:243` — `Status` is the matrix
`test/helpers/proposal.ts:89` — `readErrorCodeMatrix` parses and
`src/http/contract/errors.test.ts:17` — `matches the proposal code table` compares against. Add one row per code in the
409 group, after `docs/proposal/api/README.md:266` — `subtree-busy`.

`src/http/contract/outcome.ts:150` — `errors` gains all six, each mapped to a details schema declared
beside `src/http/contract/error-details.ts:48` — `illegalTransitionDetails`, in the shape
`src/http/contract/outcome.ts:153` — `illegal-transition` uses. The six schemas, by name and members:
`candidateUnreachableDetails` (`ref`, `reported`), `multiRepositoryDetails` (`reported`,
`base: z.array(...)`), `ancestryBrokenDetails` (`base`, `head`), `pathUndeclaredDetails`
(`undeclared: z.array(...)`), `commandFailedDetails` (`commandIndex`, `command`) and
`contendedDetails` (`expected`, `observed`). Each member set is the `details` its throw site builds in
Stories 2 to 6, so the schema and the producer are written from one list. Then
`src/http/contract/coverage.test.ts:63` — `node.report` gains all six to its `operationAdditions`
entry, sorted, because `src/http/contract/coverage.test.ts:520` compares the non-baseline extras by
sorted value.

### 3 — the pinned lists that count

`src/http/contract/errors.test.ts:42` — the ordered 29-key pin becomes 35, in table order.
`src/http/contract/errors.test.ts:113` — the per-status group gains the six under `409`.
`src/cli/exit-code.test.ts:17` — the `expected` mirror gains the six, and the two hard-coded counts at
`src/cli/exit-code.test.ts:67` — `36` and `src/cli/exit-code.test.ts:93` — `36` become `42`.

### 4 — the CLI

`src/cli/node/report.ts:49` — `--object-id` is the model. Add `--repository-id <id>`, required for
`accepted` and forbidden for every other outcome, with its refusal written through
`src/cli/node/report.ts:57` — `refuse`, and add it to the accepted body at
`src/cli/node/report.ts:114` — `objectId`. Without it the CLI cannot send a valid accepted report, and
`src/cli/node/report.test.ts:335` — `nodeReportRequest` re-parses every sent body.

### 5 — the derived fixture

Regenerate with `node scripts/field-decisions-probe.mjs --write`. It gains exactly one line,
`"node.report.request#/oneOf/0/properties/repositoryId required=true nullable=false enum=-"`, sorted
after `src/http/contract/field-decisions.fixture.ts:210` — `accepted`, and no other line moves: only
inserting a union **member** renumbers the `oneOf/<n>` index, and this adds a field to member `0`. Do
not hand-edit the file, and do not create `scripts/derive-field-decisions.mjs` —
`src/http/contract/coverage.test.ts:464` asserts it does not exist.

### 6 — `docs/proposal/phase-2/checkpoints.md`

A new document stating eleven facts, each in its own `##` section:

1. **The candidate ref contract** — a worker pushes to `refs/kanthord/candidate/<runId>/<attemptNo>`,
   that ref is the pin, and a report naming an oid it does not reach is refused.
2. **The checkpoint schema** — the enumerated columns of the `checkpoint` table, its three CHECK
   groups and its composite attempt foreign key.
3. **The ordered acceptance gate** — reachability, repository cardinality, ancestry, declared paths,
   commands, land, and the first failure names itself.
4. **The three compare-and-swap fields** — `ref` is the objective branch, `expected` is the run's
   recorded base for that repository, `next` is the pinned and verified head.
5. **The contention lifecycle** — a failed swap discards the candidate, cancels the attempt, ends the
   run, raises the fence, returns the node to `ready`, and consumes no attempt.
6. **The per-command immutable checkout** — one fresh checkout per declared command, and the directory
   removed after it.
7. **The exact-path rule** — a `verify.paths` entry matches a changed path bytewise and is not a
   directory prefix, and both sides of a rename must be declared.
8. **The empty-`paths` rule** — an execution node whose `verify.paths` is empty refuses a non-empty
   diff and passes an empty one, and that is not symmetric with the empty `commands` list.
9. **The workspace head advance** — a successful land advances `workspace_branch.head_oid` in the same
   transaction as the checkpoint.
10. **The journal recovery rule** — a crash between the ref move and the transaction leaves an `open`
    `merge` row, and startup completes or discards it.
11. **The candidate sweep** — the daemon lists the namespace and deletes every ref whose run is not
    `active`, at startup and after each expiry pass.

**Add its row to `docs/proposal/phase-2/README.md:19` — `File`.**
`test/helpers/proposal.test.ts:71` — `it` reads the directory and deep-equals it against the links in
that table, so creating the document without the row turns a shipped test red.

Add `src/http/contract/proposal-amendment-checkpoints.test.ts`, following the convention of
`src/http/contract/proposal-amendment-outcome.test.ts`. **It is not in the epic's Proof block**, and
`index.md` records that as an epic amendment.

### 7 — `scripts/epic-sequence-range.ts`

**Amended: the whole authored range is already applied.** `scripts/epic-sequence-range.ts:1` — `authoredEpics` holds every id of the family, and `test/sequence/conformance.test.ts:255` — `assert.deepEqual` pins the matching literal. A human applied the range whole rather than one id per epic, and `scripts/verify-epic-sequence.test.ts:880` — `the real plan tree passes the range gate` is green over it. `"050.6"`, `"051"`, `"051.1"`, `"051.2"`, `"051.3"` and `"051.4"` are all present,
so `test/sequence/conformance.test.ts:38` — `authoredLiveDiagrams` discovers every diagram of this
epic and the epic's gate row 22 asserts over them. **This story appends nothing to `authoredEpics`:
verify the entries and report a divergence rather than re-applying.** `shippedEpics` is a separate
list and is unchanged by that application, so append `"051.4"` to it as far as this epic, and update
the pin at `test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics` to
match.

## Constraints

- Dispatch this story before Story 8. Every code and field it adds is what Story 8 compiles against.
- The six codes get no producer in this story. They are declared, mapped and pinned, and
  `src/http/server/node/refusals.ts` stays untouched until Story 8.
- Add `repositoryId` to the `accepted` member only. Adding it to a second member renumbers the
  `oneOf/<n>` index of the derived fixture.
- Change no `/v1` policy text. The permission is already in the tree.
- Do not touch `src/http/contract/capability.ts`. This change is inside the closed list, so no
  capability retires and `KANTHORD_VERSION` does not move.
- Regenerate the fixture with the probe script. Hand-editing it is what
  `src/http/contract/coverage.test.ts:365` catches.

## Verify

```
node --test src/http/contract/outcome.test.ts src/http/contract/errors.test.ts src/http/contract/coverage.test.ts src/http/contract/parity.test.ts src/http/contract/schema-reachability.test.ts src/http/contract/capability.test.ts src/http/contract/proposal-amendment-checkpoints.test.ts src/cli/exit-code.test.ts src/cli/node/report.test.ts test/helpers/proposal.test.ts
```

Add, each as a separate case:

1. `"nodeReportRequest's accepted member requires repositoryId"` — assert the member's key set
   deep-equals the one pinned literal `["report", "fence", "objectId", "repositoryId"]`, and assert a
   body omitting `repositoryId` fails `safeParse`.

2. `"the six refusal codes are present in errorStatuses and in exitCodes"` — one case asserting both
   key sets contain all six, and asserting `Object.keys(errorStatuses).length === 35` and
   `Object.keys(exitCodes).length === 35`.

3. `"node.report declares the six refusal codes with their details schemas"` — assert the operation's
   `errors` record by key set, and assert each of the six maps to a non-null schema whose key set
   deep-equals the members listed in change step 2, by value. A 409 with no details is refused by
   `PreconditionCode`, and a schema that does not match its producer is the drift this case catches.

4. `"schema-reachability finds no unreachable schema"` — the shipped harness over the amended
   registry.

5. `"coverage deep-equals the regenerated field-decisions fixture"` — the shipped
   `src/http/contract/coverage.test.ts:365` harness, and assert the count of added lines is exactly
   `1`.

6. `"declaredCapabilities is unchanged by this epic"` — assert it deep-equals the literal EPIC 050.5
   leaves, by value. This is the control for the claim that the change is inside the closed list: a
   change outside it would have retired a capability, and this case fails if one did.

7. `"a node.report request omitting repositoryId is refused as invalid and the refusal names the field"`
   — over the real route, asserting the status is `400`, the code is `invalid-request`, and
   `details.issues` names `repositoryId` by value. This is the whole wire signal the epic sends.

8. `"kanthord node report requires --repository-id for accepted and forbids it otherwise"` — both
   directions in one case, asserting the exact stderr line and zero client calls, and asserting the
   sent accepted body re-parses against `nodeReportRequest`.

9. `"checkpoints.md states each of the eleven facts"` — one `assert.ok(document.includes(...))` per
   fact, plus an ordering assertion that the six gate steps appear in the gate's order.

10. `"the phase-2 file table and the phase-2 directory agree"` — the shipped
    `test/helpers/proposal.test.ts:71` case, now including `checkpoints.md`.

11. `"the conformance range names this epic"` — assert `authoredEpics` contains `"051.4"` and that
    `shippedEpics` is a prefix of `authoredEpics`. The first assertion is a **regression guard**: the
    entry is already applied, so the case asserts the state rather than a change this story makes. The
    second proves this story's own `shippedEpics` append.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/outcome.test.ts`,
`src/http/contract/errors.test.ts`, `src/http/contract/coverage.test.ts`,
`src/http/contract/parity.test.ts`, `src/http/contract/schema-reachability.test.ts`,
`src/cli/exit-code.test.ts` and `src/cli/node/report.test.ts` in `PASS EPIC-051.4`.
