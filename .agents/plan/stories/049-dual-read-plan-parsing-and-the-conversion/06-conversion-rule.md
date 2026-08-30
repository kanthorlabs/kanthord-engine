# Story 6 — Conversion rule

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Story 1 (`ParsedDocument` shape, including `derivedParentPath: string | null` at `src/domain/plan-document.ts:46`), EPIC 047 (`VerifyBlock` from `src/domain/verify-block.ts`, `Deliverable` from `src/domain/deliverable.ts`)

## Change

**Create `src/domain/plan-conversion.ts`** (greenfield)

Export the following in order:

**`manualReasons`** — exported `readonly` tuple of six elements in alphabetic order:

```ts
export const manualReasons = [
  "command-failed",
  "input-ambiguous",
  "input-missing",
  "template-missing",
  "test-dependency-ambiguous",
  "test-dependency-missing",
] as const;

export type ManualReason = (typeof manualReasons)[number];
```

**`ConversionInput`** — type for a single parsed document entry, constructed from `ParsedDocument`:

```ts
export type ConversionInput = Readonly<{
  path: string;
  kind: NodeKind;
  worker: string | null;
  deliverable: Deliverable | null;
  verify: VerifyBlock | null;
  body: string;
  dependsOn: readonly string[];
  repo: string | null;
  derivedParentPath: string | null;
  identity: string | null;
  title: string;
  instruction: string;
  acceptance: string | null;
}>;
```

**`ConversionTemplates`** — type for the repository-to-template-string map:

```ts
export type ConversionTemplates = ReadonlyMap<string, string>;
```

**`ConvertedNode`** — type for one output node, carrying every field the renderer and the runner need:

```ts
export type ConvertedNode = Readonly<{
  sourcePath: string;
  identity: string | null;
  kind: NodeKind;
  title: string;
  dependsOn: readonly string[];
  repo: string | null;
  instruction: string;
  acceptance: string | null;
  deliverable: Deliverable | null;
  verify: VerifyBlock;
  resolvedRepository: string | null;
  pendingCommand: string | null;
  manualReasons: readonly ManualReason[];
}>;
```

`resolvedRepository` is the `repo` field of the nearest `objective` ancestor resolved by walking `derivedParentPath` upward; it is `null` when no objective ancestor with a `repo` field is found. `pendingCommand` carries the raw command string `C` that `applyTemplate` produced for `test` and `implementation` nodes; it is `null` for all other nodes.

**`ConversionResult`** — type for the full result:

```ts
export type ConversionResult = Readonly<{
  nodes: readonly ConvertedNode[];
}>;
```

**`convertDocumentSet`** — pure function. Signature:

```ts
export function convertDocumentSet(
  documents: readonly ConversionInput[],
  templates: ConversionTemplates,
): ConversionResult;
```

**Algorithm — two-pass, index-driven:**

Build an index: `Map<string, ConversionInput>` keyed by `path`, from the full `documents` array.

**Pass 1** — iterate `documents` in input order, processing every document that is NOT an `implementation` node (i.e., every document that does not have `worker === "claude.swe@1"` with `deliverable === null`). Apply the following rules in order per document:

1. If `kind === "initiative"` or `kind === "objective"`: set `deliverable: "expansion"`, `verify: { paths: [], commands: [] }`, `resolvedRepository: null`, `pendingCommand: null`, `manualReasons: []`.

2. If `worker === "claude.te@1"`: proceed as a `test` node (rule 6 below).

**Rule 6 — for a `test` node:**

6a. Parse the `**Input:**` line from `body`. Pattern: `^\\*\\*Input:\\*\\* (.+)$` (multiline). Zero matches → `deliverable: "test"`, `verify: { paths: [], commands: [] }`, `manualReasons: ["input-missing"]`, `resolvedRepository: null`, `pendingCommand: null`. Stop. Two or more matches → `deliverable: "test"`, `verify: { paths: [], commands: [] }`, `manualReasons: ["input-ambiguous"]`, `resolvedRepository: null`, `pendingCommand: null`. Stop. Exactly one match → `verifyPath = match[1].trim()`.

6b. Resolve the repository: walk `derivedParentPath` upward through the index until a `ConversionInput` with `kind === "objective"` is found. The first such objective's `repo` field is `resolvedRepository`. If the walk terminates with no objective found, or the found objective has `repo === null`: set `deliverable: "test"`, `verify: { paths: [], commands: [] }`, `manualReasons: ["template-missing"]`, `resolvedRepository: null`, `pendingCommand: null`. Stop. The `dependsOn` field is a sibling dependency edge and is never walked for ancestry; only `derivedParentPath` is walked.

6c. Look up `resolvedRepository` in `templates`. If not found: set `deliverable: "test"`, `verify: { paths: [], commands: [] }`, `manualReasons: ["template-missing"]`, `resolvedRepository`, `pendingCommand: null`. Stop.

6d. Compute `C = applyTemplate(templateString, verifyPath)` (Story 7). Set `deliverable: "test"`, `verify: { paths: [verifyPath], commands: [] }`, `manualReasons: []`, `resolvedRepository`, `pendingCommand: C`.

