# Story 9 — The contract, the CLI and the proposal

Epic: `.agents/plan/epics/053.1-the-review-checkpoint.md`
Depends on: Story 8 (`08-the-attestation-with-no-reason`), for the settled refusal set and the exact
details object every 409 schema must parse; Story 3 (`03-an-oversized-reason-reaches-no-seam`), for
the byte cap this story declares no character cap for; EPIC 051.4 Story 9
(`09-the-contract-and-the-proposal`), for `docs/proposal/phase-2/checkpoints.md`; EPIC 052.2 Story 1
(`01-the-contract-carries-the-patch`), for the seventh `nodeReportRequest` member this story appends
after.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**It dispatches before the route, and that inverts the epic's story list.** Story 10
(`10-the-report-route-carries-a-verdict`) needs this member and these five codes for its
end-to-end route case, and it must dispatch last because it appends `shippedEpics`. EPIC 052.2
ordered the same pair the same way, and stated the reason at
`.agents/plan/stories/052.2-the-structural-report-route/01-the-contract-carries-the-patch.md:17` —
`route`: a `nodeReportRequest` member declared without the handler that serves it puts a request
shape in `pnpm run contract:publish` that the daemon answers with an undeclared substitute. The two
stories are one epic for that reason, and this one lands first.

**Five codes join the contract, not six.** `judged-checkpoint-unaccepted` is not added. See Story 3
(`03-an-oversized-reason-reaches-no-seam`) section 2.

## Change

### 1 — `src/http/contract/outcome.ts` — the eighth `nodeReportRequest` member

**Edit `src/http/contract/outcome.ts`.** Add a member to `src/http/contract/outcome.ts:23` —
`nodeReportRequest`, at the end of the union,
after the `structural` member EPIC 052.2 Story 1 (`01-the-contract-carries-the-patch`) adds:

```ts
z.strictObject({
  report: z.literal("review"),
  runId: identity("run"),
  runFence: z.int().min(1),
  verdict: z.enum(["accept", "reject"]),
  judgedCheckpointId: identity("checkpoint"),
  reason: z.string().min(1).optional(),
}),
```

**It carries `runId` and `runFence`, and no `fence`.** EPIC 050.2 Story 7
(`07-the-worker-contract`) makes `runId` and `runFence` required on **all** members —
`nodeReportRequest` is a `z.discriminatedUnion`, so there is no shared base and each member declares
them — and EPIC 050.4 Story 6 (`06-the-report-drops-the-lease`) deletes the lease `fence` from five
members. A member carrying `fence` would reintroduce a field that epic removed.

**`judgedCheckpointId` is `identity("checkpoint")`, not `z.string()`.** EPIC 051.3 Story 2
(`02-the-checkpoint-row`) adds `"checkpoint"` to `src/domain/identity.ts:3` — `identityKinds`, and
`src/domain/identity.ts:49` — `ulidPattern` then requires a prefixed 26-character ULID. A bare
string would admit an id no `checkpoint` row can carry.

**It carries no `objectId` and no `repositoryId`.** `docs/workflow/worker.md:562` — `candidate`
states a review node reports an attestation and pushes no candidate, so there is no object to name.
The `strictObject` is what refuses one.

**`reason` declares no `.max()`, and that diverges from the four shipped `reason` fields** at
`src/http/contract/outcome.ts:32` — `reason`, `src/http/contract/outcome.ts:37` — `reason` and
`src/http/contract/outcome.ts:42` — `reason`, which each carry `.max(2000)`. A zod `.max()`
counts characters, and the cap is 65536 **bytes**, measured in the command by Story 3
(`03-an-oversized-reason-reaches-no-seam`). A character cap would refuse a valid 65000-byte ASCII
body and admit a 200000-byte multi-byte one.

**Append the member last, so no `oneOf` index moves.**
`src/http/contract/field-decisions.fixture.ts` keys each row by `oneOf/<n>`, and inserting a member
anywhere but the end renumbers every later one.

The discriminator is `"review"`, matching the run kind at `src/domain/run-kind.ts:3` — `runKinds` and
the checkpoint kind.

