# Story 2 — Import accepts a harness-qualified worker

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`
Depends on: Story 1

## Change

No production file changes. Only test additions in two files.

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

No import or constant changes needed. The module-level `context` at lines 15–19 already uses
`workerKinds: [...workerKinds]`; after Story 1 this spreads all seven kinds.

**Edit — new tests, added after the three-faults test at line 199.**

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

it("a task naming unqualified swe@1 produces exactly one worker-unknown finding", () => {
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
worker: swe@1
---
Emit the events.

## Acceptance criteria

- The events emit.
`,
    },
  ]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.code, "worker-unknown");
  assert.equal(result.findings[0]?.path, "plan/i--01/o--01/01-a.md");
});
```

`assertStable` defaults to the module-level `context`. After Story 1, that context includes all
seven kinds, so only `swe@1` (unqualified) triggers `worker-unknown`.

## Constraints

- Do not edit `src/domain/plan-candidate.ts` or `src/domain/plan-validate.ts`.
- `context: harnessFourContext` must be passed explicitly in the plan-candidate tests; the
  existing module-level `context` has only `workerKinds: ["tdd"]`.
- All documents in the plan-validate tests carry explicit `id:` fields; do not call `assertStable`
  with `options.ulids` for these tests.
- The task document must have `## Acceptance criteria` in the body to avoid `acceptance-missing`.
- The task document must not carry `repo:` to avoid `repo-on-task`.

## Verify

```bash
node --test src/domain/plan-candidate.test.ts src/domain/plan-validate.test.ts
```

The four harness-kind plan-candidate tests each produce `findings` deep-equal to `[]`.
The four harness-kind plan-validate tests each produce `result.findings` deep-equal to `[]`.
Each `swe@1` test produces exactly one finding with `code === "worker-unknown"`.

Proof: delivers `src/domain/plan-candidate.test.ts` and `src/domain/plan-validate.test.ts`
lines of `PASS EPIC-041`.