Store each pass-1 result in a `Map<string, ConvertedNode>` keyed by `sourcePath` (the pass-1 index).

**Pass 2** — iterate `documents` in input order, processing only `implementation` documents (`worker === "claude.swe@1"` and `deliverable === null`). For each:

7a. Find every `ConversionInput` in `documents` whose `path` is in `this.dependsOn` and whose pass-1 result has `deliverable === "test"`. Collect those pass-1 results.

7b. Zero such results → `deliverable: "implementation"`, `verify: { paths: [], commands: [] }`, `manualReasons: ["test-dependency-missing"]`, `resolvedRepository: null`, `pendingCommand: null`. Stop.

7c. Two or more such results → `deliverable: "implementation"`, `verify: { paths: [], commands: [] }`, `manualReasons: ["test-dependency-ambiguous"]`, `resolvedRepository: null`, `pendingCommand: null`. Stop.

7d. Exactly one such result (the test node): copy `verify.paths` from that test node's result. Set `deliverable: "implementation"`, `verify: { paths: testNode.verify.paths, commands: [] }`, `manualReasons: []`, `resolvedRepository: testNode.resolvedRepository`, `pendingCommand: testNode.pendingCommand`.

Resolve the ancestry for `implementation` nodes the same way as for `test` nodes (walk `derivedParentPath` upward), but only to set `resolvedRepository` on the node itself — the rule above for copying `resolvedRepository` from the test node satisfies Story 9's need to look up the repository for the implementation node's run. If the test node's `resolvedRepository` is `null`, `resolvedRepository` is `null`.

**Output:** collect all pass-1 and pass-2 results. Sort by `sourcePath` using `comparePaths` (import from `"./plan-path.ts"`). Return `{ nodes: sorted }`.

**`renderConvertReport`** — function. Signature:

```ts
export function renderConvertReport(report: ConversionResult): string;
```

Emits canonical JSON: `JSON.stringify(shape, null, 2) + "\n"` where `shape` is built as follows:

- Top-level key: `"nodes"`, value: array of node objects sorted by `sourcePath` using `comparePaths`.
- Each node object projects four keys only, in bytewise order: `"deliverable"`, `"manualReasons"`, `"pendingCommand"`, `"sourcePath"`, `"verify"`. Note: `"pendingCommand"` sorts bytewise before `"sourcePath"` ("p" < "s"). The fields `identity`, `kind`, `title`, `dependsOn`, `repo`, `instruction`, `acceptance`, and `resolvedRepository` are not emitted in the report.
- Within `verify`: keys in bytewise order: `"commands"`, `"paths"`.
- `"manualReasons"` array sorted by index of each reason in `manualReasons` tuple.

The file ends with exactly one `\n`.

## Constraints

- `convertDocumentSet` is pure. No file system, no subprocess, no clock.
- The `kind === "objective"` rule (→ `expansion`) applies to every objective, including atomic objectives that hold no task children.
- `kind === "initiative"` always → `expansion`. There is no exception.
- `manualReasons` has exactly six elements. The tuple is the authoritative count.
- No document reaching `convertDocumentSet` carries a `worker` value outside `["claude.te@1", "claude.swe@1"]`. The CLI validates this before calling the function and refuses with `worker-unmapped`. `convertDocumentSet` does not handle an unmapped `worker` value.
- The result order is independent of input order: pass 1 and pass 2 each iterate `documents` in input order for processing, but the final `nodes` array sorts by `comparePaths`. A test submits the same set in two different orders and asserts deep equality.
- The ancestor walk uses `derivedParentPath`, not `dependsOn`. `dependsOn` is a sibling dependency edge; walking it would inherit a repository from an unrelated node.

## Verify

```
node --test src/domain/plan-conversion.test.ts
```

Create `src/domain/plan-conversion.test.ts` with suite name `"src/domain/plan-conversion.test"`. Use `node:test` and `node:assert/strict`.

Assert the following (each as a separate `it` block):

1. `"manualReasons equals the pinned tuple in alphabetic order"` — `assert.deepEqual(manualReasons, ["command-failed", "input-ambiguous", "input-missing", "template-missing", "test-dependency-ambiguous", "test-dependency-missing"])`.

2. `"a task with worker claude.te@1 converts to deliverable test"` — single task document, `worker: "claude.te@1"`, body contains `**Input:** src/foo.ts`. Assert `result.nodes[0].deliverable === "test"` and `result.nodes[0].verify.paths` deep-equals `["src/foo.ts"]`.

