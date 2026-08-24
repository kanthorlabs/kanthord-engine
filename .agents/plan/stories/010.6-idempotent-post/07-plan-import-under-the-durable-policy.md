# Story 7 — `plan.import` under the durable policy

Epic: `.agents/plan/epics/010.6-idempotent-post.md`
Depends on: Story 4.

## Change

### `src/http/server/idempotency.ts` — replace step 7

Story 4 wrote step 7 as a bare `await next(); return;`. Replace it with:

```ts
if (policy === "durable") {
  const body = context.request.body;
  const importId =
    typeof body === "object" && body !== null && "importId" in body
      ? (body as { importId: unknown }).importId
      : undefined;
  if (typeof importId !== "string" || importId !== read.key) {
    throw httpError("invalid-request", "Idempotency-Key must equal importId");
  }
  await next();
  return;
}
```

Step 4 already returned when the key is absent, so this branch runs only when a key was supplied.
A `plan.import` with **no** header therefore reaches its command untouched, exactly as it does
today.

The middleware validates the header and then **touches no store**. It computes no fingerprint,
takes no reservation, and writes no record. The durable mechanism owns the lookup, the fingerprint
and the replay: `plan_revision.import_id` with `UNIQUE (project_id, import_id)`
(`src/services/storage/migration-0002-graph-and-plan.ts:11,15`),
`PlanStore.findByImportId` (`src/services/plan/sqlite.ts:176-195`), and the four-part fingerprint
of EPIC 008.

The message is an exact string. A test asserts the response body byte for byte.

The header is refused only on a mismatch, never on presence. One SDK rule — "send
`Idempotency-Key` on every `POST`" — therefore covers `plan.import` too.

## Constraints

- The `durable` branch must appear **before** the `ttlSeconds === 0` check of Story 5. A zero TTL
  disables the memory cache; it must not disable the header-equals-`importId` rule.
- Do not read the store, do not call `fingerprint`, and do not call `recordKey` on this path.
- Do not touch `src/commands/plan/`, `src/http/server/plan/`, `src/services/plan/` or
  `src/domain/plan-*.ts`. The durable mechanism is EPIC 008's, and it is unchanged by this epic.
- Do not add a `request` schema to `plan.import`. `src/http/contract/system.test.ts:224-226` asserts
  it carries none, and that assertion belongs to EPIC 008.
- `plan.import` declares `idempotency: "durable"` and no `replayable` (Story 1, Story 2). Do not
  add one.

## Verify

`node --test src/http/server/idempotency.test.ts` — extend, on top of Story 4. Add
`POST /v1/project/p_1/plan/import` to the route table; it matches the real registry entry
`plan.import` (`src/http/contract/graph.ts:38-49`).

- **A header equal to `importId` reaches the command, and the cache holds no record.** Body
  `{"importId":"imp_a","documents":[]}` with `Idempotency-Key: imp_a` answers the handler's result,
  `calls() === 1`, and `store.size() === 0`.
- **A second identical request also reaches the command.** Repeat the request above:
  `calls() === 2` and `store.size() === 0`. The memory cache never suppresses a `durable`
  operation; suppression is the command's job.
- **A header that differs from `importId` is `400 invalid-request`.** Body
  `{"importId":"imp_a"}` with `Idempotency-Key: imp_b` answers `400`, body deep-equals
  `{ error: { code: "invalid-request", message: "Idempotency-Key must equal importId" } }`,
  `calls() === 0`, and `store.size() === 0`.
- **A body with no `importId` and a header present is `400 invalid-request`.** Body `{}` with
  `Idempotency-Key: imp_a`: the same body and `calls() === 0`.
- **A non-object body with a header present is `400 invalid-request`.** Body `[]` with
  `Idempotency-Key: imp_a`: the same body and `calls() === 0`.
- **A numeric `importId` with a matching-looking header is `400 invalid-request`.** Body
  `{"importId":1}` with `Idempotency-Key: 1`: the same body and `calls() === 0`. The comparison is
  string equality, never coercion.
- **No header reaches the command untouched.** Body `{"importId":"imp_a"}` with no header:
  `calls() === 1` and `store.size() === 0`.
- **A malformed header is still `400` before the `importId` comparison.** A 256-character header
  with body `{"importId":"imp_a"}` answers
  `body.error.message === "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space"`, not the
  `importId` message. This pins the step order: validation is step 3, the durable branch is step 7.
- **A reordered documents array is not a mismatch here.** Two requests with
  `Idempotency-Key: imp_a`, the first with body
  `{"importId":"imp_a","documents":[{"path":"a"},{"path":"b"}]}` and the second with
  `{"importId":"imp_a","documents":[{"path":"b"},{"path":"a"}]}`. Both reach the command
  (`calls() === 2`), neither answers `409`, and `store.size() === 0`. The raw-byte fingerprint of
  Story 3 would have called the second a mismatch; it never runs on this path.
- **A zero TTL does not disable the `importId` rule.** With `ttlSeconds: 0`, body
  `{"importId":"imp_a"}` and `Idempotency-Key: imp_b` still answers `400 invalid-request` with the
  `importId` message.

**Out of scope, and stated so the reviewer does not look for it here.** That a `plan.import` retry
returns the original revision, and that a reordered array is a _retry_ rather than a mismatch
_inside the command_, are asserted by EPIC 008 against `src/commands/plan/import-plan.ts` — see
`.agents/plan/stories/008-project-and-plan/11-import-transaction.md:198-212`. This story asserts only
that the middleware steps aside and lets that mechanism decide.

The EPIC's coverage line was amended to match: it now asks this story to prove that the reordered
retry **reaches the command both times and takes no record**, which is the half a transport test can
prove. That the reordered retry then returns the original revision is EPIC 008's assertion, already
in its gate as "a reordered document array is still a retry". Asserting it here would assert a fake
handler and prove nothing.

`npm run verify` exits 0.

Proof: delivers the Proof lines "`plan.import` with a header equal to its `importId` reaches the
durable path, and the memory cache holds no record for it. With a header that differs from
`importId` it is `400 invalid-request`" and "`plan.import` retried with the documents in a
different array order is a retry, not a mismatch, proving the durable fingerprint is in force
rather than the raw-byte one" — as amended: both requests reach the command and no record is taken.
