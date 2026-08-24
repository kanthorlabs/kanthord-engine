# Story 05 — errors declared per operation, and one envelope per operation

Epic: `.agents/plan/epics/009.5-contract-schemas.md`
Depends on: Story 04.

`details` is keyed by `(operationId, code)`, not globally by `code`. The invoking operation is the discriminator a
client already has, so a generated client exposes the exact `details` type for the method it called instead of a
union across every operation that shares the code.

This is a **scope addition the EPIC does not describe.** The human ratified it. The EPIC text needs the
corresponding amendment.

## Change

### 1. `Operation` declares its errors

`src/http/contract/operation.ts` — add above the `Operation` type:

```ts
export type OperationErrors = Partial<Record<ErrorCode, ZodType | null>>;
```

`null` means the code is answerable with **no** `details`. A `ZodType` means `details` is required and takes that
shape. Import `ErrorCode` from `./errors.ts` with `import type`, so no runtime cycle exists.

In `Operation` (`:19-28`), add `errors?: OperationErrors;` after `response?: ZodType;`.

### 2. The baseline every operation answers

New file `src/http/contract/error-baseline.ts`:

```ts
import { invalidRequestDetails } from "./error-details.ts";
import type { OperationErrors } from "./operation.ts";

export const baselineErrors: OperationErrors = {
  "invalid-request": invalidRequestDetails.optional(),
  unauthenticated: null,
  "origin-forbidden": null,
  "host-forbidden": null,
  "not-found": null,
  "internal-error": null,
  "service-unavailable": null,
};
```

Every code here is raised by middleware or by a route miss, so it applies to every operation:
`src/http/server/auth.ts:45,48`, `origin.ts:11`, `host.ts:18,21`, `route.ts:16`, `envelope.ts:24`, `app.ts:77`.

**`invalid-request` details are `.optional()`, and that is a finding rather than a preference.** The handlers are
inconsistent: `src/http/server/plan/validate-plan.ts:24` and `src/http/server/app.ts:77` emit no `details`, while
`src/http/server/plan/refusals.ts:27,33`, `credential/refusals.ts:7,13`, `project/refusals.ts:9,20,24` and
`repository/refusals.ts:12,18,22,26,30,39,53,75,79,83` all emit `{refusal, ...}`. A client therefore cannot rely
on `refusal`. Making it required is a handler cleanup for a later epic — **raise it, do not fix it here.**

### 3. The per-operation additions

Bind `errors:` on each entry as `{ ...baselineErrors, <additions> }`. Only five operations add anything; every
other phase-1 routed operation declares exactly `baselineErrors`.

| operationId           | codes beyond the baseline                                                                                       | source                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `repository.inspect`  | `credential-rejected`, `host-key-mismatch`                                                                      | `src/http/server/repository/refusals.ts:50-68` |
| `repository.register` | `credential-rejected`, `host-key-mismatch`                                                                      | `src/http/server/repository/refusals.ts:9-68`  |
| `plan.import`         | `plan-invalid`, `choices-invalid`, `choices-stale`, `choices-changed`, `stale-revision`, `idempotency-mismatch` | `src/http/server/plan/refusals.ts:6-37`        |
| `plan.validate`       | `plan-invalid`                                                                                                  | `src/http/server/plan/validate-plan.ts:33-38`  |
| `event.list`          | none — the baseline `invalid-request` covers a rejected `limit`                                                 | Story 01                                       |

Every other phase-1 routed operation — `system.health`, `system.db`, `system.status`, `blob.show`,
`provider.register`, `provider.list`, `provider.show`, `repository.list`, `repository.show`, `project.create`,
`project.list`, `project.show`, `project.repositories`, `plan.export`, `plan.revisions`, `node.list`,
`node.show`, `edge.list` — declares `baselineErrors` and nothing more. The four list handlers
(`credential/list-provider.ts`, `repository/list-repository.ts`, `project/list-project.ts`,
`node/list-node.ts`) throw nothing at all, verified.

The schema for each added code is the matching export from `src/http/contract/error-details.ts`.

**`stale-revision` is declared on `plan.import` only.** `src/http/server/repository/refusals.ts:43-47` maps an
`outside-writer` refusal to `stale-revision` with `{expectedOid, observedOid}`, but nothing constructs that
refusal: `outside-writer` appears in the union at `src/commands/repository/register-repository.ts:52` and in the
mapper, and in no throw site. It is dead, and its shape contradicts the ratified `{expected, current}`. **Do not
delete it and do not declare it** — record it as a finding for the human: either remove the dead branch and the
dead union member, or wire it and reshape it. Story 07 asserts it stays unreachable.

### 4. One envelope per operation

`src/http/contract/errors.ts` — replace `errorEnvelopeSchema` (`:36-42`) with a builder plus the baseline
envelope:

```ts
export function buildErrorEnvelope(errors: OperationErrors): ZodType;
```

It returns

```ts
z.strictObject({
  error: z.discriminatedUnion("code", <one member per declared code>),
});
```

Member per entry, iterated in `errorStatuses` key order (`:3-26`) so the emitted `oneOf` is canonical:

- schema is `null` → `z.strictObject({ code: z.literal(code), message: z.string() })`;
- schema is a `ZodType` → the same plus `details: <schema>`.

Keep the name `errorEnvelopeSchema` as the **baseline** envelope, `buildErrorEnvelope(baselineErrors)`. It is
what a `stubbed` route's `501` and any middleware error parses against, and it keeps every existing importer
working. `not-implemented` must therefore be added to `baselineErrors` with `null`.

`errorEnvelope(error: HttpError)` (`:78-85`) is unchanged — it formats and does not validate.

### 5. The generator emits a per-operation error component

`src/http/contract/openapi.ts:107-114` today points every operation's `default` response at the one `Error`
component. Change to:

- when `entry.errors !== undefined`, register a component named `` `${entry.operationId}.error` `` from
  `z.toJSONSchema(buildErrorEnvelope(entry.errors), { target: "openapi-3.0", io: "output" })`, and point
  `responses.default` at it;
- otherwise keep the existing `#/components/schemas/Error` reference, which is what every `stubbed` entry uses.

Keep `openapi.ts:14-20` registering `Error` from `errorEnvelopeSchema`, because the stubbed entries still
reference it.

Component count: `Error` + 30 request/response components + one `.error` per phase-1 routed operation with
`errors`. Update `src/http/contract/openapi.test.ts:205` to the new literal list, bytewise sorted, and rename the
test accordingly.

### 6. The CLI client keeps its signature

`src/cli/client.ts:25` returns `details: unknown`. Leave it. A caller parses with the schema it expects, exactly
as Story 04 did in `src/cli/plan/import.ts`. Widening the client to a per-operation generic is a CLI epic, not
this one.

## Constraints

- Declare a code on an operation **only** when a production file can raise it for that operation. The table in
  step 3 is the whole set; add nothing to it.
- No `stubbed` operation declares `errors`. Story 07 asserts that.
- `identity-kind-mismatch`, `illegal-transition`, `acknowledgement-required`, `binding-in-use`,
  `needs-reconcile` and `host-key-mismatch`-on-a-phase-2-route are declared on **no** phase-1 operation.
  `binding-in-use` and `needs-reconcile` still have authored schemas from Story 04, ready for the phase-2
  operation that declares them. That is the epic's premise: the schema exists before the handler.
- Change no handler and no command in this story. Story 04 already made the one production change.
- Change no request or response schema.

## Verify

- `node --test src/http/contract/errors.test.ts` — amended. `buildErrorEnvelope(baselineErrors)` parses
  `{error:{code:"not-found",message:"gone"}}` and `{error:{code:"invalid-request",message:"m",details:{refusal:"name-taken"}}}`;
  rejects `{error:{code:"plan-invalid",message:"m",details:{findings:[]}}}`, because `plan-invalid` is not in the
  baseline. The four tests Story 04 left in place at `:122-176` now use `{expected, current}`.
- `node --test src/http/contract/coverage.test.ts` — add: every phase-1 routed operation declares `errors`;
  every declared code is a key of `errorStatuses`; every operation's declared set is a superset of
  `baselineErrors`; the five operations of step 3 declare exactly the listed additions and nothing else.
- **The declared set equals what the mapper can emit.** New test
  `src/http/server/plan/refusals.test.ts` and `src/http/server/repository/refusals.test.ts` addition: drive
  `toHttpError` over **every** refusal value of the domain error union, collect the emitted codes, and assert the
  set equals the operation's declared codes minus the baseline. Exclude `outside-writer` explicitly, with a
  comment naming it as the dead branch of step 3, so the exclusion is visible rather than silent. This is the
  assertion that makes the step-3 table self-verifying instead of hand-audited.
- `node --test src/http/contract/openapi.test.ts` — the new component list passes; `:242` internal refs, `:261`
  byte-identical render, `:269` `SwaggerParser.validate`, `:279` and `:291` the two negative controls all pass
  over a document that now carries one error envelope per operation. Add one test: `/v1/plan/…` `plan.import`'s
  `responses.default` refs `#/components/schemas/plan.import.error`, and a stubbed operation's
  `responses.default` still refs `#/components/schemas/Error`.
- Then, restoring after each: declare `plan-invalid` on `project.list` and confirm the coverage superset test
  still passes but the refusals-parity test fails naming `project.list`; remove `stale-revision` from
  `plan.import` and confirm the refusals-parity test fails.
- `npm test` — the whole suite passes.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-009.5`.
