# Story 04 — one named `details` schema per error code

Epic: `.agents/plan/epics/009.5-contract-schemas.md`
Depends on: Story 03.

This story authors the named `details` schemas and makes production emit them. Story 05 binds them to operations
and rebuilds the envelope. The split exists because this story changes three production files and Story 05
changes the registry and the generator.

## Decisions already ratified — implement these, do not re-open them

Three shapes were not fixed by `docs/proposal/`. The human ratified them, and they are now binding:

- **`stale-revision` carries `{expected, current}`.** Self-contained conflict evidence: the response alone
  explains the failure without the request body. This **adds `expected`** to what production emits today, so the
  EPIC's non-goal "does not add a field" is **explicitly lifted for this one payload**.
- **`binding-in-use` carries a discriminated blocker list**, `{blockers: [...]}`, with at least one blocker and a
  deterministic order.
- **`needs-reconcile` carries `{divergedLandingOid, divergedUpstreamOid}`**, both required and non-null, reusing
  the field names already in `repositoryView` (`src/http/contract/repository.ts:78-79`) and
  `systemStatusResponse` (`src/http/contract/system.ts:53-54`).

## Change

### 1. New file `src/http/contract/error-details.ts`

Every shape is anchored to the production throw site named beside it, except the three ratified above.

```ts
import { z } from "zod";

import { choices } from "../../domain/plan-choice.ts";
import { planFinding } from "./graph.ts";

const objectId = z.string().regex(/^[0-9a-f]{40}$/);

export const staleRevisionDetails = z.strictObject({
  expected: z.string().nullable(),
  current: z.string().nullable(),
});

export const needsReconcileDetails = z.strictObject({
  divergedLandingOid: objectId,
  divergedUpstreamOid: objectId,
});

export const bindingInUseDetails = z.strictObject({
  blockers: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("default-chain") }),
        z.strictObject({
          kind: z.literal("project-binding"),
          projectId: z.string().min(1),
        }),
        z.strictObject({
          kind: z.literal("repository"),
          repositoryId: z.string().min(1),
        }),
      ]),
    )
    .min(1),
});

export const idempotencyMismatchDetails = z.strictObject({
  differed: z.string(),
});

export const choicesStaleDetails = z.strictObject({
  conflicts: z.array(
    z.strictObject({ id: z.string(), suggested: z.enum(choices) }),
  ),
});

export const choicesChangedDetails = z.strictObject({
  conflicts: z.array(z.strictObject({ id: z.string(), reason: z.string() })),
});

export const planInvalidDetails = z.strictObject({
  findings: z.array(planFinding),
});

export const choicesInvalidDetails = z.strictObject({
  findings: z.array(planFinding),
});

export const hostKeyMismatchDetails = z.union([
  z.strictObject({
    presented: z.array(z.string()),
    confirmed: z.string().nullable(),
  }),
  z.strictObject({ failure: z.literal("host-key-mismatch") }),
]);

export const credentialRejectedDetails = z.strictObject({
  failure: z.enum(["auth-failed", "permission-denied"]),
});

export const invalidRequestDetails = z.strictObject({
  refusal: z.string().min(1),
  detail: z.string().optional(),
  ids: z.array(z.string()).optional(),
});
```

Anchors, for the reviewer:

- `staleRevisionDetails` — `current` from `src/commands/plan/import-plan.ts:141-145`; `expected` is new, per the
  ratified decision, and step 2 makes production emit it.
- `choicesStaleDetails` — `src/commands/plan/import-plan.ts:151-155` and `staleConflicts` at `:475-486`.
- `choicesChangedDetails` — `src/commands/plan/import-plan.ts:233` and `:287-291`.
- `planInvalidDetails`, `choicesInvalidDetails` — `src/http/server/plan/refusals.ts:11-17`. `planFinding`
  (`src/http/contract/graph.ts:33-38`) already matches `Finding` (`src/domain/plan-finding.ts:28-33`).
- `hostKeyMismatchDetails` — `src/http/server/repository/refusals.ts:34-37` and `:65-67`. Two reachable shapes,
  so a union. Do **not** merge them; `:65-67` carries no fingerprints to report.
- `credentialRejectedDetails` — `src/http/server/repository/refusals.ts:57-63`, a closed pair.
- `idempotencyMismatchDetails` — `src/commands/plan/import-plan.ts:532-538`.
- `invalidRequestDetails` — the union of every `invalid-request` payload in the tree:
  `src/http/server/repository/refusals.ts:12,18,22,26,30,39,53,75,79,83`,
  `src/http/server/plan/refusals.ts:27,33`, `src/http/server/credential/refusals.ts:7,13`,
  `src/http/server/project/refusals.ts:9,20,24`. All carry `refusal`; `detail` appears at
  `repository/refusals.ts:41,85` and `credential/refusals.ts:9`; `ids` at `plan/refusals.ts:35`.

`error-details.ts` importing `./graph.ts` is legal — both are `http/contract/`, and `graph.ts` imports only
`path.ts`, `operation.ts` and `domain/`, so no cycle exists.

### 2. Make production emit `expected` on `stale-revision`

`src/commands/plan/import-plan.ts:141-145` is today:

