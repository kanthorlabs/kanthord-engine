# Story 05 — Error envelope

Epic: `.agent/plan/epics/004-transport-skeleton.md`
Depends on: nothing. Dispatch it first.

## Change

### 1. `src/http/contract/errors.ts` (new)

```ts
import { z } from "zod";

export const errorStatuses = {
  "invalid-request": 400,
  unauthenticated: 401,
  "origin-forbidden": 403,
  "host-forbidden": 403,
  "not-found": 404,
  "stale-revision": 409,
  "illegal-transition": 409,
  "binding-in-use": 409,
  "needs-reconcile": 409,
  "acknowledgement-required": 409,
  "lease-held": 409,
  "idempotency-mismatch": 409,
  "choices-stale": 409,
  "choices-changed": 409,
  "plan-invalid": 422,
  "choices-invalid": 422,
  "identity-kind-mismatch": 422,
  "credential-rejected": 422,
  "internal-error": 500,
  "not-implemented": 501,
} as const;

export type ErrorCode = keyof typeof errorStatuses;

export type PreconditionCode = {
  [K in ErrorCode]: (typeof errorStatuses)[K] extends 409 ? K : never;
}[ErrorCode];

export type ErrorDetails = Readonly<Record<string, unknown>>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails | undefined;
}

export function httpError(
  code: PreconditionCode,
  message: string,
  details: ErrorDetails,
): HttpError;
export function httpError(
  code: Exclude<ErrorCode, PreconditionCode>,
  message: string,
  details?: ErrorDetails,
): HttpError;

export function errorEnvelope(error: HttpError): ErrorEnvelope;
```

The nineteen codes of `docs/proposal/api/README.md:147-165` in table order, plus `internal-error`. The table declares no `5xx` besides `501`, and an unexpected throw must still answer one shape, so `internal-error` is the twentieth member and it is the only code this repository adds.

`HttpError` sets `this.name = "HttpError"`, `this.code`, `this.status = errorStatuses[code]` and `this.details`. The constructor is not called directly by a handler; `httpError` is.

`httpError` is one implementation behind two overload signatures. The runtime body is `(code, message, details?) => new HttpError(code, message, details)`. The overload pair is the whole mechanism: a `409` code will not compile without `details`, which is how `docs/proposal/api/new-decisions.md:13` — "each returns the current value" — becomes a type error rather than a review note.

**What the overload proves, and what it does not.** It proves a third argument is present. It does not prove the argument carries the current value, and `httpError("stale-revision", "moved", {})` still compiles. Closing that gap needs a per-code details type — `stale-revision` requiring `expected` and `actual`, `needs-reconcile` requiring both object ids, and so on — and the proposal fixes those field names for only five of the nine `409` codes. So this story pins the argument and each later story pins its own fields where its use case names them. The limit is recorded rather than overclaimed.

`PreconditionCode` is named for `docs/proposal/api/new-decisions.md:13`, which calls all of these a precondition: "A stale revision, an illegal transition, a binding in use, a live lease, a divergence and a missing acknowledgement are all `409`, each with its own code, and each returns the current value." The type is therefore every `409` code, not a narrower set.

`errorEnvelope` returns `{ error: { code, message } }` when `details` is `undefined`, and `{ error: { code, message, details } }` otherwise. The `details` key is **omitted**, never present as `undefined`, because `JSON.stringify` drops an `undefined` value and an omitted key must be omitted in the object as well so a deep comparison in a test reads the same as the wire.

### 2. `src/http/server/envelope.ts` (new)

```ts
import type { Context, Next } from "koa";

export type EnvelopeDependencies = Readonly<{
  onInternalError: (error: unknown) => void;
}>;

export function envelopeMiddleware(
  dependencies: EnvelopeDependencies,
): (context: Context, next: Next) => Promise<void>;
```

The outermost middleware. It awaits `next()` inside a `try`.

1. A caught `HttpError` sets `context.status = error.status`, `context.body = errorEnvelope(error)`, and returns.
2. Any other caught value calls `dependencies.onInternalError(error)`, then sets `context.status = 500` and `context.body = errorEnvelope(httpError("internal-error", "internal error"))`. The caught message never reaches the body, because an internal message is not contract.

