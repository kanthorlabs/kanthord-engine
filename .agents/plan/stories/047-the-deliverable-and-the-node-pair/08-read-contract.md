# Story 08 — The read contract publishes the two fields

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`
Depends on: Story 03, Story 05, Story 06

## Change

### `src/http/contract/graph.ts`

**`nodeAttributes` schema (lines 183–191):** Add two nullable fields to the `z.strictObject`:

```ts
deliverable: z.enum(deliverables).nullable(),
verify: verifyBlockContract.nullable(),
```

Where `verifyBlockContract` is defined in the same file as:

```ts
const verifyBlockContract = z.strictObject({
  paths: z.array(z.string()),
  commands: z.array(z.string()),
});
```

Import `deliverables` from `src/domain/deliverable.ts`.

**`nodeShowResponse` (lines 155–167):** Add the same two fields:

```ts
deliverable: z.enum(deliverables).nullable(),
verify: verifyBlockContract.nullable(),
```

`verifyBlockContract` is the same const defined once in this file.

Update the `nodeAttributes` example literal in `src/http/contract/graph.ts` to include `deliverable: null` and `verify: null` (for the existing example which represents a node without these fields set).

### `src/queries/node/show-node.ts`

**`NodeView` type (lines 13–34):** Add two fields after `worker: string | null;`:

```ts
deliverable: string | null;
verify: { paths: string[]; commands: string[] } | null;
```

**`showNode` function (lines 61–111):** The spread `...stored` at line 86 already includes `deliverable` and `verifyJson` once Story 05 adds them to `StoredNode`. Add explicit mapping to replace `verifyJson` with `verify`:

After the `...stored` spread, add:

```ts
verify: stored.verifyJson === null
  ? null
  : parseVerifyBlock(stored.verifyJson),
```

Remove `verifyJson` from the spread result — the caller must not see the raw JSON string. Since `...stored` spreads all `StoredNode` fields including `verifyJson`, and the return type `NodeView` does not include `verifyJson`, TypeScript will error. Add `verifyJson: undefined` or restructure the spread to exclude it. The cleanest approach: destructure `verifyJson` out of `stored` before spreading:

```ts
const { verifyJson, ...storedWithout } = stored;
return {
  ...storedWithout,
  instruction: ...,
  verify: verifyJson === null ? null : parseVerifyBlock(verifyJson),
  ...
};
```

Import `parseVerifyBlock` from `src/domain/verify-block.ts`.

If `parseVerifyBlock` throws `VerifyBlockError`, catch it and rethrow with the node ID attached. The EPIC requires the error surfaces as a `500` naming the node id. Wrap the call:

```ts
verify: stored.verifyJson === null
  ? null
  : (() => {
      try {
        return parseVerifyBlock(stored.verifyJson);
      } catch (e) {
        throw Object.assign(e as VerifyBlockError, { nodeId: stored.id });
      }
    })(),
```

The `node.show` HTTP handler must catch `VerifyBlockError` and respond with HTTP 500, including `stored.id` (the node id) in the error body. Read `src/http/server/node/` to find the existing handler and locate the error-handling point before writing.

### `src/queries/project/show-project-graph.ts`

**`nodeAttributes` function (lines 33–43):** Add two fields to the return object:

```ts
deliverable: node.deliverable,
verify: node.verifyJson === null ? null : parseVerifyBlock(node.verifyJson),
```

Import `parseVerifyBlock` from `src/domain/verify-block.ts`.

If `parseVerifyBlock` throws, wrap it to attach `node.id` before rethrowing — same pattern as `show-node.ts`. The `project.graph` handler catches `VerifyBlockError` and responds HTTP 500 with the node id.

**`GraphAttributes` in `src/services/graph/index.ts:26–32`** is currently `Readonly<Record<string, string | number | boolean | null>>`. This type is too narrow for `verify: { paths: string[]; commands: string[] } | null`. Do NOT widen to `Record<string, unknown>` — that removes all type safety from the graph capability. Instead, add the verify-block shape to the value union:

```ts
export type VerifyBlockValue = Readonly<{
  paths: readonly string[];
  commands: readonly string[];
}>;

export type GraphAttributes = Readonly<
  Record<string, string | number | boolean | null | VerifyBlockValue>
>;
```

This is a targeted widening: only the new nested type is added; all existing primitive-value callers continue to type-check unchanged. Export `VerifyBlockValue` so the graph-contract and query files can reference it.

### `src/http/contract/example-literal.ts` and `src/http/contract/graph.ts` examples

The existing example literals for `nodeAttributes` and `nodeShowResponse` need `deliverable` and `verify` fields. Add `deliverable: null` and `verify: null` to every existing node example literal. `example.test.ts` asserts round-trip parse — adding nullable fields with `null` values passes a `z.strictObject` parse only if the schema includes those fields.

## Constraints

- `verifyJson` is never returned to any caller of `showNode` or `showProjectGraph` — the raw string is internal.
- A malformed `verify_json` row surfaces as a thrown `VerifyBlockError` (code `"verify-json-malformed"`), not as `null`.
- `assignment` does not appear in any schema, type, or mapping in this story.

## Tasks

### Task 08 — Cover the published read contract

**Input:** `src/queries/node/show-node.test.ts`,
`src/queries/project/show-project-graph.test.ts`, `src/http/contract/graph.test.ts`,
`src/http/server/node/claim-node.test.ts`, `src/http/server/node/release-node.test.ts`,
`src/http/server/project/show-project-graph.test.ts`, `src/cli/node/claim.test.ts`,
`src/cli/node/delete.test.ts`, `src/cli/node/release.test.ts`, `src/cli/node/show.test.ts`,
`src/cli/node/unblock.test.ts`, `src/cli/node/update.test.ts`,
`src/cli/project/graph.test.ts`, `src/cli/reachability.test.ts`,
`src/commands/startup/recover-expired-leases.test.ts`, plus every production file
`## Change` names, and `src/http/contract/field-decisions.fixture.ts`