**Edit `src/commands/outcome/report-outcome.ts`.** Add the matching arm to
`src/commands/outcome/report-outcome.ts:25` — `NodeReportRequest`:

```ts
| Readonly<{
    report: "review";
    runId: string;
    runFence: number;
    verdict: "accept" | "reject";
    judgedCheckpointId: string;
    reason?: string;
  }>
```

### 2 — `src/http/contract/errors.ts` — five codes

**Edit `src/http/contract/errors.ts`.** Add five keys to `src/http/contract/errors.ts:7` —
`errorStatuses`. The four 409 codes go
directly after `src/http/contract/errors.ts:29` — `subtree-busy`, which closes the contiguous 409 run,
and `reason-too-large` goes directly after `src/http/contract/errors.ts:8` — `invalid-request`, the
sole 400 entry:

| code                              | status | position                |
| --------------------------------- | ------ | ----------------------- |
| `reason-too-large`                | 400    | after `invalid-request` |
| `judged-checkpoint-unknown`       | 409    | after `subtree-busy`    |
| `judged-checkpoint-not-execution` | 409    | after `subtree-busy`    |
| `judged-checkpoint-undeclared`    | 409    | after `subtree-busy`    |
| `judged-checkpoint-superseded`    | 409    | after `subtree-busy`    |

**Do not cross the 422 boundary.** `src/http/contract/errors.test.ts:75` — `rejects` stages a code
moved into the 422 group and requires the ordering assertion to refuse it.

Each of the four 409 codes joins `PreconditionCode` at `src/http/contract/errors.ts:41` —
`PreconditionCode` by construction, so `httpError` demands a `details` argument for it. That is the
intent: each names a specific judged checkpoint, and a refusal that does not say which is unusable.

The count moves from 37 to 42: 29 shipped plus the eight of EPIC 052.2 Story 1
(`01-the-contract-carries-the-patch`), plus these five. `src/http/contract/errors.test.ts:41` — `pins` holds the ordered
literal and `src/http/contract/errors.test.ts:113` — `groups` holds the status grouping; both take
the five new entries in the same positions. Every name satisfies the kebab-case gate at
`src/http/contract/errors.test.ts:206` — `kebab-case`.

### 3 — `docs/proposal/api/README.md` — five matrix rows

The table is read by `test/helpers/proposal.ts:89` — `readErrorCodeMatrix`, which takes every
three-cell row whose first cell is an integer between 400 and 599, and
`src/http/contract/errors.test.ts:17` — `matches` deep-equals its key set against `errorStatuses`.
**A code added to `errors.ts` and not here is a red `pnpm run verify`.**

**Edit `docs/proposal/api/README.md`.** Insert one row after
`docs/proposal/api/README.md:245` — `invalid-request` and four after
`docs/proposal/api/README.md:266` — `subtree-busy`, each with its meaning:

- `reason-too-large` — the review reason exceeds 65536 UTF-8 bytes
- `judged-checkpoint-unknown` — the named judged checkpoint does not exist
- `judged-checkpoint-not-execution` — the named judged checkpoint is not an execution checkpoint
- `judged-checkpoint-undeclared` — the review node does not depend on the judged checkpoint's node
- `judged-checkpoint-superseded` — a newer execution checkpoint of that node supersedes the named one

### 4 — `src/cli/exit-code.ts` — five exit codes

**Edit `src/cli/exit-code.ts`.** Add the same five keys to `src/cli/exit-code.ts:13` —
`exitCodes`. The key set must equal
`errorStatuses`' key set, asserted bytewise at `src/cli/exit-code.test.ts:53` — `bytewise`; the order
is free, so append the five after `src/cli/exit-code.ts:39` — `subtree-busy`:

`reason-too-large` 111, `judged-checkpoint-unknown` 178, `judged-checkpoint-not-execution` 179,
`judged-checkpoint-undeclared` 180, `judged-checkpoint-superseded` 181.

**111 is the free slot beside the 400 band, and 178 continues the 409 wave.**
`src/cli/exit-code.ts:14` — `invalid-request` holds 110 and 112 to 119 are unused, so the band stays
readable. **170 to 177 are already taken**: EPIC 052.2 Story 1
(`01-the-contract-carries-the-patch`) assigns them to its eight codes, so this epic starts at 178.

