# Story 4 — The query and the handler

Epic: `.agent/plan/epics/023-version-compatibility-policy.md`
Depends on: Story 3.

**Coupled with Stories 3 and 5.** Take no `npm run verify` gate before Story 5 closes.

## Change

### `src/queries/system/read-health.ts`

`ReadHealthDependencies` at `:14-16` gains two required members:

```ts
export type ReadHealthDependencies = Readonly<{
  reporters: readonly DependencyReporter[];
  version: string;
  capabilities: readonly string[];
}>;
```

`ReadHealthResult` at `:18` stops being an alias. Replace `export type ReadHealthResult = HealthResult;` with:

```ts
export type ReadHealthResult = HealthResult &
  Readonly<{
    version: string;
    capabilities: readonly string[];
  }>;
```

The `return` at `:40` becomes:

```ts
return {
  status,
  version: dependencies.version,
  capabilities: dependencies.capabilities,
  dependencies: lines,
};
```

`version` and `capabilities` pass through byte for byte. The query copies the array reference and sorts nothing: the derivation of Story 2 already returns a bytewise-sorted list, and a second sort here would be a second ordering rule.

Unchanged: the `try`/`catch` per probe at `:23-31`, the bytewise dependency sort at `:32-34`, and the `degraded` rule at `:35-39`.

**`src/queries/system/read-health.ts` imports nothing from `src/http/contract/`.** `capabilities` is `readonly string[]`, injected. `eslint.config.js:276-300` and the `boundaries` policy forbid the import, and that constraint is the reason for the injection.

### `src/queries/system/read-status.ts`

No edit. `ReadStatusDependencies.health` at `:8` stays `() => HealthResult`, and the widened `ReadHealthResult` is assignable to it.

### `src/queries/system/read-health.test.ts`

- Every existing `readHealth({ reporters: … })` call gains `version: VERSION` and `capabilities: CAPABILITIES`, with module constants `const VERSION = "27.8.1";` and `const CAPABILITIES = ["external-drive", "per-node-write", "project-graph"] as const;`. Every existing assertion on `status` and `dependencies` stays exactly as it is.
- Add: the result's `version` equals `VERSION` and its `capabilities` deep-equals `CAPABILITIES`, member for member and in order.
- Add: with `capabilities: []` the result's `capabilities` is `[]` and `status` is still `"ok"`.
- Add: a reporter that throws still yields the injected `version` and `capabilities` unchanged, and `status` `"degraded"`.
- Add: `capabilities` is returned in injected order, not re-sorted — inject `["project-graph", "external-drive"]` and assert the result is `["project-graph", "external-drive"]`.
- The existing final case keeps `systemHealthResponse.safeParse(result).success === true`; it now exercises the two required members.

### `src/http/server/system/health.ts`

No edit. `healthHandler` at `:8-12` returns `{ status: 200, body: dependencies.readHealth() }`, and it parses nothing and branches on nothing.

### `src/http/server/start.test.ts`

`:92` binds `readHealth: () => readHealth({ reporters })` inside the handler map. It gains the two members:

```ts
      "system.health": healthHandler({
        readHealth: () =>
          readHealth({
            reporters,
            version: "27.8.1",
            capabilities: [],
          }),
      }),
```

Nothing else in that file changes. `:47` fetches `/v1/health` without a token and asserts the unauthenticated refusal, which the two new members do not reach.

### The red set has two halves, and only one half is greppable

**Half one — the symbol consumers.** `readHealth`, `ReadHealthResult` and `ReadHealthDependencies`
appear outside `src/queries/system/read-health.ts` in exactly these places. A change to
`ReadHealthDependencies` breaks each one at typecheck:

- `src/queries/system/read-health.test.ts:30,37,45,55,65,75,92,108,114`
- `src/http/server/system/health.ts:2,5,11` — type-only, no edit needed
- `src/http/server/start.test.ts:17,92`
- `src/http/server/system/health.test.ts:5,14,23,34,40,52,66,80,94,121`
- `src/main.ts:132,245,255` — Story 5

