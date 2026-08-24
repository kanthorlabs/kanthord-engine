# Story 6 — The response capture

Epic: `.agents/plan/epics/010.6-idempotent-post.md`

Dispatch this story **before** Story 5 and Story 4. It is a refactor plus one new module, and both
of those stories consume its exports.

## Change

### 1. `src/http/server/envelope.ts` — extract the materialization

`envelope.ts:12-27` today materializes a thrown error inline. Move that decision into an exported
pure function in the same file, above `envelopeMiddleware`:

```ts
export type Materialized = Readonly<{
  status: number;
  body: unknown;
  internal: boolean;
}>;

export function materializeError(error: unknown): Materialized {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: errorEnvelope(error),
      internal: false,
    };
  }
  return {
    status: 500,
    body: errorEnvelope(httpError("internal-error", "internal error")),
    internal: true,
  };
}
```

Rewrite the middleware body to call it. The reporting side effect stays in the middleware — the
function is pure, so a caller that records an answer does not report a second time:

```ts
    } catch (error: unknown) {
      const materialized = materializeError(error);
      if (materialized.internal) {
        dependencies.onInternalError(error);
      }
      context.status = materialized.status;
      context.body = materialized.body;
    }
```

Observable behaviour is unchanged: an `HttpError` still answers its own status and envelope with no
report, and anything else still answers the constant `500` envelope with exactly one report.

`internal` is `false` for every `HttpError`, including one a handler raised through
`httpError("internal-error", …)`. `internal` is `true` only for a throw the daemon did not declare.

### 2. New file `src/http/server/idempotency-response.ts`

```ts
import type { Context } from "koa";

export type StoredAnswer = Readonly<{
  status: number;
  body: unknown;
  headers: readonly (readonly [string, readonly string[]])[];
}>;

export const VOLATILE_HEADERS: readonly string[] = [
  "connection",
  "content-length",
  "date",
  "keep-alive",
  "transfer-encoding",
];

export function headerSnapshot(context: Context): ReadonlyMap<string, string>;

export function captureAnswer(
  context: Context,
  before: ReadonlyMap<string, string>,
  status: number,
  body: unknown,
): StoredAnswer;

export function applyAnswer(context: Context, answer: StoredAnswer): void;
```

#### `headerSnapshot`

A `Map` from lowercased name to a rendered value, not a name list:

```ts
const snapshot = new Map<string, string>();
for (const [name, value] of Object.entries(context.response.headers)) {
  snapshot.set(name.toLowerCase(), renderValue(value));
}
return snapshot;
```

`renderValue(value)` is `JSON.stringify(Array.isArray(value) ? value.map(String) : [String(value)])`
— one function, used by both `headerSnapshot` and `captureAnswer`, so the comparison below is
exact.

It carries the **value**, not only the name, because a name comparison cannot tell an upstream
request-specific header apart from that same header rewritten by the handler. A downstream
`context.vary("Origin")` on a response that already carried `Vary: Accept` keeps the name and
changes the value; a name-only snapshot would drop it from the answer.

#### `captureAnswer`

Capture a header when it is **new, or changed**, since the snapshot. A header the origin middleware
set for _this_ request, and that nothing downstream touched, never travels into a replay of a
_different_ request.

```ts
const pairs: [string, readonly string[]][] = [];
for (const [name, value] of Object.entries(context.response.headers)) {
  const lower = name.toLowerCase();
  if (VOLATILE_HEADERS.includes(lower)) continue;
  const rendered = renderValue(value);
  if (before.get(lower) === rendered) continue;
  pairs.push([
    lower,
    Array.isArray(value) ? value.map(String) : [String(value)],
  ]);
}
pairs.sort((a, b) =>
  Buffer.compare(Buffer.from(a[0], "utf8"), Buffer.from(b[0], "utf8")),
);
return { status, body, headers: pairs };
```

The sort is bytewise on the name, so the stored array is the same for the same response and a
replay is byte-identical. `content-length` is excluded because koa recomputes it from the body; the
other four are hop-by-hop and koa never sets them on `response.headers`.

**What "byte-identical" means in this epic:** the status, the body bytes, and every retained answer
header. It does not mean the literal HTTP response octets — `Date` and `Content-Length` are excluded
because the daemon does not own them, and a test that compared them would fail on a clock tick.

**The body is retained by reference.** A handler that mutates a body object after returning it
changes what a replay answers. No handler in this repo does, and none may: see the Constraints.

#### `applyAnswer`

Order is normative: headers, then body, then status.

```ts
for (const [name, values] of answer.headers) {
  context.set(name, values.length === 1 ? (values[0] as string) : [...values]);
}
context.body = answer.body;
context.status = answer.status;
```

Headers go first because koa's `body` setter assigns `Content-Type` only when the response has
none; a captured `content-type` set first therefore wins. Status goes last because the `body`
setter assigns `200` when the status was never set explicitly, and `204` when the body is `null`.
Assigning the status after the body makes the stored status authoritative in both cases.

