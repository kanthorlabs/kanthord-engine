# Story 3 — The query composes the values

Epic: `.agent/plan/epics/027-plan-choice-values.md`
Depends on: Story 1 and Story 2.

**Coupled with Story 2.** The tree is red until this story lands. Run the full gate once, after this story.

> **B1 is resolved: `path` is the canonical path of the submitted document, not the authored path.** The EPIC's D2 and its Verification Gate now say so. `planValidateResponse.documents` is `renderDocumentSet(canonicalNodes, bodies)`, and `renderDocumentSet` builds every path as `canonicalPaths(nodes)` (`src/domain/plan-render.ts:84`), so taking the join map from the same `canonicalPaths(canonicalNodes)` call makes the join true by construction. Nothing in this story is blocked.

## Change

### `src/queries/plan/validate-plan.ts`

**The import.** Line 19 reads `import { differingFields } from "../../domain/plan-diff.ts";`. Replace it with:

```ts
import {
  differingFields,
  storedValues,
  submittedValues,
} from "../../domain/plan-diff.ts";
import type { ChoiceValues } from "../../domain/plan-diff.ts";
```

**The type.** `ChoiceEntry` at lines 43-52 gains `path` and its two branches gain `values`. Replace lines 43-52 in full:

```ts
export type ChoiceBranch = ChoiceLegality & Readonly<{ values: ChoiceValues }>;

export type ChoiceEntry = Readonly<{
  id: string;
  kind: NodeKind;
  presence: Presence;
  state: NodeState | null;
  suggested: Choice;
  fields: readonly DifferingField[];
  path: string | null;
  submitted: ChoiceBranch;
  database: ChoiceBranch;
}>;
```

`ChoiceLegality` is already imported at line 10. Keep that import.

**The join map, hoisted.** `canonicalNodes` is built at lines 269-277, **after** the choice loop. Move that construction verbatim to sit immediately after `storedByIdentity` at line 161, and add the join map beside it:

```ts
const storedByIdentity = new Map(nodes.map((node) => [node.id, node]));
const canonicalNodes = resolved.map((document) => ({
  identity: document.identity,
  kind: document.kind,
  title: document.title,
  parentIdentity: document.parentIdentity,
  dependencies: document.dependencies.filter(
    (dependency) => dependency !== document.identity,
  ),
}));
const submittedPaths = canonicalPaths(canonicalNodes);
```

Delete the original `canonicalNodes` declaration at lines 269-277 — it must exist exactly once. Line 278 keeps `renderDocumentSet(canonicalNodes, bodies)` unchanged and now reads the hoisted binding. `canonicalPaths` is already imported at line 17; add no import.

`canonicalPaths` runs twice per request, once here and once inside `renderDocumentSet`. Both calls are pure domain with no `PlanStore` or `BlobStore` access, so the read count does not move. Do not change `renderDocumentSet` to return its path map.

**The composition.** `verdicts.set(identity, verdict);` is line 220 and the `choices.push({…})` is lines 221-230. Insert the three locals between them, then replace the push. This is the exact composition D4 prescribes:

```ts
verdicts.set(identity, verdict);
const selected = presence === "both" ? fields : null;
const submittedBranchValues =
  document === undefined
    ? {}
    : submittedValues(document, blobHashes.get(identity)!, selected);
const databaseBranchValues =
  node === undefined ? {} : storedValues(node, selected);
choices.push({
  id: identity,
  kind: document?.kind ?? node!.kind,
  presence,
  state,
  suggested: verdict.suggested,
  fields,
  path: submittedPaths.get(identity) ?? null,
  submitted: { ...verdict.submitted, values: submittedBranchValues },
  database: { ...verdict.database, values: databaseBranchValues },
});
```

`path` is `submittedPaths.get(identity) ?? null`, **never `document?.path`**. `document.path` is the authored path and joins to nothing. Every member of `resolved` appears in `canonicalNodes`, so the lookup succeeds for every `both` and `document-only` entry, and misses only for a `database-only` entry, which correctly yields `null`.