`src/cli/exit-code.test.ts:17` — `expected` holds the literal map,
`src/cli/exit-code.test.ts:60` — `twenty-nine` asserts a count of 29 and carries it in the test name,
and `src/cli/exit-code.test.ts:86` — `no two codes share an exit code` asserts a set size; all three
move to **42**. The arithmetic is 29 shipped, plus the eight EPIC 052.2 Story 1
(`01-the-contract-carries-the-patch`) adds, plus these five.

**Move one shipped assertion.** `src/cli/exit-code.ts:64` — `envelopeCodeForStatus` returns a code
only when exactly one code declares that status. Adding `reason-too-large` at 400 makes 400
ambiguous, so `src/cli/exit-code.test.ts:107` — `invalid-request` must move out of the `it` at
`src/cli/exit-code.test.ts:106` — `one declared code` and into the one at `src/cli/exit-code.test.ts:115` — `more than one declared code`, as
`assert.equal(envelopeCodeForStatus(400), ENVELOPE_UNREADABLE_CODE)`. **This is a shipped behaviour
change the epic does not name**, and it is unavoidable: a status carrying two codes cannot be named
from the status alone.

### 5 — `src/http/contract/error-details.ts` and the operation's `errors` record

**Extend `src/http/contract/error-details.ts`.** Add one details schema per new code, shaped like
`src/http/contract/error-details.ts:175` — `subtreeBusyDetails`, each parsing the exact object the
command builds:

```ts
export const reasonTooLargeDetails = z.strictObject({
  bytes: z.int().min(1),
  limit: z.literal(65536),
});
export const judgedCheckpointUnknownDetails = z.strictObject({
  judgedCheckpointId: identity("checkpoint"),
});
export const judgedCheckpointNotExecutionDetails = z.strictObject({
  judgedCheckpointId: identity("checkpoint"),
  kind: z.enum(["structural", "review"]),
});
export const judgedCheckpointUndeclaredDetails = z.strictObject({
  nodeId: nodeIdentity,
  judgedNodeId: nodeIdentity,
});
export const judgedCheckpointSupersededDetails = z.strictObject({
  judgedCheckpointId: identity("checkpoint"),
  newestCheckpointId: identity("checkpoint"),
  nodeId: nodeIdentity,
});
```

**`reason-too-large` gets a schema, and it is not `null`.** Story 3
(`03-an-oversized-reason-reaches-no-seam`) raises it with `{ bytes, limit }`, so a record entry of
`null` would emit an envelope the daemon's own response fails to parse.
`src/http/contract/errors.ts:107` — `Exclude` admits optional details on a non-409 code, and
`src/http/contract/error-details.ts:116` — `invalidRequestDetails` is the shipped precedent for a 400
schema.

**`kind` is `z.enum(["structural", "review"])`, not the full `checkpointKinds`.** The refusal fires
only when the kind is not `execution`, so a schema admitting `"execution"` describes a response the
command never sends.

**`newestCheckpointId` is non-null.** Story 6 (`06-a-superseded-subject-refuses-last`) throws a plain
`Error` rather than this refusal when the read returns null, so no refusal ever carries a null there.

**Update `src/http/contract/outcome.ts`.** Add five entries to
`src/http/contract/outcome.ts:150` — `errors`: the four 409 codes and
`reason-too-large`, each with its schema. The record is what builds the operation's error
envelope, and `src/http/server/node/report-node.test.ts:24` — `reportErrorEnvelope` parses a real
refusal response against it, so an undeclared code fails Story 10
(`10-the-report-route-carries-a-verdict`) case 5.

### 6 — `src/http/contract/coverage.test.ts` — the `operationAdditions` allowlist

`src/http/contract/coverage.test.ts:520` — `only the named operations add codes` asserts that every
code an operation declares beyond `baselineErrors` appears verbatim in
`src/http/contract/coverage.test.ts:19` — `operationAdditions`. **Update
`src/http/contract/coverage.test.ts`.** Five entries join the
`"node.report"` list** at `src/http/contract/coverage.test.ts:63` — `node.report`: the four
`judged-checkpoint-*` codes. `reason-too-large` is a 400 code and `"invalid-request"` is already a
baseline entry, so `reason-too-large` still needs its own row — add all five, sorted. The assertion is a
`deepEqual` over a sorted array, so an addition made in `outcome.ts` and not here fails, and the
reverse fails too.