```ts
throw new ImportPlanError(
  "stale-revision",
  `the import names ${String(input.fromRevision)}, the newest revision is ${String(newest)}`,
  { current: newest },
);
```

Change the details object to `{ expected: input.fromRevision, current: newest }`. `input.fromRevision` is the
precondition token the client sent, and it is already `string | null`. Change nothing else — the message text
already names both values and stays as it is.

`src/http/server/plan/refusals.ts:23` passes `details(error)` through verbatim, so it needs no change.

### 3. Replace the hand-written cast in the CLI

`src/cli/plan/import.ts:131-137` reads `details.conflicts` through an `as` cast:

```ts
const details = importResult.details as
  | Readonly<{
      conflicts?: readonly Readonly<{ id: string }>[];
    }>
  | undefined;
const ids = details?.conflicts ?? [];
```

This is the second authority the EPIC exists to remove — a client reconstructing a details shape in its own
module. Replace the cast with a parse against the authored schema:

```ts
const details = choicesChangedDetails.parse(importResult.details);
const ids = details.conflicts.map((conflict) => conflict.id);
```

`src/cli/plan/import.ts` may import `src/http/contract/error-details.ts`: the import matrix allows `cli/` →
`http/contract/`. This is the one place in the product that proves the authored schema is usable by a consumer,
which is the epic's whole claim.

### 4. Keep `errorStatuses`, `HttpError` and `httpError` unchanged

`src/http/contract/errors.ts:3-26`, `:34`, `:46-58`, `:60-76` and `:78-85` are untouched by this story. Story 05
replaces `errorEnvelopeSchema` only.

## Constraints

- Add no error code and remove none. The count stays 22, and `errors.test.ts:25-50`, `:86` stay valid.
- **`identity-kind-mismatch` gets no `details` schema.** It is a plan _finding_ code
  (`src/domain/plan-finding.ts:15`) surfaced inside `plan-invalid` findings, and no file throws it as an
  `httpError`. It must stay in `errorStatuses`, because `errors.test.ts:13-23` asserts parity with
  `readErrorCodeMatrix()` and `docs/proposal/api/README.md:186` lists it. Story 05 declares it on no operation.
  That it appears in the proposal error table but is never an HTTP code is a **proposal finding to raise**, not
  an edit here.
- `illegal-transition`, `acknowledgement-required` and `lease-held` get no `details` schema in this story. No
  file throws them, and their conditions are phase-2 state transitions.
- Change no field on any request or response schema. Step 2 changes an error payload, which the ratified
  decision permits; it is not a response schema.
- Do not touch `src/http/contract/errors.ts`.

## Verify

- `node --test src/http/contract/error-details.test.ts` — new file. One test per exported schema, asserting the
  real emitted shape parses and a near-miss fails:
  - `staleRevisionDetails` parses `{expected: "revision_a", current: "revision_b"}` and `{expected: null,
current: null}`; rejects `{current: "x"}` (missing `expected`) and `{expected: "a", current: "b", extra: 1}`.
  - `needsReconcileDetails` parses two 40-character hex ids; rejects a `null`, rejects a 39-character id.
  - `bindingInUseDetails` parses one blocker of each of the three kinds; rejects `{blockers: []}`; rejects
    `{blockers: [{kind: "project-binding"}]}` (missing `projectId`); rejects an unknown `kind`.
  - `choicesStaleDetails` parses `{conflicts: [{id: "x", suggested: "submitted"}]}` and rejects
    `{conflicts: [{id: "x", reason: "y"}]}`, which is the `choices-changed` shape.
  - `choicesChangedDetails` does the reverse.
  - `planInvalidDetails` parses one real `Finding`; rejects `{findings: [{}]}`.
  - `hostKeyMismatchDetails` parses both members; rejects `{failure: "auth-failed"}`; rejects the merge
    `{presented: [], confirmed: null, failure: "host-key-mismatch"}`.
  - `credentialRejectedDetails` parses both failures; rejects `"nope"`.
  - `idempotencyMismatchDetails` parses `{differed: "documents"}`.
  - `invalidRequestDetails` parses `{refusal: "name-taken"}`, `{refusal: "x", detail: "y"}` and
    `{refusal: "choice-missing", ids: ["a"]}`; rejects `{}`.
- **Every real refusal satisfies its schema.** Add to `src/http/server/plan/refusals.test.ts` and
  `src/http/server/repository/refusals.test.ts` one assertion per mapped code: construct the real domain error,
  run it through `toHttpError`, and parse `error.details` with the matching schema from `error-details.ts`. This
  is what proves the schemas describe production and not a guess.
- `node --test src/commands/plan/import-plan.test.ts` — the existing `stale-revision` test now asserts
  `{expected: <the submitted fromRevision>, current: <newest>}`. Update the expected value; do not weaken the
  assertion to a partial match.
- `node --test src/cli/plan/import.test.ts` — passes with the parse in place of the cast. Add one assertion that
  a malformed `details` from a stubbed client makes the command fail loudly rather than printing an empty id
  list, which is the behaviour change the parse introduces.
- `npm run typecheck` — the removed `as` cast leaves no `any`.
- `npm test` — the whole suite passes.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-009.5`.