**Action — RED:** Two parts. Write both before you hand the Task over.

Part A — add the ten cases named under `## Verify` to the three Proof targets
`src/queries/node/show-node.test.ts`, `src/queries/project/show-project-graph.test.ts` and
`src/http/contract/graph.test.ts`.

Part B — repair the fixtures that publishing the two fields makes stale. A node object that
any of these tests builds or asserts now carries `deliverable` and `verify`. Both are
required members, and `null` is the value for a node that holds neither.

Exact-member assertions — the title states a count, so rename the title too:

- `src/queries/node/show-node.test.ts:83` — `the seeded task returns all twenty members
field by field` → twenty-two. `verifyJson` is not one of them; the view publishes `verify`.
- `src/queries/node/show-node.test.ts:226` — `Object.keys of the view bytewise sorted
deep-equals the twenty member names` → twenty-two.
- `src/queries/project/show-project-graph.test.ts:77` — `nodes carry the seven declared
attributes in bytewise key order` → nine.

Fixture-only repairs — a node literal gains `deliverable: null` and `verify: null`:

- `src/http/server/node/claim-node.test.ts` and `src/http/server/node/release-node.test.ts`
  — the shared full-node fixture. Each file's `a successful call answers 200 with the
contract response shape` parses the body against the contract, so an absent field refuses.
- `src/http/server/project/show-project-graph.test.ts` — the expected node attributes.
- `src/cli/node/claim.test.ts`, `delete.test.ts`, `release.test.ts`, `show.test.ts`,
  `unblock.test.ts`, `update.test.ts`, `src/cli/project/graph.test.ts` and
  `src/cli/reachability.test.ts` — every stubbed daemon response holding a node.
- `src/commands/startup/recover-expired-leases.test.ts` — the same.

Do not change a `src/cli/**` production file to accept a narrower body. The refusal is
correct; the fixture is stale.

**Action — GREEN:** Edit every production file `## Change` names. Two further production
edits follow from the widened schemas, and both are in this lane:

- Every node example literal in `src/http/contract/**` gains `deliverable: null` and
  `verify: null` — including the `node.claim.response` and `node.release.response`
  examples, which reuse the node shape. `src/http/contract/example.test.ts` and
  `scripts/publish-contract.test.ts` both parse every example against its schema.
- `src/http/contract/field-decisions.fixture.ts` gains one row per new field per response
  that publishes it. The file is not a `.test.ts` file, so it is the software-engineer lane
  under `scripts/lane-check.sh`. Every row keeps the fixture's existing sort order and its
  `required=`, `nullable=` and `enum=` format. `deliverable` is
  `required=true nullable=true enum=test,implementation,review,expansion`; `verify` is
  `required=true nullable=true enum=-`, and its two children
  `verify/properties/commands` and `verify/properties/paths` are
  `required=true nullable=false enum=-`.

**Action — REFACTOR:** None.

## Verify

```bash
node --test src/queries/node/show-node.test.ts
node --test src/queries/project/show-project-graph.test.ts
node --test src/http/contract/graph.test.ts
```

### `src/queries/node/show-node.test.ts`

Add cases:

1. `showNode` called with a node that has `deliverable = "test"` and valid `verify_json` returns `deliverable: "test"` and `verify` as the parsed object `{ paths: [...], commands: [...] }`.
2. `showNode` called with a node that has `deliverable = null` and `verify_json = null` returns `deliverable: null` and `verify: null`.
3. `showNode` called with a node whose `verify_json` is `"{"` throws an error with `code === "verify-json-malformed"` (or a `VerifyBlockError`). Assert using `assert.rejects` or `assert.throws`.

### `src/queries/project/show-project-graph.test.ts`

Add cases mirroring the three above, but for `showProjectGraph`:

4. A graph with a node holding `deliverable = "expansion"` and valid `verify_json` returns that node's attributes with `deliverable: "expansion"` and `verify` as the parsed object.
5. A graph with a node holding `deliverable = null` and `verify_json = null` returns `deliverable: null` and `verify: null` in node attributes.
6. A graph with a node whose `verify_json` is `"{"` causes `showProjectGraph` to throw a `VerifyBlockError` with `code === "verify-json-malformed"`.

### `src/http/contract/graph.test.ts`

Add cases:

7. `nodeAttributes.safeParse({ ..., deliverable: "test", verify: { paths: ["a/b.ts"], commands: ["npm test"] } }).success` is `true`.
8. `nodeAttributes.safeParse({ ..., deliverable: null, verify: null }).success` is `true`.
9. `nodeAttributes.safeParse({ ..., deliverable: "invalid", verify: null }).success` is `false`.
10. `nodeShowResponse` accepts `deliverable` and `verify` as nullable fields.

Proof: PASS EPIC-047 line for `src/queries/node/show-node.test.ts`, `src/queries/project/show-project-graph.test.ts`, and `src/http/contract/graph.test.ts`; hermetic coverage — both fields returned for a node that holds them, null for a node that does not, `verify-json-malformed` surfaced for invalid JSON.