- The `choiceVerdict` call at lines 214-219 stays byte-identical. Do not pass it a node, a document or a value.
- `blobHashes.get(identity)!` is safe by construction: line 196 sets it for every `document !== undefined` case, and the `document === undefined` arm never reaches the call.
- `selected` is the only place `presence` decides anything about values. Add no second `presence` branch.
- Add no read, no second loop and no new `PlanStore` or `BlobStore` call.

**Nothing else changes.** `repairedChoices` at lines 247-250 spreads `...entry` and overrides only `suggested`, so `values` and `path` survive it untouched. Do not edit that block. Do not edit `readRepositoryNamesById`, `storedPaths`, `bodies`, `canonicalNodes` or the returned object at lines 283-289.

### `src/commands/plan/import-plan.ts`

**No change.** Its `choiceVerdict` call at lines 320-325 uses only `.submitted` and needs no value. The structurally similar loop at lines 274-330 is not in scope; leave it byte-identical.

### `src/http/server/plan/validate-plan.ts`

**No change.** The handler returns `body: result` at line 32 and forwards the new members without an edit.

## Constraints

- `values` is produced only by `storedValues` and `submittedValues`. Do not inline a second projection in the query.
- The `{}` for a missing side comes from the `document === undefined` and `node === undefined` guards, never from a mode inside either domain function.
- `path` is `submittedPaths.get(identity) ?? null` — the canonical path. A `database-only` entry has no document and carries `null`.
- `canonicalNodes` exists exactly once after the edit. A second declaration is a typecheck failure.
- The hoist moves the `canonicalNodes` block and nothing else. `bodies` at lines 252-268 stays where it is, because `renderDocumentSet` is still called at line 278.
- Do not touch `src/domain/plan-choice.ts` or `src/domain/plan-diff.ts`. Story 1 finished the domain.
- Do not touch `src/http/contract/**`. Story 2 finished the contract.
- `plan.validate` stays a read path. Add no `BlobStore.put` and no write of any kind.
- Add no comment.

## Verify

### `src/queries/plan/validate-plan.test.ts`

The file builds every dependency on real SQLite through `build()` at lines 174-200 and mocks only `ids`. Keep that. `createHash` is already imported at line 3.

Add this helper beside `build()`:

```ts
const sha = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
```

**Amend `expectedChoices` at lines 141-172.** All three entries are `document-only`, so each gains `path`, a complete `submitted.values` and an empty `database.values`.

**The `path` values are the canonical paths, and the file already declares them.** `initiativePath`, `objectivePath` and `taskPath` at lines 43-45 are exactly the paths `expectedDocuments` carries at lines 104-140, so reusing those three constants makes the join hold by construction. Do **not** use `initiativeDocument.path`, `objectiveDocument.path` or `taskDocument.path` — those are the authored paths, `plan/i--01/initiative.md` and its siblings, and they are what this decision rejects.

Replace the three entries with exactly these:

```ts
const expectedChoices = [
  {
    id: `initiative_${U_INITIATIVE}`,
    kind: "initiative",
    presence: "document-only",
    state: null,
    suggested: "submitted",
    fields: [],
    path: initiativePath,
    submitted: {
      legal: true,
      reason: null,
      values: {
        body: {
          instructionBlob: sha("Bootstrap the daemon.\n"),
          acceptanceBlob: null,
        },
        depends_on: [],
        parent: null,
        repo: null,
        title: "Ship kanthord",
        worker: null,
      },
    },
    database: { legal: true, reason: "do not create it", values: {} },
  },
  {
    id: `objective_${U_OBJECTIVE}`,
    kind: "objective",
    presence: "document-only",
    state: null,
    suggested: "submitted",
    fields: [],
    path: objectivePath,
    submitted: {
      legal: true,
      reason: null,
      values: {
        body: {
          instructionBlob: sha("Make it verifiable.\n"),
          acceptanceBlob: null,
        },
        depends_on: [],
        parent: `initiative_${U_INITIATIVE}`,
        repo: "kanthord-verify",
        title: "Harden the verify CLI",
        worker: null,
      },
    },
    database: { legal: true, reason: "do not create it", values: {} },
  },
  {
    id: `task_${U_TASK}`,
    kind: "task",
    presence: "document-only",
    state: null,
    suggested: "submitted",
    fields: [],
    path: taskPath,
    submitted: {
      legal: true,
      reason: null,
      values: {
        body: {
          instructionBlob: sha("Build the renderer.\n\n"),
          acceptanceBlob: sha("## Acceptance criteria\n\n- The bytes match.\n"),
        },
        depends_on: [],
        parent: `objective_${U_OBJECTIVE}`,
        repo: null,
        title: "Render the manifest",
        worker: "tdd@1",
      },
    },
    database: { legal: true, reason: "do not create it", values: {} },
  },
];
```

> **The four body strings above are derived from `src/domain/plan-body.ts`, not guessed.** `normalizeBody` at line 21 strips trailing newlines and appends exactly one. `splitBody` at line 26 cuts at the start of the `## Acceptance criteria` line, so `instruction` is `body.slice(0, headingStart)` and **keeps the blank line before the heading**. The task body normalizes to `Build the renderer.\n\n## Acceptance criteria\n\n- The bytes match.\n`, so its instruction is `Build the renderer.\n\n` — two newlines, not one — and its acceptance is `## Acceptance criteria\n\n- The bytes match.\n`. The initiative and objective bodies carry no heading, so `splitBody` returns the whole body as the instruction and `null` as the acceptance.
>
> If a hash assertion still fails, report the actual strings and stop. **Do not change `src/domain/plan-body.ts`, `src/domain/plan-render.ts` or the production split to make a hash match** — the split is not this epic's decision, and the fixture is what is wrong in that case.

The existing test at line 211 already deep-equals against `expectedChoices`, so this amendment covers the `document-only` case of the presence table. Add the remaining cases.

**A `both` entry naming one field.** Extend the prose-edit test at line 365 (`"a prose edit to the pending task suggests submitted with fields body"`), which seeds the fixture, exports, replaces `"Do the task work."` with `"Do the task work now."` and revalidates. Add to it:

- `entry.fields` deep-equals `["body"]`;
- `Object.keys(entry.submitted.values)` deep-equals `["body"]` and `Object.keys(entry.database.values)` deep-equals `["body"]` — exactly one key on each side;
- `entry.submitted.values.body.instructionBlob` differs from `entry.database.values.body.instructionBlob`;
- `entry.submitted.values.body.acceptanceBlob` equals `entry.database.values.body.acceptanceBlob`, because only the instruction changed;
- `entry.path` equals `taskPath`, the canonical path of the edited task.

**A `both` entry naming `title` only.** Add a test that seeds the fixture, exports, and rewrites only the task document's `title:` frontmatter line to `Harden the verify CLI v2`, then revalidates. Assert:

- `entry.fields` deep-equals `["title"]`;
- `entry.submitted.values` deep-equals `{ title: "Harden the verify CLI v2" }` — exactly one key;
- `entry.database.values` deep-equals `{ title: "Harden the verify CLI" }` — exactly one key.

> **`seedPlanFixture` stores the same title on all three nodes: `Harden the verify CLI`** (`test/helpers/plan.ts`, the initiative, objective and task writes). It is **not** `Render the manifest` — that string belongs to `taskDocument` in this test file, which is the _submitted_ fixture of the unrelated `document-only` tests. Do not mix the two.

**A `database-only` entry.** Extend the test at line 460 (`"a database-only node appears in the choice set"`), which filters the task document out with `!document.content.includes("Do the task work.")`. Add:

- `entry.presence` equals `"database-only"`;
- `entry.fields` deep-equals `[]` — asserted explicitly, because an empty `fields` beside a populated `values` is the fact D1 turns on;
- `entry.submitted.values` deep-equals `{}`;
- `Object.keys(entry.database.values)` deep-equals `["body", "depends_on", "parent", "repo", "title", "worker"]` — all six names;
- `entry.database.values.title` equals `"Harden the verify CLI"` — the title `seedPlanFixture` stored, not `"Render the manifest"`;
- `entry.database.values.worker` is `null`, `entry.database.values.parent` equals `planFixtureIdentities.objective` as `seedPlanFixture` stored it, and `entry.database.values.body.instructionBlob` equals `sha(planFixtureBodies.taskInstruction)`, where `taskInstruction` is `"Do the task work.\n"`. `planFixtureBodies` is already exported from `test/helpers/plan.ts:162`; add it to the import if it is not there;
- `entry.path` is `null`.

**A `both` entry whose `fields` is empty.** The test at line 331 (`"a re-import of the exported documents suggests database everywhere"`) resubmits the exported set unchanged, so every entry is `both` with no difference. Add:

- every entry's `fields` deep-equals `[]`;
- every entry's `submitted.values` deep-equals `{}` and `database.values` deep-equals `{}`;
- every entry's `path` is non-null.

**A `both` entry differing only in acceptance.** Add a test that seeds the fixture, exports, and replaces only the acceptance line `- it works` with `- it works well`, then revalidates. Assert:

- `entry.fields` deep-equals `["body"]`;
- `entry.submitted.values.body.instructionBlob` equals `entry.database.values.body.instructionBlob` — the same hash on both sides;
- `entry.submitted.values.body.acceptanceBlob` differs from `entry.database.values.body.acceptanceBlob`.

**A submitted hash is not in the blob store.** In the prose-edit scenario, after the `validatePlan` call, using the same `blobs` instance:

```ts
assert.equal(blobs.get(entry.submitted.values.body.instructionBlob), null);
assert.notEqual(blobs.get(entry.database.values.body.instructionBlob), null);
```

`BlobStore.get` returns `null` when absent. This is the fact D2's retrieval rule turns on. A later epic that made `plan.validate` write blobs fails here and must amend the decision.

**No extra `PlanStore` read.** Add a counting wrapper local to this test file. It delegates every method to the real store and counts the four read methods the choice loop can reach:

```ts
function countingPlanStore(plan: PlanStore): Readonly<{
  plan: PlanStore;
  counts: Record<string, number>;
}> {
  const counts: Record<string, number> = {
    readValidationContext: 0,
    newestRevision: 0,
    readGraph: 0,
    readContainmentFacts: 0,
    readSubtreeContainmentFacts: 0,
  };
  const wrapped: PlanStore = {
    ...plan,
    readValidationContext(transaction, projectId) {
      counts["readValidationContext"] += 1;
      return plan.readValidationContext(transaction, projectId);
    },
    newestRevision(transaction, projectId) {
      counts["newestRevision"] += 1;
      return plan.newestRevision(transaction, projectId);
    },
    readGraph(transaction, projectId) {
      counts["readGraph"] += 1;
      return plan.readGraph(transaction, projectId);
    },
    readContainmentFacts(transaction, nodeId) {
      counts["readContainmentFacts"] += 1;
      return plan.readContainmentFacts(transaction, nodeId);
    },
    readSubtreeContainmentFacts(transaction, nodeId) {
      counts["readSubtreeContainmentFacts"] += 1;
      return plan.readSubtreeContainmentFacts(transaction, nodeId);
    },
  };
  return { plan: wrapped, counts };
}
```

Run `validatePlan` over `validSubmission` on the registry-only project — the same setup as the test at line 211 — and assert the exact counts:

```ts
assert.deepEqual(counts, {
  readValidationContext: 1,
  newestRevision: 1,
  readGraph: 1,
  readContainmentFacts: 0,
  readSubtreeContainmentFacts: 0,
});
```