### 7 — `src/http/contract/field-decisions.fixture.ts` — regenerate

**Update `src/http/contract/field-decisions.fixture.ts`.** Run
`node scripts/field-decisions-probe.mjs --write`, which rewrites the file from a fresh walk of the
registry. Never hand-edit it. The eighth union member adds four rows and no existing row moves,
because the member is appended last. There is no `package.json` script for it;
`src/http/contract/coverage.test.ts:461` — `fieldDecisions` is what polices the result.

### 8 — `docs/proposal/phase-2/checkpoints.md` — the review checkpoint

**Edit `docs/proposal/phase-2/checkpoints.md`.** Add sections to it; it is created by EPIC 051.4 Story 9
(`09-the-contract-and-the-proposal`). An implementing agent that finds no such file stops and reports
the gap rather than creating it here. One `##` section per fact, in the prose style of
`docs/proposal/phase-2/runs-and-exclusion.md:37` — `refusal order`:

1. **The attestation contract** — a review checkpoint stores `verdict`, `judged_checkpoint_id`,
   `judged_oid` and `reason_blob`; the reference is a foreign key and the oid is copied from it inside
   the same transaction, so a reader answers "which commit was judged" with no join.
2. **`depends_on` is the subject lookup** — a review node is atomic and holds no child, so its own
   subtree can never contain an execution checkpoint. A subtree lookup would be unsatisfiable, and an
   implicit lookup would let the reviewer choose its own subject.
3. **The newest-accepted rule** — the named checkpoint must be the newest execution checkpoint of its
   own node. Naming it at report time would otherwise let a reviewer choose an older checkpoint after
   a re-run.
4. **The four judged refusals and the fixed refusal order** — the ordered list
   `body-kind-mismatch`, `reason-too-large`, `judged-checkpoint-unknown`,
   `judged-checkpoint-not-execution`, `judged-checkpoint-undeclared`,
   `judged-checkpoint-superseded`, with the sentence that a report failing two conditions reports the
   earlier one, and that a refusal writes nothing.
5. **The byte cap and its unit** — 65536 UTF-8 bytes, measured on the encoded body, because the blob
   store hashes bytes and a character cap and a byte cap disagree on every multi-byte body.
6. **The admitted review claim and its empty base** — a review claim opens a `review` run that holds
   no `run_base` row, cuts no candidate ref and pins no judged oid.
7. **The verdict semantics** — the node reaches `done` for `accept` and for `reject` alike, no code
   reads the verdict to decide a state, and the verdict changes no other node's state.
8. **Trust, and undetected reviewer mutation** — `docs/workflow/worker.md:729` — `Trusted` places
   the verdict and "that the reviewer mutated nothing" under Trusted, and
   `docs/workflow/worker.md:735` — `mutation` states the daemon detects no reviewer mutation at a
   review checkpoint. State both sentences and derive neither from the other.

**Edit `docs/proposal/phase-2/runs-and-exclusion.md`.** Supersede the shipped paragraph that
contradicts section 6.
`docs/proposal/phase-2/runs-and-exclusion.md:58` — `review-head-unavailable` states a review claim is
refused until the workspace exists, and `docs/proposal/phase-2/runs-and-exclusion.md:46` —
`review-head-unavailable` lists it in the claim's refusal order. **Replace the paragraph** with the
admitted claim and its reason, and **remove the entry** from the ordered list, leaving eleven codes.
Do not delete the code from either register; Story 2 (`02-a-review-claim-is-admitted`) case 6 pins
that it stays.

**Add `src/http/contract/proposal-amendment-checkpoints-review.test.ts`**, following the convention of
`src/http/contract/proposal-amendment-outcome.test.ts`: `squash` the document to single-spaced text
and assert one verbatim sentence per fact, plus `indexOf` comparisons for section order and negative
`!includes` assertions for the superseded paragraph.