It rethrows nothing. Koa's own error listener therefore never runs.

## Constraints

- `src/http/contract/errors.ts` imports `zod` and nothing else. No koa, no `node:*`.
- The message of an `internal-error` response is the literal `"internal error"` in every case.
- Do not add a code beyond the twenty listed. `blockReason` values, publish rejection classes and repository states travel in `details`, not as a `code` — `docs/proposal/api/README.md:171`.

## Verify

`node --test src/http/contract/errors.test.ts` — new file, one suite named `"src/http/contract/errors.test"`:

- `Object.keys(errorStatuses)` deep-equals the twenty code strings in the order written above. This pins the table order, so a reordering is a visible diff.
- `Object.entries(errorStatuses)` grouped by status gives exactly: `400` → `["invalid-request"]`; `401` → `["unauthenticated"]`; `403` → `["origin-forbidden", "host-forbidden"]`; `404` → `["not-found"]`; `409` → the nine codes `["stale-revision", "illegal-transition", "binding-in-use", "needs-reconcile", "acknowledgement-required", "lease-held", "idempotency-mismatch", "choices-stale", "choices-changed"]` in table order; `422` → `["plan-invalid", "choices-invalid", "identity-kind-mismatch", "credential-rejected"]`; `500` → `["internal-error"]`; `501` → `["not-implemented"]`. Assert each group with one `assert.deepEqual`, and assert the twenty codes sum across the eight groups.
- Every code string matches `/^[a-z]+(-[a-z]+)*$/`, so a code is never camelCase.
- `httpError("not-found", "no such repository")` yields `status === 404`, `code === "not-found"`, `details === undefined`, `name === "HttpError"`, and `instanceof Error`.
- `errorEnvelope(httpError("not-found", "gone"))` deep-equals `{ error: { code: "not-found", message: "gone" } }`, and `Object.hasOwn(result.error, "details")` is `false`.
- `errorEnvelope(httpError("stale-revision", "moved", { expected: "revision_a", actual: "revision_b" }))` deep-equals the full three-key `error` object, `details` included.
- `errorEnvelopeSchema.parse` accepts both envelopes above, and rejects `{ error: { code: "x" } }` (no `message`) and `{ code: "x", message: "y" }` (no `error` wrapper).
- The `details` type gate is proved by construction, not at runtime: the test file carries a `// @ts-expect-error` line immediately above `httpError("stale-revision", "moved")`. `npx tsc --noEmit` fails if that call ever becomes legal, and `@ts-expect-error` fails if it becomes an error for a different reason. One such line is enough; the overload covers the whole union.
- The gate's limit is asserted too, so a reader is not misled: `httpError("stale-revision", "moved", {})` compiles and returns `details` deep-equal `{}`. The overload requires an argument, not a populated one.

`node --test src/http/server/envelope.test.ts` — new file, one suite named `"src/http/server/envelope.test"`. Each case builds a bare `new Koa()`, uses `envelopeMiddleware`, then one middleware that throws the value under test, and drives it with `supertest(app.callback())`:

- A thrown `httpError("host-forbidden", "bad host")` answers `403` with body deep-equal to `{ error: { code: "host-forbidden", message: "bad host" } }` and `Content-Type` matching `/application\/json/`.
- A thrown `httpError("lease-held", "held", { runId: "run_01" })` answers `409` with `details` deep-equal to `{ runId: "run_01" }`.
- A thrown `new Error("secret internal detail")` answers `500` with body deep-equal to `{ error: { code: "internal-error", message: "internal error" } }`. Assert the response text does **not** contain `"secret internal detail"`.
- The same case calls the injected `onInternalError` exactly once, with the thrown error object identical (`assert.strictEqual`) to the one thrown.
- A thrown string `"boom"` — not an `Error` — also answers `500` with the same body, and `onInternalError` receives the string.
- A middleware that throws nothing leaves the downstream status and body untouched: a downstream setting `context.body = { ok: true }` answers `200` with that body, and `onInternalError` is never called.

`npm run verify` exits 0.

Proof: contributes `src/http/contract/errors.test.ts` and `src/http/server/envelope.test.ts` to `node --test src/http/**/*.test.ts`.
