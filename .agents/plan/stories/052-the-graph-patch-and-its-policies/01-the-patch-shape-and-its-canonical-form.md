# Story 1 — The patch shape and its canonical form

Epic: `.agents/plan/epics/052-the-graph-patch-and-its-policies.md`
Depends on: nothing. It is the first story of the epic, and Stories 2, 3 and 4 read the types it declares.
Kind: story-foundation

This story adds one pure module holding a zod schema, a refusal tuple and a canonical renderer. It
has no caller: EPIC 052.1 Story 2 (`02-an-unparsable-patch-reaches-no-seam`) is where
`graphPatch.safeParse` first runs. It changes no drawn path, so it draws nothing.

## Change

**Create `src/domain/graph-patch.ts`.** One zod schema, one exported refusal tuple, one duplicate-id
verdict and one renderer. Its only imports are `zod` and four `src/domain/` modules, so the module
stays pure.

### 1 — the imports

```ts
import { z } from "zod";

import { deliverable } from "./deliverable.ts";
import { identity, nodeIdentity } from "./identity.ts";
import { nodeKind } from "./state.ts";
import { verifyBlock } from "./verify-block.ts";
```

- `deliverable` is the four-value enum at `src/domain/deliverable.ts:10` — `deliverable`.
- `nodeIdentity` at `src/domain/identity.ts:127` — `nodeIdentity` accepts an `initiative_`,
  `objective_` or `task_` identity and nothing else.
- `identity("repository")` at `src/domain/identity.ts:104` — `identity` builds the repository
  identity schema. It is cached, so calling it at module scope is the shipped use.
- `verifyBlock` at `src/domain/verify-block.ts:26` — `verifyBlock` is `{ paths, commands }`, and its
  `superRefine` at `src/domain/verify-block.ts:31` — `superRefine` already refuses a duplicate path.

### 2 — the three mutation shapes

Each is a `z.strictObject` with a `z.literal` discriminator, matching
`src/http/contract/credential.ts:48` — `providerRegisterRequest`. The field set is the Decisions
table of the epic and nothing else.

```ts
const createMutation = z.strictObject({
  op: z.literal("create"),
  id: nodeIdentity,
  kind: nodeKind,
  deliverable,
  title: z.string(),
  parentId: nodeIdentity.nullable(),
  repositoryId: identity("repository").nullable(),
  verify: verifyBlock,
  instruction: z.string(),
  acceptance: z.string().nullable(),
  dependsOn: z.array(nodeIdentity),
});

export const updateFields = [
  "acceptance",
  "deliverable",
  "dependsOn",
  "instruction",
  "parentId",
  "repositoryId",
  "title",
  "verify",
] as const;

const updateMutation = z.strictObject({
  op: z.literal("update"),
  id: nodeIdentity,
  title: z.string().optional(),
  deliverable: deliverable.optional(),
  verify: verifyBlock.optional(),
  instruction: z.string().optional(),
  acceptance: z.string().nullable().optional(),
  parentId: nodeIdentity.nullable().optional(),
  repositoryId: identity("repository").nullable().optional(),
  dependsOn: z.array(nodeIdentity).optional(),
});

const deleteMutation = z.strictObject({
  op: z.literal("delete"),
  id: nodeIdentity,
});

export const graphMutation = z.discriminatedUnion("op", [
  createMutation,
  updateMutation,
  deleteMutation,
]);

export type GraphMutation = z.infer<typeof graphMutation>;
```

**Every `create` field is required except the four the node row itself makes nullable.** `parentId`
is nullable because an initiative has none — `src/domain/node.ts:56` — `refine` is the row-level
statement of that rule. `repositoryId` is nullable because a task carries none, and `acceptance` is
nullable because `acceptanceBlob` is nullable at `src/domain/plan-graph.ts:10` — `acceptanceBlob`.
`instruction` and `title` are required because `instructionBlob` at
`src/domain/plan-graph.ts:9` — `instructionBlob` and `title` at `src/domain/plan-graph.ts:8` — `title`
are not nullable. `dependsOn` is required and may be empty.

**`deliverable` and `verify` are both required on a `create`.** The epic states that a created child
carries its own `kind`, `deliverable` and `verify`, and
`src/domain/plan-candidate.ts:216` — `verify-invalid` refuses a node that carries a deliverable and no
verify block, so an optional `verify` would only move the refusal.

**Do not put a `create`-versus-`update` field rule anywhere but here.** `updateFields` is exported so
its members are asserted by value, following
`src/domain/node-write-legality.ts:3` — `nodeWriteRefusals`.

### 3 — the patch document, and the one refinement the schema carries

```ts
export const graphPatch = z
  .strictObject({ mutations: z.array(graphMutation) })
  .superRefine((patch, context) => {
    for (const [index, mutation] of patch.mutations.entries()) {
      if (mutation.op !== "update") continue;
      const names = updateFields.some((field) => mutation[field] !== undefined);
      if (!names) {
        context.addIssue({
          code: "custom",
          path: ["mutations", index],
          message: "an update names at least one field beyond id",
        });
      }
    }
  });

export type GraphPatch = z.infer<typeof graphPatch>;
```