The two containment counts are `0` because every entry is `document-only`, so `presence === "both"` is never true and the block at lines 197-212 never runs. These are the counts of the pre-epic tree, and this story adds no call.

**Determinism.** The test at line 653 (`"the whole query is deterministic across two runs with a fresh mock"`) must still pass unmodified, and it now covers `values` and `path` because it compares whole results. Add one assertion to it: `JSON.stringify` of the two runs' `choices` arrays are equal, so key order inside `values` is pinned on the wire.

### `src/http/server/plan/validate-plan.test.ts`

The test at line 131 asserts `planValidateResponse.safeParse(response.body).success` is `true` and already covers the round trip; it needs no edit and turns green with this story.

Add one test that exercises the three presences in one call, through the real koa app. `buildHandlerApp` at lines 99-129 seeds `seedRegistry` only, so this test needs the fixture graph too: build it the same way but also call `seedPlanFixture(storage, plan, blobs)` before `createTestApp`, reusing the same `plan` and `blobs` instances the handler closes over. Add `seedPlanFixture` and `planFixtureIdentities` to the import at lines 9-14.

Then, in one `plan.validate` request, submit a document set built from the exported fixture set by (a) rewriting the **task** document's `title:` line to `Harden the verify CLI v2`, (b) **dropping** the objective document, and (c) **adding** one new document with a path and identity not in the stored graph. The initiative document is resubmitted unchanged.

**The resulting presence counts are two `both`, one `document-only` and one `database-only`.** `seedPlanFixture` stores exactly three nodes, so the edited task and the unchanged initiative are both `both`; the dropped objective is `database-only`; the added document is `document-only`. Assert exactly that:

```ts
const counts = { both: 0, "document-only": 0, "database-only": 0 };
for (const entry of response.body.choices) counts[entry.presence] += 1;
assert.deepEqual(counts, { both: 2, "document-only": 1, "database-only": 1 });
```

Do not assert "exactly one of each" — the fixture cannot produce it.

Then assert:

- `response.status` is `200` and `planValidateResponse.safeParse(response.body).success` is `true`;
- the `both` entry for the task has `fields` deep-equal to `["title"]`, and its two `values` each hold exactly one `title` key, `"Harden the verify CLI v2"` submitted against `"Harden the verify CLI"` stored;
- the `both` entry for the initiative has `fields` deep-equal to `[]` and both `values` deep-equal to `{}`;
- the `document-only` entry's `submitted.values` holds all six names and its `database.values` deep-equals `{}`;
- the `database-only` entry's `database.values` holds all six names, its `submitted.values` deep-equals `{}`, and its `path` is `null`.

Dropping the objective makes the task an orphan, so the response carries findings. That is fine: `plan.validate` answers `200` with findings and still returns the choice set. Do not assert `findings` is empty.

The row-count test at line 188 (`"leaves every row count unchanged for every request in the suite"`) must still pass. It is the standing proof that `plan.validate` writes nothing, and it now also covers the new request.

### Commands

```bash
node --test src/domain/plan-diff.test.ts \
  src/domain/plan-choice.test.ts \
  src/queries/plan/validate-plan.test.ts \
  src/commands/plan/import-plan.test.ts \
  src/http/server/plan/validate-plan.test.ts \
  src/http/contract/graph.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/parity.test.ts && echo "PASS EPIC-027"
npm run verify
```

The publish check, which must remove its own directory. **It runs only from a clean tree — see blocker B3 in `index.md`.** `scripts/publish-contract.ts` calls `releaseVerdict`, and `scripts/release-gate.ts:36` refuses `dirty-tree` **before** it considers `--unreleased`, so this command cannot pass while this story's edits are uncommitted. Run it after the epic's commit, or from a temporary worktree at that commit:

```bash
OUT="$(mktemp -d)"
node scripts/publish-contract.ts --unreleased "$OUT"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import YAML from "yaml";
  const text = readFileSync(process.argv[1] + "/features/plan.yaml", "utf8");
  const doc = YAML.parse(text);
  const json = JSON.stringify(doc);
  for (const needle of ["values", "instructionBlob", "acceptanceBlob", "depends_on"]) {
    if (!json.includes(needle)) throw new Error("features/plan.yaml lacks " + needle);
  }
  const entry = doc.components.schemas["plan.validate.response"].properties.choices.items;
  if (entry.properties.path === undefined) throw new Error("no path member");
  for (const branch of ["submitted", "database"]) {
    if (entry.properties[branch].properties.values === undefined) {
      throw new Error("no values under " + branch);
    }
  }
  console.log("PASS features/plan.yaml");
' "$OUT"
rm -rf "$OUT"
```

`plan.validate.response` **is** the key. `openApiFeatures` groups on the `operationId` prefix and the schema components are named `<operationId>.<slot>`, which `src/http/contract/openapi.test.ts:288` already pins as `"plan.validate.response"`. Assert at that key and nowhere else; do not weaken the check to a bare `json.includes` and do not add an adaptive fallback.

Assertions:

- The `node --test` line prints `PASS EPIC-027`.
- `src/commands/plan/import-plan.test.ts` passes with **no edit**, and `git diff --quiet src/commands/plan/import-plan.ts src/domain/plan-choice.ts` succeeds. This is the D4 boundary, asserted as an absence of change.
- `npm run verify` exits 0.
- `git status --porcelain` lists only `src/queries/plan/validate-plan.ts`, `src/queries/plan/validate-plan.test.ts` and `src/http/server/plan/validate-plan.test.ts` as modified by this story, plus the paths Stories 1 and 2 already changed.

Proof: every line of the `PASS EPIC-027` block. Hermetic coverage bullets 1, 2, 3, 4, 10, 11, 15, 16 and 17 are delivered here, and bullets 5 and 6 gain their query-level case. Bullet 11 is the join, and it is delivered by this story now that B1 is resolved.

### The join, and the authored path it is not

These two tests are the point of the `path` member. Add both.

**Every non-null `path` joins to exactly one document.** Assert it over a response that holds all three presences — reuse the koa test's document set, or run the query directly over the same set:

```ts
it("every non-null choice path names exactly one returned document", () => {
  const result = validatePlan(dependencies, input);
  const paths = new Set(result.documents.map((document) => document.path));
  let joined = 0;
  for (const entry of result.choices) {
    if (entry.path === null) {
      assert.equal(entry.presence, "database-only");
      continue;
    }
    assert.equal(
      result.documents.filter((document) => document.path === entry.path)
        .length,
      1,
      `path ${entry.path} does not name exactly one document`,
    );
    joined += 1;
  }
  assert.equal(joined, paths.size);
  assert.ok(joined > 0);
});
```

The final two assertions matter: they pin that the join is total in both directions, so a `path` that is `null` for every entry cannot pass the test vacuously.

**`path` is not the authored path.** This is the assertion that would have caught the defect, so it is written explicitly:

```ts
it("the choice path is the canonical path and not the authored submitted path", () => {
  const result = validatePlan(dependencies, {
    projectId: fixtureIds.project,
    fromRevision: null,
    documents: validSubmission,
  });
  const entry = result.choices.find(
    (choice) => choice.id === `initiative_${U_INITIATIVE}`,
  )!;
  assert.equal(entry.path, initiativePath);
  assert.notEqual(entry.path, initiativeDocument.path);
  assert.equal(
    result.documents.some(
      (document) => document.path === initiativeDocument.path,
    ),
    false,
  );
});
```

`initiativePath` and `initiativeDocument.path` are different strings in this fixture — `plan/ship-kanthord--01arz3ndektsv4rrffq69g5fav/initiative.md` against `plan/i--01/initiative.md` — so the second and third assertions are real and not tautologies.

Add the same join assertion to the koa test of the previous section, over `response.body`, so the join is proved through the wire and not only in the query.
