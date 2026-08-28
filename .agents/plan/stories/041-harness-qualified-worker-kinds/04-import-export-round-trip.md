# Story 4 — Import/export round-trip for a harness-qualified worker

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`
Depends on: Story 1

## Change

No production file changes. Two test additions in two files.

### `src/commands/plan/import-plan.test.ts`

All constants, helpers, and imports cited below already exist at module scope in
this file.

**Mint-order derivation.** `resolveIdentities` in `src/domain/plan-identity.ts:42`
sorts submitted documents by path before minting. For the three-document submission
below, the sorted order is:

1. `plan/i--01/initiative.md` (alphabetically before `o--01/…`)
2. `plan/i--01/o--01/01-a.md` (`0` < `o` bytewise)
3. `plan/i--01/o--01/objective.md`

Then `src/commands/plan/import-plan.ts:389` mints the revision. No dependency edges
exist (single task, no `depends_on`), so no edge ULIDs are consumed.

Total: four ULIDs, in the order above.

**New module-level constants** (add after the existing ULID constant block, e.g. after
line 123):

```ts
const U_HI = "01ARZ3NDEKTSV4RRFFQ69G5FBF"; // initiative
const U_HT = "01ARZ3NDEKTSV4RRFFQ69G5FBG"; // task (01-a.md, sorted second)
const U_HO = "01ARZ3NDEKTSV4RRFFQ69G5FBH"; // objective
const U_HREV = "01ARZ3NDEKTSV4RRFFQ69G5FBI"; // revision
```

These do not collide with any existing constant in the file (the highest allocated
suffix is `FBE`).

**New submission constant** (add after the ULID constants):

```ts
const harnessSubmission = [
  {
    path: "plan/i--01/initiative.md",
    content: `---
kind: initiative
title: Harness round trip
---
Test harness kind routing.
`,
  },
  {
    path: "plan/i--01/o--01/objective.md",
    content: `---
kind: objective
title: Harness round trip
repo: kanthord-verify
---
Validate the route.
`,
  },
  {
    path: "plan/i--01/o--01/01-a.md",
    content: `---
kind: task
title: Harness round trip
worker: claude.swe@1
---
Do the task.

## Acceptance criteria

- The kind is preserved.
`,
  },
];
```

**Canonical path segments** (derived from the ULID constants and `slug()` in
`src/domain/plan-slug.ts`; "Harness round trip" → "harness-round-trip"):

```
initiative dir : plan/harness-round-trip--01arz3ndektsv4rrffq69g5fbf
objective dir  : plan/harness-round-trip--01arz3ndektsv4rrffq69g5fbf/harness-round-trip--01arz3ndektsv4rrffq69g5fbh
task file      : <objective-dir>/01-harness-round-trip--01arz3ndektsv4rrffq69g5fbg.md
objective file : <objective-dir>/objective.md
initiative file: <initiative-dir>/initiative.md
```

**New expected-documents constant:**

```ts
const harnessExpectedDocuments = [
  {
    path: "plan/harness-round-trip--01arz3ndektsv4rrffq69g5fbf/harness-round-trip--01arz3ndektsv4rrffq69g5fbh/01-harness-round-trip--01arz3ndektsv4rrffq69g5fbg.md",
    content: `---\nid: "task_${U_HT}"\nkind: "task"\ntitle: "Harness round trip"\nworker: "claude.swe@1"\n---\nDo the task.\n\n## Acceptance criteria\n\n- The kind is preserved.\n`,
  },
  {
    path: "plan/harness-round-trip--01arz3ndektsv4rrffq69g5fbf/harness-round-trip--01arz3ndektsv4rrffq69g5fbh/objective.md",
    content: `---\nid: "objective_${U_HO}"\nkind: "objective"\ntitle: "Harness round trip"\nrepo: "kanthord-verify"\n---\nValidate the route.\n`,
  },
  {
    path: "plan/harness-round-trip--01arz3ndektsv4rrffq69g5fbf/initiative.md",
    content: `---\nid: "initiative_${U_HI}"\nkind: "initiative"\ntitle: "Harness round trip"\n---\nTest harness kind routing.\n`,
  },
];
```

Document sort order is bytewise by path: task (`01-` prefix < `o`) < objective
(`objective.md`) < initiative (`i` < `h` in the outer segment is wrong — initiative
uses `initiative.md` at a shallower depth; `harness-round-trip--…/h` < `initiative.md`
at the top level because the objective subdirectory path starts with `h` < `i`).

**New test** — add inside `describe("the round trip")`:

```ts
it("a plan naming claude.swe@1 imports without findings and exports byte-identically", (t) => {
  const fixture = build([U_HI, U_HT, U_HO, U_HREV]);
  t.after(() => fixture.dispose());
  fixture.storage.transact((transaction) => seedRegistry(transaction));

  const result = runImport(fixture, {
    projectId: fixtureIds.project,
    fromRevision: null,
    importId: "imp_harness_swe_041",
    documents: harnessSubmission,
    choices: [],
    validatedRevision: null,
    documentsHash: fixture.blobs.hash(
      encoder.encode(canonicalDocumentsJson(harnessExpectedDocuments)),
    ),
    actor: "human_1",
  });

  assert.deepEqual(result.absent, []);
  assert.deepEqual(result.documents, harnessExpectedDocuments);

  const exported = exportPlan(
    {
      storage: fixture.storage,
      plan: fixture.plan,
      revision: fixture.revision,
    },
    { projectId: fixtureIds.project },
  );

  assert.deepEqual(exported.documents, result.documents);
});
```

### `src/queries/plan/export-plan.test.ts`

The module-level `expectedPaths` and `expectedDocuments` constants are already
defined at lines 22–64 of this file. The `build()` factory is at lines 67–89.

Add one new test inside `describe("src/queries/plan/export-plan.test")`:

```ts
it("preserves worker claude.swe@1 in the exported task document byte-identically", (t) => {
  const fixture = build();
  t.after(() => fixture.dispose());
  seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);

  fixture.storage.transact((transaction) =>
    transaction.run("UPDATE node SET worker = ? WHERE id = ?", [
      "claude.swe@1",
      planFixtureIdentities.task,
    ]),
  );

  const result = exportPlan(
    {
      storage: fixture.storage,
      plan: fixture.plan,
      revision: fixture.revision,
    },
    { projectId: fixtureIds.project },
  );

  assert.deepEqual(result.documents[0], {
    path: expectedPaths.task,
    content: `---\nid: ${JSON.stringify(planFixtureIdentities.task)}\nkind: "task"\ntitle: "Harden the verify CLI"\nworker: "claude.swe@1"\n---\nDo the task work.\n## Acceptance criteria\n- it works\n`,
  });
});
```

`result.documents[0]` is the task because `expectedPaths.task` sorts bytewise before
`expectedPaths.objective` and `expectedPaths.initiative` (the task path has a `01-`
segment, `0` < `h` for objective subdirectory < `i` for initiative).

The `content` literal is derived from `renderDocument` (in `src/domain/plan-render.ts:40`):
header lines joined with `\n`, then `\n`, then `instruction + acceptance`. The
`planFixtureIdentities.task` ID is quoted by `quoteScalar`, which for a plain ASCII
string is identical to `JSON.stringify`.

## Constraints

- Do not edit any production file.
- The `harnessSubmission` documents carry no explicit `id:` field; IDs are minted
  by `validateDocuments` in the mint order stated above.
- `importId: "imp_harness_swe_041"` must not collide with any existing importId in
  the file (`"imp_roundtrip"` and similar are the existing ones).
- The SQL UPDATE in the export test targets `planFixtureIdentities.task` directly;
  do not add extra seed helpers.

## Verify

```bash
node --test src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts
```

The import test asserts `result.absent` is `[]` and `exported.documents` deep-equals
`result.documents`. The export test asserts the task document content is the exact
string above with `worker: "claude.swe@1"`.

Proof: delivers `src/commands/plan/import-plan.test.ts` and
`src/queries/plan/export-plan.test.ts` lines of `PASS EPIC-041`.