**The patch is an object holding one key and not a bare array.** It is stored as standalone evidence
in `checkpoint.patch_blob`, so the document says what it is when a human reads it back, and the
epic's "keys sorted bytewise at every level" then has a top level to govern.

**The at-least-one-field rule lives in the schema, and the duplicate-id rule does not.** A failure
here is a `safeParse` failure, so it becomes `patch-unparsable` at the one call site EPIC 052.1
owns. The duplicate-id rule must stay a separate value, because the epic makes
`patch-id-duplicate` distinct from `patch-unparsable`, and a `superRefine` would fold the two into
one `safeParse` failure. The split follows
`src/domain/verify-block.ts:67` — `decodeVerifyBlock`, where the schema owns one rule and the
renderer beside it owns another.

**The rule is written over `updateFields` and not over `Object.keys(mutation).length`.** A key
present with an `undefined` value survives a zod `strictObject` parse, so a key count admits a
mutation that names a field and sets nothing.

### 4 — the duplicate-id verdict

```ts
export type PatchDuplicateVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; refusal: "patch-id-duplicate"; id: string }>;

export function patchDuplicateVerdict(patch: GraphPatch): PatchDuplicateVerdict;
```

It walks `patch.mutations` in submitted order and returns the **first** id a second mutation names.
The verdict shape is the epic-wide one: `{ ok: true }` or `{ ok: false, refusal, <evidence> }`,
matching `src/domain/execution-acceptance.ts` of EPIC 051.1 Story 6
(`06-the-acceptance-verdicts`) and `src/domain/node-write-legality.ts:30` — `NodeWriteLegality`.

It reports the submitted order and not the canonical order, because the caller reports the id a
human wrote and the renderer never runs on a refused patch.

### 5 — `renderGraphPatch`

```ts
export function renderGraphPatch(patch: GraphPatch): string;
```

It emits `JSON.stringify(document, null, 2) + "\n"`, matching
`src/services/home-lock/identity.ts:3` — `renderIdentity`, which is the shipped two-space,
one-trailing-newline canonical form.

Keys are sorted bytewise **by construction**, not by a generic sorter. The algebra is closed, so the
renderer builds an explicit object literal per `op` with its keys written in bytewise order. This is
the idiom of `src/domain/plan-hash.ts:5` — `canonicalDocumentsJson`, which normalises key order by
destructuring and rebuilding a known shape.

- **The top level** is `{ "mutations": [ … ] }`.
- **`create`** emits, in this order: `acceptance`, `deliverable`, `dependsOn`, `id`, `instruction`,
  `kind`, `op`, `parentId`, `repositoryId`, `title`, `verify`.
- **`update`** emits only the keys the mutation names, in this order: `acceptance`, `deliverable`,
  `dependsOn`, `id`, `instruction`, `op`, `parentId`, `repositoryId`, `title`, `verify`. An absent
  field is **omitted**, never emitted as `null`, because `null` is the value that clears a nullable
  field and an absent field is unchanged.
- **`delete`** emits `id`, then `op`.
- **`verify`** emits `commands`, then `paths`. `paths` is sorted with
  `src/domain/plan-path.ts:106` — `comparePaths`, and `commands` keeps its submitted order, matching
  `src/domain/verify-block.ts:57` — `renderVerifyBlock`. Never call `renderVerifyBlock` here: it
  returns compact JSON and this document is indented.
- **`dependsOn`** is de-duplicated and sorted bytewise, exactly as
  `src/commands/node/create-node.ts:156` — `new Set` and
  `src/commands/node/create-node.ts:157` — `Buffer.compare` do. The in-domain precedent for the same
  comparator is `src/domain/readiness.ts:83` — `Buffer.compare`.
- **The mutation array** is sorted bytewise by `id` with the same comparator. One id appears at most
  once, so the sort is total and needs no tie-break.

## Constraints

- `src/domain/` is pure. This module reads no clock, no file system, no randomness and no
  transaction. Its only vendor import is `zod`.
- **Register none of the new codes on the wire.** `patch-unparsable` and `patch-id-duplicate` stay
  string literals inside this module. `src/http/contract/errors.ts:7` — `errorStatuses` and
  `src/cli/exit-code.ts:13` — `exitCodes` are edited by EPIC 052.1 Story 9
  (`09-the-contract-and-the-proposal`), which is the story that makes the codes reachable over the
  wire. `src/domain/node-write-legality.ts:3` — `nodeWriteRefusals` is the shipped precedent for a
  refusal tuple that no registry holds.
- **Add nothing to `findingCodes`.** `src/domain/plan-finding.ts:44` — `findingScope` is a
  `Record<FindingCode, ValidationScope>`, so a new code there forces a scope row, and
  `src/http/contract/plan-finding.ts:5` — `planFinding` puts `findingCodes` on the wire. These are
  refusals, not findings.
