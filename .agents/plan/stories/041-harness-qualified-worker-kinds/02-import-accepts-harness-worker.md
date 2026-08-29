# Story 2 — Import accepts a harness-qualified worker

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`
Depends on: Story 1

## Change

No production file changes. Only test additions in three files.

Each fault is proven at the layer that owns it. `src/domain/plan-document.ts:22` parses `worker`
with `workerKind`, so `swe@1` is `frontmatter-invalid` and never reaches a membership check. A
document therefore cannot produce one `worker-unknown` for `swe@1`. `worker-unknown` names the other
fault: a well-formed kind that the project context omits.

### `src/domain/plan-candidate.test.ts`

**Edit 1 — imports (line 18-19 area).** Add one import after the existing `createPlanGraph` import:

```ts
import { workerKinds } from "./worker.ts";
```

**Edit 2 — new module-level constant (after line 48, before `const candidateFindingCodes`).** Add:

```ts
const harnessFourContext: ValidationContext = {
  workerKinds: [...workerKinds],
  boundRepositories: ["repo_a"],
  knownRepositories: ["repo_a", "repo_b"],
};
```

After Story 1, `[...workerKinds]` spreads all seven kinds. The four harness-qualified kinds are
in this context. `"swe@1"` and `"te@1"` are not.

**Edit 3 — new tests inside `describe("validateCandidate")`, after the existing `worker-unknown`
test at line 711.** Add:

```ts
for (const harnessKind of [
  "claude.swe@1",
  "claude.te@1",
  "opencode.swe@1",
  "opencode.te@1",
] as const) {
  it(`a harness-qualified kind "${harnessKind}" produces an empty finding list`, () => {
    const { submitted, takes } = hierarchy();
    const edited = submitted.map((document) =>
      document.identity === task1
        ? { ...document, worker: harnessKind }
        : document,
    );
    const findings = validateCandidate(
      { findCycles },
      {
        candidate: candidateOf(edited, [], takes),
        context: harnessFourContext,
      },
    );
    assert.deepEqual(findings, []);
  });
}

it("unqualified swe@1 produces exactly one worker-unknown finding", () => {
  const { submitted, takes } = hierarchy();
  const edited = submitted.map((document) =>
    document.identity === task1 ? { ...document, worker: "swe@1" } : document,
  );
  const findings = validateCandidate(
    { findCycles },
    { candidate: candidateOf(edited, [], takes), context: harnessFourContext },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "worker-unknown");
  assert.equal(findings[0]?.id, task1);
  assert.equal(findings[0]?.path, null);
});
```

The existing `hierarchy()` fixture uses `boundRepositories: ["repo_a"]` and `knownRepositories:
["repo_a", "repo_b"]`. `harnessFourContext` carries the same repo sets, so the only difference
from the standard `context` is the `workerKinds` list. No other finding is introduced by the
harness kind change.

### `src/domain/plan-validate.test.ts`

No import changes needed. The module-level `context` at lines 15–19 already uses
`workerKinds: [...workerKinds]`; after Story 1 this spreads all seven kinds. `workerKinds` is
already imported at line 4.

**Edit 1 — new module-level constant, added beside `threeFaultsContext` at line 21.** Add:

```ts
const withoutClaudeSweContext: ValidationContext = {
  ...context,
  workerKinds: workerKinds.filter((kind) => kind !== "claude.swe@1"),
};
```

The filter removes one value and keeps the other six, so the value under test is the only variable.

**Edit 2 — new tests, added after the three-faults test at line 199.**

All documents carry explicit `id:` fields to avoid ID-generation in the mock. The plan structure
passes all validations other than the one under test: no `acceptance-missing` (task body has
`## Acceptance criteria`), no `repo-on-task` (task carries no `repo:`), no repository findings
(`repo_a` is in both `boundRepositories` and `knownRepositories`).