## Constraints

- `materializeError` performs no side effect. Reporting stays in `envelopeMiddleware`.
- Do not change `envelopeMiddleware`'s signature, its mount position (`app.ts:51`), or the bytes of
  any error body. `src/http/server/envelope.test.ts` must pass with no edit.
- Do not add `content-type` to `VOLATILE_HEADERS`. A replay must carry the content type of the
  answer it replays.
- `captureAnswer` never reads `context.status` or `context.body`; both arrive as arguments, because
  the throw path has no status on the context yet.
- **A handler must not mutate a body it has returned.** The stored answer holds that object by
  reference, and a mutation after the fact silently changes every replay. The epic does not deep
  copy: a copy would double the retained bytes and would not survive a non-JSON body. Every handler
  in `src/http/server/**` today returns a freshly built literal, and this constraint keeps it so.

## Verify

`node --test src/http/server/envelope.test.ts` — must pass **unchanged**. It is the regression
guard for the refactor. Then extend it with:

- `materializeError(httpError("not-found", "gone"))` returns
  `{ status: 404, body: { error: { code: "not-found", message: "gone" } }, internal: false }` —
  asserted with `assert.deepEqual` on the whole object.
- `materializeError(httpError("stale-revision", "moved", { a: "b" }))` returns status `409` and a
  body carrying `details`, with `internal: false`.
- `materializeError(new Error("boom"))` returns
  `{ status: 500, body: { error: { code: "internal-error", message: "internal error" } },
internal: true }`. The original message must not appear anywhere in the returned body.
- `materializeError("a string")` and `materializeError(undefined)` both return the same
  `internal: true` result as `new Error("boom")`.
- `materializeError(httpError("internal-error", "internal error"))` returns status `500` with
  `internal: false`. This is the row that pins "a declared `500` is not indeterminate".

`node --test src/http/server/idempotency-response.test.ts` — new file. Suite name
`src/http/server/idempotency-response.test`. Build a probe koa app the way
`src/http/server/origin.test.ts:10-18` does, reached through `loopbackAgent` from
`test/helpers/agent.ts`. The probe mounts one middleware that records `headerSnapshot(context)`,
calls `next()`, then calls `captureAnswer(...)` and stashes the result in a module-level variable
the test reads.

- **An untouched upstream header is not captured.** The probe sets `X-Before: 1` before `next()`;
  the terminal middleware sets `X-After: 2` and a body. The captured `headers` deep-equal
  `[["content-type", ["application/json; charset=utf-8"]], ["x-after", ["2"]]]`. `x-before` is
  absent.
- **A changed upstream header _is_ captured.** The probe sets `X-Before: 1` before `next()`; the
  terminal middleware overwrites it with `X-Before: 2`. The captured `headers` contain
  `["x-before", ["2"]]`. This is the row a name-only snapshot would fail.
- **A merged upstream header is captured.** The probe sets `Vary: Accept` before `next()`; the
  terminal middleware calls `context.vary("Origin")`, which merges to `Accept, Origin`. The
  captured `headers` contain `["vary", ["Accept, Origin"]]`.
- **Volatile names are dropped.** The terminal middleware sets `Content-Length: 99` explicitly. The
  captured `headers` contain no `content-length` entry.
- **The order is bytewise by name.** The terminal middleware sets `X-Zulu`, then `X-Alpha`, then
  `X-Mike`. The captured names are exactly `["content-type", "x-alpha", "x-mike", "x-zulu"]`.
- **A repeated header keeps every value.** The terminal middleware calls
  `context.set("X-Multi", ["a", "b"])`. The captured entry is `["x-multi", ["a", "b"]]`.
- **A numeric value becomes a string.** `context.set("X-Count", 7)` captures `["x-count", ["7"]]`.
- **`applyAnswer` round-trips.** A second probe app whose only middleware calls
  `applyAnswer(context, answer)` with a literal
  `{ status: 201, body: { ok: true }, headers: [["etag", ['"abc"']], ["x-multi", ["a", "b"]]] }`
  answers status `201`, body `{ ok: true }`, `response.headers.etag === '"abc"'`, and
  `response.headers["x-multi"] === "a, b"`.
- **`applyAnswer` keeps the captured content type.** An answer whose headers carry
  `["content-type", ["application/json; charset=utf-8"]]` and whose body is `{ ok: true }` answers
  with exactly that content type.
- **`applyAnswer` keeps a `204`-shaped answer's status.** An answer of
  `{ status: 200, body: null, headers: [] }` answers status `200`, not `204`. This is the row that
  pins "status last".

`npm run verify` exits 0.

Proof: delivers the response-capture half of `src/http/server/idempotency.test.ts` — the Proof
lines "both answers are byte-identical including the response headers" and "marks the key
indeterminate".