- `renderGraphPatch` never throws. Every rule that could make it throw is already a parse failure:
  a duplicate verify path is refused by
  `src/domain/verify-block.ts:31` — `superRefine`, and a duplicate `dependsOn` entry is
  de-duplicated rather than refused.
- Do not add a recursive key sorter. The three shapes are closed, and a generic sorter would be
  code no case exercises.

## Verify

```
node --test src/domain/graph-patch.test.ts
```

Create `src/domain/graph-patch.test.ts`, suite name `"src/domain/graph-patch.test"`, on `node:test`
with `node:assert/strict`, matching `src/domain/run-exclusion.test.ts:52` — `describe`. It needs no
helper from `test/helpers/`; build every patch as a local literal, on the pattern of
`src/domain/plan-candidate.test.ts:82` — `storedNode`.

Add, each as a separate `it`:

1. `"each of the three operations parses with its full field set and an unknown op is refused"` —
   parse one patch holding one `create` carrying all eleven fields, one `update` carrying all ten,
   and one `delete`, and assert `success === true` and that `result.data.mutations` has length 3.
   Then parse `{ mutations: [{ op: "replace", id: "task_…" }] }` and assert `success === false` and
   that `result.error.issues[0].message` names the union discriminator. Gate row 1.

2. `"an update naming no field beyond id is refused"` — parse
   `{ mutations: [{ op: "update", id: "task_…" }] }` and assert `success === false`, that
   `result.error.issues[0].path` deep-equals `["mutations", 0]`, and that
   `result.error.issues[0].message` equals `"an update names at least one field beyond id"`. Gate
   row 2.

3. `"an update naming exactly one field parses"` — the control for case 2. Parse
   `{ mutations: [{ op: "update", id: "task_…", title: "t" }] }` and assert `success === true`.
   Without it, case 2 passes for a schema that refuses every update.

4. `"updateFields holds the eight fields an update may name"` — assert `updateFields` deep-equals
   `["acceptance", "deliverable", "dependsOn", "instruction", "parentId", "repositoryId", "title", "verify"]`
   and that the array equals its own bytewise sort. This pins the tuple case 2's rule reads, on the
   pattern of `src/domain/node-write-legality.test.ts:33` — `nodeWriteRefusals`.

5. `"a second mutation naming one id refuses patch-id-duplicate, and unparsable bytes refuse patch-unparsable"`
   — in one case: assert `patchDuplicateVerdict` over a patch holding `create` of `task_a` and
   `delete` of `task_a` deep-equals
   `{ ok: false, refusal: "patch-id-duplicate", id: "task_a" }`; and assert
   `graphPatch.safeParse("{").success === false`. The two codes stay distinct because the first is a
   verdict value and the second is a parse failure. Gate row 3.

6. `"a patch naming each id once passes the duplicate verdict"` — the control for case 5. Assert
   `patchDuplicateVerdict` over a patch holding three mutations with three ids deep-equals
   `{ ok: true }`.

7. `"renderGraphPatch emits the exact canonical bytes"` — render a patch holding one `create`, one
   `update` and one `delete`, and assert the whole string deep-equals a literal written as a
   `[…].join("\n")` array whose last member is `""`, on the pattern of
   `src/services/home-lock/identity.test.ts:16` — `renderIdentity`. Assert additionally, in the same
   case, that the output ends with `"\n"` and does not end with `"\n\n"`, that it contains `"\n  "`,
   that it holds no tab, and that no line ends with a space. Gate row 4.

8. `"an update renders only the fields it names"` — render a patch holding one `update` naming
   `title` alone and assert the emitted object holds exactly the keys `id`, `op` and `title`. This is
   the omit-versus-null rule, and without it case 7 passes for a renderer that emits every key.

9. `"two patches whose orders differ render to identical bytes"` — in one case, build two patches
   whose mutations arrive in opposite order, whose `create` object keys are written in two different
   insertion orders, and whose `dependsOn` lists arrive in opposite order with one duplicate in one
   of them, and assert `renderGraphPatch(left) === renderGraphPatch(right)`. Gate row 5.

10. `"the render sorts mutations, dependsOn and verify paths by their own comparator"` — assert the
    rendered bytes of a patch whose ids are `task_c`, `task_a`, `task_b` place `task_a` first; that a
    `dependsOn` list of `["task_z", "task_a", "task_z"]` renders as `["task_a", "task_z"]`; and that
    a `verify.paths` list of `["/b.ts", "/a.ts"]` renders sorted while `verify.commands` of
    `["b", "a"]` renders unsorted. This is the control for case 9: a renderer that discarded every
    list would also make two patches equal.

11. `"a non-ASCII title renders bytewise and round-trips"` — render a patch whose ids sort one way by
    code unit and another way by UTF-8 bytes, and assert the emitted order is the UTF-8 byte order.
    Assert additionally that `graphPatch.safeParse(JSON.parse(rendered)).success === true`.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/graph-patch.test.ts` in `PASS EPIC-052`.