```ts
for (const harnessKind of [
  "claude.swe@1",
  "claude.te@1",
  "opencode.swe@1",
  "opencode.te@1",
] as const) {
  it(`a task naming harness-qualified kind "${harnessKind}" produces an empty finding list`, () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
---
Bootstrap the daemon.
`,
      },
      {
        path: "plan/i--01/o--01/objective.md",
        content: `---
id: objective_01ARZ3NDEKTSV4RRFFQ69G5FAB
kind: objective
title: Harden the verify CLI
repo: repo_a
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Wire the events
worker: ${harnessKind}
---
Emit the events.

## Acceptance criteria

- The events emit.
`,
      },
    ]);
    assert.deepEqual(result.findings, []);
  });
}

it("a task naming claude.swe@1 outside the context produces exactly one worker-unknown finding", () => {
  const result = assertStable(
    [
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
---
Bootstrap the daemon.
`,
      },
      {
        path: "plan/i--01/o--01/objective.md",
        content: `---
id: objective_01ARZ3NDEKTSV4RRFFQ69G5FAB
kind: objective
title: Harden the verify CLI
repo: repo_a
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Wire the events
worker: claude.swe@1
---
Emit the events.

## Acceptance criteria

- The events emit.
`,
      },
    ],
    { context: withoutClaudeSweContext },
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.code, "worker-unknown");
  assert.equal(result.findings[0]?.path, "plan/i--01/o--01/01-a.md");
});
```

`assertStable` defaults to the module-level `context`. After Story 1, that context includes all
seven kinds, so the four harness tests pass through it unchanged. The restricted context is passed
explicitly and omits one value only.

### `src/domain/plan-document.test.ts`

**Edit — new tests, added after the `worker nope@9` test.** Add:

```ts
for (const harnessKind of [
  "claude.swe@1",
  "claude.te@1",
  "opencode.swe@1",
  "opencode.te@1",
] as const) {
  it(`worker ${harnessKind} parses`, () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      worker: harnessKind,
    });
    assert.equal(result.success, true);
  });
}

for (const agentName of ["swe@1", "te@1"] as const) {
  it(`worker ${agentName} is refused with the issue path worker`, () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      worker: agentName,
    });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["worker"]]);
  });
}
```

`issuePaths` already exists at the top of the file. This is the boundary rejection. No plan-level
assertion stands in for it: a refused task document also raises `objective-without-task`, so a
`validateDocuments` test would have to assert two findings to say one thing.

## Constraints

- Do not edit `src/domain/plan-candidate.ts`, `src/domain/plan-validate.ts` or
  `src/domain/plan-document.ts`. `planFrontmatter.worker` stays `workerKind.optional()`.
- Do not write a `validateDocuments` test that names `swe@1`. That value is `frontmatter-invalid`,
  and the document it sits on also raises `objective-without-task`.
- `context: harnessFourContext` must be passed explicitly in the plan-candidate tests; the
  existing module-level `context` has only `workerKinds: ["tdd"]`.
- All documents in the plan-validate tests carry explicit `id:` fields; do not call `assertStable`
  with `options.ulids` for these tests.
- The task document must have `## Acceptance criteria` in the body to avoid `acceptance-missing`.
- The task document must not carry `repo:` to avoid `repo-on-task`.

## Verify

```bash
node --test src/domain/plan-candidate.test.ts src/domain/plan-validate.test.ts src/domain/plan-document.test.ts
```

The four harness-kind plan-candidate tests each produce `findings` deep-equal to `[]`.
The four harness-kind plan-validate tests each produce `result.findings` deep-equal to `[]`.
The plan-candidate `swe@1` test produces exactly one finding with `code === "worker-unknown"`.
The plan-validate `claude.swe@1` test, against `withoutClaudeSweContext`, produces exactly one
finding with `code === "worker-unknown"`.
The plan-document tests parse the four kinds and refuse `swe@1` and `te@1` with the issue path
`worker`.

Proof: delivers `src/domain/plan-candidate.test.ts`, `src/domain/plan-validate.test.ts` and
`src/domain/plan-document.test.ts` lines of `PASS EPIC-041`.
