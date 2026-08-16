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

### The red set is exactly four files

`readHealth`, `ReadHealthResult` and `ReadHealthDependencies` appear outside `src/queries/system/read-health.ts` in exactly these places, and this story edits all of them:

- `src/queries/system/read-health.test.ts:30,37,45,55,65,75,92,108,114`
- `src/http/server/system/health.ts:2,5,11` — type-only, no edit needed
- `src/http/server/start.test.ts:17,92`
- `src/http/server/system/health.test.ts:5,14,23,34,40,52,66,80,94,121`
- `src/main.ts:132,245,255` — Story 5

Before finishing, re-run `grep -rn "readHealth\|ReadHealthResult\|ReadHealthDependencies" src test scripts` and confirm the hit set is that list plus `read-health.ts` itself. A hit outside it is an edit this story missed.

### `src/http/server/system/health.test.ts`

- Every `ReadHealthResult` fixture — the `okResult` and the degraded one — gains `version: "27.8.1"` and `capabilities: ["external-drive", "per-node-write", "project-graph"]`.
- Add: the `200` body deep-equals the fixture, `version` and `capabilities` included, and `systemHealthResponse.parse(body)` does not throw.
- The `401 unauthenticated`, `403 origin-forbidden`, `403 host-forbidden` and call-count cases stay exactly as they are.

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
- `npm run lint` exits 0 with `src/queries/system/read-health.ts` importing no file from `src/http/contract/`.
- Proof: `src/queries/system/read-health.test.ts` and `src/http/server/system/health.test.ts` of the EPIC Proof block.
