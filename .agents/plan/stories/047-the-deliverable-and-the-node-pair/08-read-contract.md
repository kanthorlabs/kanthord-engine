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
