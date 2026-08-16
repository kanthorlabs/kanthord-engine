# Story 3 — The health response carries them

Epic: `.agent/plan/epics/023-version-compatibility-policy.md`
Depends on: Story 2.

**Coupled with Stories 4 and 5.** This story makes two response members required, so `src/queries/system/read-health.test.ts`, `src/http/server/system/health.test.ts` and `src/main.ts` stay red until Story 5 closes. Take no `npm run verify` gate between Stories 3, 4 and 5.

## Change

### `src/http/contract/system.ts`

Add `import { capabilityName } from "./capability.ts";` beside the existing `./error-baseline.ts` import at `:7`.

`systemHealthResponse` at `:18-26` gains two members. The final shape, member order exactly as written:

```ts
export const systemHealthResponse = z.strictObject({
  status: z.enum(healthStatuses),
  version: z.string().min(1),
  capabilities: z.array(capabilityName),
  dependencies: z.array(
    z.strictObject({
      name: z.string().min(1),
      status: z.enum(dependencyStatuses),
    }),
  ),
});
```

Both members are required. It stays a `z.strictObject`.

`systemHealthExamples` at `:77-88` gains both members in the same order. `KANTHORD_VERSION` is already imported at `:6`.

```ts
export const systemHealthExamples: OperationExamples = {
  success: {
    status: "ok",
    version: KANTHORD_VERSION,
    capabilities: ["external-drive", "per-node-write", "project-graph"],
    dependencies: [{ name: "storage", status: "ok" }],
  },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};
```

Edit `systemStatusResponse` at `:39-75` and `systemStatusExamples` at `:104` not at all.

### `src/http/contract/field-decisions.fixture.ts`

`src/http/contract/coverage.test.ts:209-305` derives every field row from the registry, sorts bytewise, and `assert.deepEqual`s against this fixture. Two rows are added. `capabilities` is an array of an enum, and `coverage.test.ts:252-254` walks `items` with `emit: false`, so the element emits no row of its own.

Insert before the current `:383` (`system.health.response#/properties/dependencies …`):

```
  "system.health.response#/properties/capabilities required=true nullable=false enum=-",
```

Insert after the current `:386` (`system.health.response#/properties/status …`):

```
  "system.health.response#/properties/version required=true nullable=false enum=-",
```

The file stays bytewise sorted. Add no other row and remove none.

### `src/http/contract/system.test.ts`

- Every fixture object that `systemHealthResponse.parse` or `.safeParse` must **accept** gains `version: "27.8.1"` and `capabilities: []`, or a non-empty capability list.
- Add to the reject list: a body missing `capabilities` fails `parse`; a body missing `version` fails `parse`; a body carrying an unknown key beside the four members fails `parse`; a body whose `capabilities` holds `"not-a-capability"` fails `parse`.
- Add one assertion that `findOperation("system.health")?.response` is `systemHealthResponse` by reference. If that assertion already exists, leave it.
- The assertion naming the operations that carry a `response` and the operations that carry a `request` does not change: this epic adds no operation.
- The banned server-path property-name assertion does not change: neither `version` nor `capabilities` is on that list.

## Constraints

- Add no operation. Leave both count literals of `src/http/contract/parity.test.ts` and the scoped-operation count literal of `src/http/contract/example.test.ts` at whatever values EPIC 022 left them.
- Do not widen `allowedActors` on any entry. `system.health` already declares `["human", "harness"]` at `src/http/contract/system.ts:145`.
- Do not touch `src/http/contract/registry.test.ts`.
- Do not hand-derive a third field-decision row. If `coverage.test.ts` reports a diff other than the two rows above, that is a defect in this edit, not in the fixture.

## Verify

Run inside the coupled block; the gate is Story 5.

- `node --test src/http/contract/system.test.ts` exits 0 with the four new reject cases.
- `node --test src/http/contract/example.test.ts` exits 0, which proves `systemHealthExamples.success` satisfies the widened `systemHealthResponse`.
- `node --test src/http/contract/coverage.test.ts` exits 0, which proves the fixture gained exactly the two rows.
- `node --test src/http/contract/parity.test.ts` exits 0 with both count literals unchanged.
- Proof: `src/http/contract/system.test.ts` and `src/http/contract/example.test.ts` of the EPIC Proof block.