Confirm that half with `grep -rn "readHealth\|ReadHealthResult\|ReadHealthDependencies" src test scripts`.
The hit set is that list plus `read-health.ts` itself.

**Half two — the body-shape consumers.** A file that asserts the shape of the `system.health` response
body names no symbol from `read-health.ts`. It breaks at run time and never at typecheck, so the grep
above cannot see it. This story edits both:

- `src/http/contract/field-decisions.fixture.ts:613,618` — the reviewed field fixture enumerates every
  registry field, so the two new members need two new rows in sorted position. Found by
  `grep -rn "system\.health\.response" src test scripts`, which hits this file and
  `src/http/contract/openapi.test.ts` and nothing else.
- `src/services/home-lock/startup.test.ts:15,124` — deep-equals the live daemon's `/v1/health` body
  against an object literal. **No grep finds this one reliably**: it names no symbol and no schema
  label, and `grep -rn "v1/health"` hits 18 files that mostly assert a refusal envelope or a route
  table instead of the success body.

**Therefore the completeness check is a run, not a grep.** `npm run verify` runs `npm test`, and the
full suite is the only exact answer for half two. That check belongs at the close of the coupled
block, in Story 5, because half two cannot be green mid-block. Do not read the two greps above as a
completeness proof — they are a head start, and a hit outside the two lists is still an edit this
story missed.

### `src/http/server/system/health.test.ts`

- Every `ReadHealthResult` fixture — the `okResult` and the degraded one — gains `version: "27.8.1"` and `capabilities: ["external-drive", "per-node-write", "project-graph"]`.
- Add: the `200` body deep-equals the fixture, `version` and `capabilities` included, and `systemHealthResponse.parse(body)` does not throw.
- The `401 unauthenticated`, `403 origin-forbidden`, `403 host-forbidden` and call-count cases stay exactly as they are.

### `src/http/contract/field-decisions.fixture.ts`

Two rows, each in bytewise-sorted position among the `system.health.response` rows:

```ts
  "system.health.response#/properties/capabilities required=true nullable=false enum=-",
  "system.health.response#/properties/version required=true nullable=false enum=-",
```

`capabilities` carries `enum=-` even though its items are `capabilityName`: the walker emits a row per
object property, and an array of enum has no `items/properties/…` to descend into. Add no third row.

### `src/services/home-lock/startup.test.ts`

The `assert.deepEqual(await authorized.json(), …)` at `:123` gains the two members:

```ts
assert.deepEqual(await authorized.json(), {
  status: "ok",
  version: KANTHORD_VERSION,
  capabilities: ["external-drive", "per-node-write", "project-graph"],
  dependencies: [{ name: "storage", status: "ok" }],
});
```

Import `KANTHORD_VERSION` from `../../domain/version.ts`. A test may import `domain/` per the import
matrix. The `401 unauthenticated` assertion above it and every other case in the file are unchanged.

## Constraints

- Do not import `src/http/contract/capability.ts` from `src/queries/` or from `src/http/server/system/health.ts`.
- Do not make `version` or `capabilities` optional or nullable anywhere.
- Do not move the dependency sort or change the `degraded` rule.
- Do not add a `capabilities` member to `ReadStatusResult` or to `systemStatusResponse`.

## Verify

Run inside the coupled block; the gate is Story 5.

- `node --test src/queries/system/read-health.test.ts` exits 0 with the four new cases.
- `node --test src/queries/system/read-status.test.ts` exits 0, unchanged.
- `node --test src/http/server/system/health.test.ts` exits 0 with the widened fixtures.
- `node --test src/http/server/start.test.ts` exits 0, unchanged in behaviour.
- `node --test src/http/contract/coverage.test.ts` exits 0. It was red from Story 3, not from this story.
- `node --test src/services/home-lock/startup.test.ts` exits 0 with the widened live-body assertion.
- `npm run lint` exits 0 with `src/queries/system/read-health.ts` importing no file from `src/http/contract/`.
- Proof: `src/queries/system/read-health.test.ts` and `src/http/server/system/health.test.ts` of the EPIC Proof block.