3. `"a task with worker claude.swe@1 converts to deliverable implementation"` — submit a set with a test node (worker `claude.te@1`, body `**Input:** src/bar.ts`, `derivedParentPath` pointing to an objective with `repo: "kanthord-apps"`) and an implementation node (worker `claude.swe@1`, `dependsOn` the test node's path, same `derivedParentPath` chain). Assert `result.nodes` contains one `implementation` node with `verify.paths` deep-equals `["src/bar.ts"]`.

4. `"every objective converts to expansion unconditionally"` — two objectives: one with a task child (another document in `documents` whose `derivedParentPath` is the objective's path), one with none. Assert both have `deliverable === "expansion"`.

5. `"an initiative converts to expansion"` — one initiative. Assert `deliverable === "expansion"`.

6. `"an initiative and an objective take paths [] and commands []"` — assert `verify.paths.length === 0` and `verify.commands.length === 0` for both kinds.

7. `"a task inherits its repository from its objective ancestor through derivedParentPath"` — tree: initiative (path `"00-init.md"`, `derivedParentPath: null`) → objective (path `"01-obj.md"`, `derivedParentPath: "00-init.md"`, `repo: "kanthord-apps"`) → task (path `"01-01-task.md"`, `derivedParentPath: "01-obj.md"`, worker `claude.te@1`, body `**Input:** src/x.ts`). Provide `templates: new Map([["kanthord-apps", "node --test {path}"]])`. Assert the task's `resolvedRepository === "kanthord-apps"`.

8. `"a depends_on edge to a node under a different objective does not change the resolved repository"` — tree: objective A (path `"a/obj.md"`, `repo: "repo-a"`) → task-A (path `"a/task.md"`, `derivedParentPath: "a/obj.md"`, worker `claude.te@1`, body `**Input:** src/a.ts`); objective B (path `"b/obj.md"`, `repo: "repo-b"`) → impl-B (path `"b/impl.md"`, `derivedParentPath: "b/obj.md"`, worker `claude.swe@1`, `dependsOn: ["a/task.md"]`). Provide `templates: new Map([["repo-a", "node --test {path}"], ["repo-b", "node --test {path}"]])`. Assert `impl-B`'s `resolvedRepository === "repo-b"` (from its own objective ancestor B, not from the depends_on target under A).

9. `"the same document set in two different input orders produces deep-equal ConversionResult"` — construct a set containing a test node, an implementation node that depends on the test, and an objective ancestor. Submit in order [test, impl] and then in order [impl, test, objective] (implementation before test dependency). Assert `assert.deepEqual(result1, result2)`.

10. `"an implementation node with two test dependencies reaches test-dependency-ambiguous"` — one implementation node depends on two test nodes. Assert `manualReasons` deep-equals `["test-dependency-ambiguous"]`.

11. `"renderConvertReport emits canonical JSON byte-exact against a literal"` — build a `ConversionResult` with one `ConvertedNode` (fields: `sourcePath: "src/foo.md"`, `identity: null`, `kind: "task"`, `title: "Foo test"`, `dependsOn: []`, `repo: null`, `instruction: ""`, `acceptance: null`, `deliverable: "test"`, `verify: { paths: ["src/foo.ts"], commands: ["! node --test src/foo.test.ts"] }`, `resolvedRepository: "kanthord-apps"`, `pendingCommand: "node --test src/foo.test.ts"`, `manualReasons: []`). Assert the output equals:

    ```json
    {
      "nodes": [
        {
          "deliverable": "test",
          "manualReasons": [],
          "pendingCommand": "node --test src/foo.test.ts",
          "sourcePath": "src/foo.md",
          "verify": {
            "commands": ["! node --test src/foo.test.ts"],
            "paths": ["src/foo.ts"]
          }
        }
      ]
    }
    ```

    (with one trailing newline; assert byte-exact with `assert.equal`).

12. `"a test node body with no **Input:** line reaches manual with input-missing"` — single task document, `worker: "claude.te@1"`, body contains no `**Input:**` line (e.g., body is `"No input here.\n"`), with a valid objective ancestor and template. Assert `result.nodes[0].manualReasons` deep-equals `["input-missing"]` with `assert.deepEqual`. Assert `result.nodes[0].verify.paths` deep-equals `[]`.

13. `"a test node body with two **Input:** lines reaches manual with input-ambiguous"` — single task document, `worker: "claude.te@1"`, body contains two `**Input:** src/a.ts` and `**Input:** src/b.ts` lines, with a valid objective ancestor and template. Assert `result.nodes[0].manualReasons` deep-equals `["input-ambiguous"]` with `assert.deepEqual`.

14. `"an implementation node with no test dependency reaches manual with test-dependency-missing"` — one implementation node (`worker: "claude.swe@1"`, `dependsOn: []`). Assert `result.nodes[0].manualReasons` deep-equals `["test-dependency-missing"]` with `assert.deepEqual`.

Each of the six `manualReasons` is produced by exactly one named case: `command-failed` — Story 9 test 10 (hermetic runner); `input-ambiguous` — case 13 above; `input-missing` — case 12 above; `template-missing` — covered by case 7 when no template entry exists for `resolvedRepository`; `test-dependency-ambiguous` — case 10; `test-dependency-missing` — case 14. Assert each by `assert.deepEqual` on the `manualReasons` array, not by substring search in the test source.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/domain/plan-conversion.test.ts` in `PASS EPIC-049`.
