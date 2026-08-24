# Story 2 — The capability map and its derivation

Epic: `.agents/plan/epics/023-version-compatibility-policy.md`

This story is **independently green**. It adds one production file and one test file, and it edits nothing else.

## Change

### `src/http/contract/capability.ts` — new file

Its imports are exactly `zod` and `type Operation` from `./operation.ts`. **It does not import `./registry.ts`.** `registry.ts:23` imports `./system.ts`, and Story 3 makes `system.ts` import this file. A `registry.ts` import here would close the cycle `capability -> registry -> system -> capability`, and `system.ts` reads `capabilityName` at module initialization, so the cycle is a temporal-dead-zone `ReferenceError` at daemon start, not a style problem.

The map holds **three** names and nine operation ids.

Export four symbols, in this order:

```ts
export const capabilityOperations = {
  "external-drive": [
    "node.claim",
    "node.heartbeat",
    "node.release",
    "node.report",
  ],
  "per-node-write": ["node.create", "node.update", "node.delete"],
  "project-graph": ["project.nodes", "project.graph"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type CapabilityName = keyof typeof capabilityOperations;

export const capabilityName = z.enum(
  Object.keys(capabilityOperations) as [CapabilityName, ...CapabilityName[]],
);

export function declaredCapabilities(
  operations: readonly Operation[],
): readonly CapabilityName[];
```

`declaredCapabilities` behaviour, pinned:

- Build one lookup from `operations`, keyed by `operationId`, holding `status`.
- A name is **declared** when every operation id in its list resolves in that lookup **and** each resolved `status` is `"routed"`. A name with one unresolved id is not declared. A name with one `"stubbed"` id is not declared.
- Return the declared names sorted bytewise through `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`. Never rely on key insertion order.
- The function is pure: it reads nothing but its argument.

The map keys are already in bytewise order and stay so.

### `src/http/contract/capability.test.ts` — new file

`describe("src/http/contract/capability.test", …)` with `it` from `node:test` and `assert` from `node:assert/strict`. It imports `capabilityOperations`, `capabilityName`, `declaredCapabilities` from `./capability.ts`, and `registry` plus `findOperation` from `./registry.ts`.

Assert, one `it` per bullet:

1. **Every capability operation id resolves in the real registry.** For each name, for each id in `capabilityOperations[name]`, `assert.ok(findOperation(id), id)`. The failure message is the id.
2. **Every capability operation id is `routed` in the real registry.** For each id, `assert.equal(findOperation(id)!.status, "routed", id)`.
3. **The map keys and the zod enum agree.** `assert.deepEqual(capabilityName.options, Object.keys(capabilityOperations))`, and `assert.deepEqual([...capabilityName.options].sort(bytewise), capabilityName.options)`, where `bytewise` compares through `Buffer.compare`.
4. **The real registry declares the exact expected list.** `assert.deepEqual(declaredCapabilities(registry), ["external-drive", "per-node-write", "project-graph"])`.
5. **A `stubbed` operation suppresses its name.** Build a fixture array by mapping `registry` and replacing the entry whose `operationId` is `"node.report"` with `{ ...entry, status: "stubbed" }`. Assert `declaredCapabilities(fixture)` deep-equals `["per-node-write", "project-graph"]`.
6. **An absent operation suppresses its name.** Build a fixture array by filtering `registry` down to the entries whose `operationId` is not `"project.graph"`. Assert `declaredCapabilities(fixture)` deep-equals `["external-drive", "per-node-write"]`.
7. **The result is bytewise sorted, not insertion ordered.** Assert `declaredCapabilities(registry)` deep-equals a copy of itself sorted through `Buffer.compare`, and assert the same call twice returns deep-equal arrays.
8. **An empty registry declares nothing.** `assert.deepEqual(declaredCapabilities([]), [])`.

## Constraints

- Do not import `./registry.ts` from `src/http/contract/capability.ts`.
- Do not edit `src/http/contract/system.ts`, `registry.ts`, `operation.ts` or `path.ts` in this story. No operation is added, so `src/http/contract/parity.test.ts` keeps both of its count literals at whatever values EPIC 022 left them.
- `capabilityOperations` is the **only production declaration** of the three names and the nine operation ids. No other file under `src/` outside a `*.test.ts` writes one of those literals, and nothing derives the map from a second source. A test, a proposal example and a contract example each repeat the literal names on purpose, so that a silent change to the map fails an assertion instead of propagating.
- Do not add a capability name for an operation this block does not route.

## Verify

- `node --test src/http/contract/capability.test.ts` exits 0 with the eight assertions above.
- `node --test src/http/contract/parity.test.ts src/http/contract/registry.test.ts` exits 0, unchanged.
- `npm run lint` exits 0, which proves the new file is classified and imports no koa.
- `npm run verify` exits 0.
- Proof: `src/http/contract/capability.test.ts` of the EPIC Proof block.