## Constraints

- The five codes join `src/http/contract/errors.ts`, `src/cli/exit-code.ts` and
  `docs/proposal/api/README.md` in one change, and the five record entries join
  `src/http/contract/outcome.ts` and `operationAdditions` in one change. Any one of the five edited
  alone is a red `pnpm run verify`.
- The `review` member carries no `objectId` and no `repositoryId`. The `strictObject` refuses either.
- `reason` carries `.min(1)` and no `.max()`. The byte cap lives in the command.
- `field-decisions.fixture.ts` is generated. A hand edit is a defect.
- Every 409 details schema is a `strictObject`, and each parses the exact object Stories 4 to 6 build.
  A schema looser than the command describes a response the daemon never sends.
- Do not touch `docs/proposal/phase-2/worker.md`. It does not exist; the product document is
  `docs/workflow/worker.md`, in the superproject, and this epic amends no file outside this
  repository.

## Verify

```
node --test src/http/contract/outcome.test.ts src/http/contract/errors.test.ts src/http/contract/coverage.test.ts src/http/contract/error-details.test.ts src/cli/exit-code.test.ts src/http/contract/proposal-amendment-checkpoints-review.test.ts
```

Extend `src/http/contract/outcome.test.ts`, whose suite is at
`src/http/contract/outcome.test.ts:21` — `describe` and whose member enumeration is the shared array
at `src/http/contract/outcome.test.ts:11` — `validBodies`.

Add, each as a separate `it`:

1. `"nodeReportRequest parses each of the eight members"` — add two entries to
   `src/http/contract/outcome.test.ts:11` — `validBodies`, one `review` member with a `reason` and one
   without, and rename the `it` at `src/http/contract/outcome.test.ts:22` — `six report kinds` to "eight". The array also
   feeds the strict-object sweep at `src/http/contract/outcome.test.ts:55` — `owner key`, which widens for free.
   This is the epic's gate row 20.

2. `"a review member missing judgedCheckpointId is refused by value"` — `safeParse` of a body
   carrying `report`, `runId`, `runFence` and `verdict` returns `success: false`, and the issue path
   is `["judgedCheckpointId"]`. This is the epic's gate row 20.

3. `"a review member missing runId or runFence is refused by value"` — two sub-cases, each omitting
   one field and asserting the issue path is `["runId"]` or `["runFence"]`. EPIC 050.2 Story 7
   (`07-the-worker-contract`) case 4 asserts this for the six shipped members; the eighth joins them.

4. `"a review member carrying a lease fence is refused by the strict object"` — a complete body plus
   `fence: 1`, asserting `success: false`. EPIC 050.4 Story 6 (`06-the-report-drops-the-lease`)
   removed that field, and this is what stops it returning through a new member.

5. `"a review member carrying objectId is refused by the strict object"` — a complete body plus
   `objectId`, asserting `success: false`. `docs/workflow/worker.md:562` — `candidate` states a
   review node pushes no candidate, so there is no object to name. This is the epic's gate row 20.

6. `"a verdict outside the two values is refused by value"` — `verdict` of `"maybe"`, asserting
   `success: false` and the issue path `["verdict"]`. A second sub-case passes a
   `judgedCheckpointId` of `"checkpoint_a"` and asserts `success: false`, because
   `src/domain/identity.ts:49` — `ulidPattern` requires a 26-character Crockford suffix. This is the
   epic's gate row 20.

7. `"a review member accepts a reason of any length at the wire"` — a reason of `"a".repeat(200000)`
   parses. This is what makes `reason-too-large` reachable from the command rather than from the
   schema, and it is the pair to Story 3 (`03-an-oversized-reason-reaches-no-seam`) case 2.

8. `"the error table holds forty-two codes in the pinned order"` — update
   `src/http/contract/errors.test.ts:41` — `pins` and assert the ordered literal, then update
   `src/http/contract/errors.test.ts:113` — `groups` and assert the status grouping. The mutation test
   at `src/http/contract/errors.test.ts:75` — `rejects` already proves the ordering assertion fires.

9. `"every judged refusal code maps to 409"` — a `judgedRefusals` tuple of the four codes, iterated
   and asserted against `errorStatuses`, in the idiom of
   `src/http/contract/errors.test.ts:156` — `claimRefusals`.

10. `"every exit code is unique across forty-two codes"` — update
    `src/cli/exit-code.test.ts:17` — `expected` and the count at
    `src/cli/exit-code.test.ts:60` — `twenty-nine`, and assert the set size is 42.

11. `"a status carrying two declared codes names neither"` — move
    `src/cli/exit-code.test.ts:107` — `invalid-request` into the `it` at
    `src/cli/exit-code.test.ts:115` — `more than one declared code` and assert `envelopeCodeForStatus(400)` is
    `ENVELOPE_UNREADABLE_CODE`. The control is 401, which still names `unauthenticated`.

12. `"node.report declares every code its handler raises"` — update the `"node.report"` entry of
    `src/http/contract/coverage.test.ts:19` — `operationAdditions` and assert it **deep-equals a
    stated sorted literal** holding the shipped three, the nine EPIC 052.2 Story 1
    (`01-the-contract-carries-the-patch`) adds and these five, by value. The control is one code
    added to `src/http/contract/outcome.ts` and not to the allowlist, which
    `src/http/contract/coverage.test.ts:520` — `only the named operations add codes` must reject.

13. `"the field decisions fixture equals a fresh walk"` — `node scripts/field-decisions-probe.mjs`
    without `--write` exits 0 and prints `fixture in sync`.

14. `"every new details schema parses the object the command builds"` — five sub-cases, one per
    schema including `reasonTooLargeDetails`, each parsing a literal copied from the refusal Stories
    3 to 6 raise, asserted value by value and not by shape. The control is one object carrying an
    extra key, which `strictObject` must refuse, plus one
    `judgedCheckpointNotExecutionDetails` object whose `kind` is `"execution"`, which the narrowed
    enum must refuse. Extend `src/http/contract/error-details.test.ts`.

15. `"every new code is a key of all three registers"` — iterate the declared tuple of the five new
    codes and assert each is a key of `src/http/contract/errors.ts:7` — `errorStatuses`, a key of
    `src/cli/exit-code.ts:13` — `exitCodes`, and a row of the `docs/proposal/api/README.md` matrix
    that `test/helpers/proposal.ts:89` — `readErrorCodeMatrix` returns. Iterating the tuple is what
    makes a code added to one register and not the others fail. A code absent from either file fails,
    which is the control. This is the epic's gate row 21.

16. `"judged-checkpoint-unaccepted is absent from every register"` — assert the string appears in
    neither `errorStatuses`, `exitCodes` nor the proposal matrix. The condition it names cannot arise,
    and this is the case that keeps it from being added back.

17. `"checkpoints.md states the review attestation contract"` — eight `assert.ok(doc.includes(...))`
    calls, one per sentence, each sentence written verbatim here and copied into the document
    unchanged:
    1. `"A review checkpoint stores the checkpoint it judged and a copy of that checkpoint's accepted oid, so a reader answers which commit was judged with no join."`
    2. `"A review node is atomic, so its own subtree can never contain an execution checkpoint, and depends_on is what connects a verdict to its subject."`
    3. `"The daemon refuses a judged checkpoint that is not the newest execution checkpoint of its own node."`
    4. `"A report that fails two conditions reports the earlier one, and a refusal writes nothing."`
    5. `"The reason cap is 65536 UTF-8 bytes, measured on the encoded body, because the blob store hashes bytes."`
    6. `"A review claim opens a review run that holds no run_base row, cuts no candidate ref and pins no judged oid."`
    7. `"A review node reaches done for accept and for reject alike, and the verdict changes no other node's state."`
    8. `"The daemon detects no reviewer mutation at a review checkpoint, and the verdict is trusted."`
       Plus `assert.ok(!runsAndExclusion.includes("A review run records the commit it judges at claim time"))`
       for the superseded paragraph. Add
       `src/http/contract/proposal-amendment-checkpoints-review.test.ts`.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/outcome.test.ts`,
`src/http/contract/errors.test.ts` and `src/cli/exit-code.test.ts` in `PASS EPIC-053.1`.
