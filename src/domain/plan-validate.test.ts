import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { workerKinds } from "./worker.ts";
import type { ValidationContext } from "./plan-graph.ts";
import { findingScope } from "./plan-finding.ts";
import {
  validateDocuments,
  type CycleFinder,
  type ValidationResult,
} from "./plan-validate.ts";
import { createPlanReader, createPlanGraph } from "../../test/helpers/plan.ts";
import { createMockIdGenerator } from "../../test/helpers/ids.ts";

const context: ValidationContext = {
  workerKinds: [...workerKinds],
  boundRepositories: ["repo_a"],
  knownRepositories: ["repo_a", "repo_b"],
};

const withoutClaudeSweContext: ValidationContext = {
  ...context,
  workerKinds: workerKinds.filter((kind) => kind !== "claude.swe@1"),
};

const threeFaultsContext: ValidationContext = {
  workerKinds: ["general@1", "tdd@1"],
  boundRepositories: ["repo_a"],
  knownRepositories: ["repo_a", "repo_b"],
};

type SubmittedDocument = Readonly<{ path: string; content: string }>;

function makeDependencies(ulids: readonly string[] = []) {
  return {
    readFrontmatter: (text: string) => createPlanReader().read(text),
    findCycles: (input: Parameters<CycleFinder>[0]) =>
      createPlanGraph().cycles(input),
    mint: createMockIdGenerator({ ulids }).mint,
  };
}

function assertStable(
  submitted: readonly SubmittedDocument[],
  options: Readonly<{
    ulids?: readonly string[];
    context?: ValidationContext;
  }> = {},
): ValidationResult {
  const usedContext = options.context ?? context;
  const run = (order: readonly SubmittedDocument[]) =>
    validateDocuments(makeDependencies(options.ulids ?? []), {
      submitted: order,
      context: usedContext,
      databaseIdentities: [],
      databasePaths: new Map<string, string>(),
    });
  const forward = run(submitted);
  assert.deepEqual(run(submitted), forward, "a second run must be identical");
  assert.deepEqual(
    run([...submitted].reverse()),
    forward,
    "a reversed submission must be identical",
  );
  return forward;
}

describe("src/domain/plan-validate.test", () => {
  it("a valid two-objective plan produces no finding", () => {
    const result = assertStable(
      [
        {
          path: "plan/i--01/initiative.md",
          content: `---
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
---
Bootstrap the daemon.
`,
        },
        {
          path: "plan/i--01/o--01/objective.md",
          content: `---
kind: objective
title: Harden the verify CLI
deliverable: expansion
verify:
  paths: []
  commands: []
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
title: Render the manifest
worker: tdd@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
        },
        {
          path: "plan/i--01/o--01/02-b.md",
          content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAE
kind: task
title: Wire the events
worker: tdd@1
depends_on:
  - 01-a.md
---
Emit the events.

## Acceptance criteria

- The events emit.
`,
        },
        {
          path: "plan/i--01/o--02/objective.md",
          content: `---
kind: objective
title: Harden the graph
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it fast.
`,
        },
        {
          path: "plan/i--01/o--02/01-c.md",
          content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAF
kind: task
title: Verify the orders
worker: general@1
---
Check the orders.

## Acceptance criteria

- The orders are stable.
`,
        },
      ],
      {
        ulids: [
          "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          "01ARZ3NDEKTSV4RRFFQ69G5FAB",
          "01ARZ3NDEKTSV4RRFFQ69G5FAC",
        ],
      },
    );
    assert.deepEqual(result.findings, []);
    assert.equal(result.documents.length, 6);
  });

  it("one document with three faults returns three findings", () => {
    const result = assertStable(
      [
        {
          path: "plan/i--01/initiative.md",
          content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it verifiable.
`,
        },
        {
          path: "plan/i--01/o--01/01-a.md",
          content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: Faulty task
repo: repo_a
worker: git@1
---
Do it.
`,
        },
      ],
      { context: threeFaultsContext },
    );
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["acceptance-missing", "repo-on-task", "worker-unknown"],
    );
  });

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
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
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

  it("two documents each with one fault return two findings ordered by path", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: First task
worker: general@1
---
Do it.
`,
      },
      {
        path: "plan/i--01/o--01/02-b.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Second task
worker: general@1
---
Do it.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["acceptance-missing", "acceptance-missing"],
    );
    assert.deepEqual(
      result.findings.map((finding) => finding.path),
      ["plan/i--01/o--01/01-a.md", "plan/i--01/o--01/02-b.md"],
    );
  });

  it("a path outside the grammar is path-invalid carrying the submitted code", () => {
    const result = assertStable([
      {
        path: "plan/x.md",
        content: `---
kind: task
title: Bad
---
Work.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["path-invalid"],
    );
    assert.match(result.findings[0]!.message, /path-kind-mismatch/);
  });

  it("a duplicate path yields one path-duplicate and no documents", () => {
    const content = `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Duplicated
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`;
    const result = assertStable([
      { path: "plan/i--01/o--01/01-a.md", content },
      { path: "plan/i--01/o--01/01-a.md", content },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["path-duplicate"],
    );
    assert.deepEqual(result.documents, []);
  });

  it("an unparsable frontmatter is document-unparsable carrying the document code", () => {
    const result = assertStable([
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
kind: task
title: Broken
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["document-unparsable"],
    );
    assert.match(result.findings[0]!.message, /document-frontmatter-missing/);
  });

  it("an unknown frontmatter key is frontmatter-invalid", () => {
    const result = assertStable([
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
kind: task
title: Bad
worker: general@1
status: done
---
Work.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["frontmatter-invalid"],
    );
    assert.ok(result.findings[0]!.message.includes("status"));
  });

  it("a task with deliverable expansion raises exactly one pair-illegal finding", () => {
    const result = assertStable([
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Bad pair
deliverable: expansion
verify:
  paths: []
  commands: []
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.equal(
      result.findings.filter((finding) => finding.code === "pair-illegal")
        .length,
      1,
    );
    assert.equal(
      result.findings.filter((finding) => finding.code === "verify-invalid")
        .length,
      0,
    );
  });

  it("an initiative with deliverable implementation raises exactly one pair-illegal finding", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Bad pair
deliverable: implementation
verify:
  paths: []
  commands: []
---
Work.
`,
      },
    ]);
    assert.equal(
      result.findings.filter((finding) => finding.code === "pair-illegal")
        .length,
      1,
    );
  });

  it("a verify block with an absolute path raises no finding", () => {
    const result = assertStable([
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Absolute verify path
deliverable: test
verify:
  paths:
    - /abs/path
  commands: []
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.equal(
      result.findings.filter((finding) => finding.code === "verify-invalid")
        .length,
      0,
    );
    assert.equal(
      result.findings.filter((finding) => finding.code === "pair-illegal")
        .length,
      0,
    );
  });

  it("a submitted verify block with duplicate paths is frontmatter-invalid", () => {
    const path = "plan/i--01/o--01/01-a.md";
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Initiative
deliverable: expansion
verify:
  paths: []
  commands: []
---
Work.
`,
      },
      {
        path: "plan/i--01/o--01/objective.md",
        content: `---
id: objective_01ARZ3NDEKTSV4RRFFQ69G5FAB
kind: objective
title: Objective
deliverable: expansion
repo: repo_a
verify:
  paths: []
  commands: []
---
Work.
`,
      },
      {
        path,
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: Duplicate verify path
deliverable: test
verify:
  paths:
    - /src/foo.ts
    - /src/foo.ts
  commands: []
---
Work.

## Acceptance criteria

- Done.
`,
      },
      {
        path: "plan/i--01/o--01/02-b.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Valid sibling task
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.code, "frontmatter-invalid");
    assert.equal(result.findings[0]?.path, path);
  });

  it("a legacy document with worker only raises neither pair-illegal nor verify-invalid", () => {
    const result = assertStable([
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Legacy task
worker: claude.swe@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.equal(
      result.findings.filter((finding) => finding.code === "pair-illegal")
        .length,
      0,
    );
    assert.equal(
      result.findings.filter((finding) => finding.code === "verify-invalid")
        .length,
      0,
    );
  });

  it("an objective with an acceptance section is acceptance-unexpected", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it verifiable.

## Acceptance criteria

- It is verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: Render the manifest
worker: general@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["acceptance-unexpected"],
    );
  });

  it("a duplicated acceptance heading is acceptance-heading-duplicated", () => {
    const result = assertStable([
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Twice
worker: general@1
---
One.

## Acceptance criteria

- First.

## Acceptance criteria

- Second.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["acceptance-heading-duplicated"],
    );
  });

  it("an acceptance heading with trailing spaces is acceptance-heading-not-at-line-start", () => {
    const result = assertStable([
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Spacey
worker: general@1
---
One.

## Acceptance criteria 

- First.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["acceptance-heading-not-at-line-start"],
    );
  });

  it("a task depending on itself is dependency-self with no dependency-cycle", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
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
title: Selfish task
worker: general@1
depends_on:
  - task_01ARZ3NDEKTSV4RRFFQ69G5FAD
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["dependency-self"],
    );
  });

  it("a task depending on a task in another objective is dependency-cross-parent", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-b.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Crosser
worker: general@1
depends_on:
  - ../o--02/01-c.md
---
Work.

## Acceptance criteria

- Done.
`,
      },
      {
        path: "plan/i--01/o--02/objective.md",
        content: `---
id: objective_01ARZ3NDEKTSV4RRFFQ69G5FAE
kind: objective
title: Harden the graph
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it fast.
`,
      },
      {
        path: "plan/i--01/o--02/01-c.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAF
kind: task
title: Target task
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["dependency-cross-parent"],
    );
  });

  it("two tasks depending on each other form one dependency-cycle", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
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
title: First task
worker: general@1
depends_on:
  - task_01ARZ3NDEKTSV4RRFFQ69G5FAE
---
Work.

## Acceptance criteria

- Done.
`,
      },
      {
        path: "plan/i--01/o--01/02-b.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAE
kind: task
title: Second task
worker: general@1
depends_on:
  - task_01ARZ3NDEKTSV4RRFFQ69G5FAD
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["dependency-cycle"],
    );
    assert.equal(
      result.findings[0]!.message,
      "task_01ARZ3NDEKTSV4RRFFQ69G5FAD -> task_01ARZ3NDEKTSV4RRFFQ69G5FAE",
    );
    assert.equal(result.findings[0]!.id, "task_01ARZ3NDEKTSV4RRFFQ69G5FAD");
  });

  it("a three-node cycle yields one dependency-cycle, not three", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
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
title: First task
worker: general@1
depends_on:
  - task_01ARZ3NDEKTSV4RRFFQ69G5FAE
---
Work.

## Acceptance criteria

- Done.
`,
      },
      {
        path: "plan/i--01/o--01/02-b.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAE
kind: task
title: Second task
worker: general@1
depends_on:
  - task_01ARZ3NDEKTSV4RRFFQ69G5FAF
---
Work.

## Acceptance criteria

- Done.
`,
      },
      {
        path: "plan/i--01/o--01/03-c.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAF
kind: task
title: Third task
worker: general@1
depends_on:
  - task_01ARZ3NDEKTSV4RRFFQ69G5FAD
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["dependency-cycle"],
    );
    assert.equal(
      result.findings[0]!.message,
      "task_01ARZ3NDEKTSV4RRFFQ69G5FAD -> task_01ARZ3NDEKTSV4RRFFQ69G5FAE -> task_01ARZ3NDEKTSV4RRFFQ69G5FAF",
    );
  });

  it("an authored id that is not an identity is identity-invalid", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_nope
kind: task
title: Broken identity
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["identity-invalid"],
    );
  });

  it("an id whose kind does not match its path is identity-kind-mismatch", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: objective_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: Mismatched identity
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["identity-kind-mismatch"],
    );
  });

  it("the same identity on two documents is identity-duplicate", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: First task
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
      {
        path: "plan/i--01/o--01/02-b.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: Second task
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["identity-duplicate"],
    );
  });

  it("a path reference that resolves nowhere is reference-unresolved", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
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
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: Lost reference
worker: general@1
depends_on:
  - ../nope.md
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["reference-unresolved"],
    );
  });

  it("an objective naming a known but unbound repository is repository-unbound", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
---
Bootstrap the daemon.
`,
      },
      {
        path: "plan/i--01/o--01/objective.md",
        content: `---
id: objective_01ARZ3NDEKTSV4RRFFQ69G5FAB
kind: objective
title: Unbound objective
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_b
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: First task
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["repository-unbound"],
    );
  });

  it("an objective naming an unknown repository is repository-unknown", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Ship kanthord
deliverable: expansion
verify:
  paths: []
  commands: []
---
Bootstrap the daemon.
`,
      },
      {
        path: "plan/i--01/o--01/objective.md",
        content: `---
id: objective_01ARZ3NDEKTSV4RRFFQ69G5FAB
kind: objective
title: Unknown objective
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_missing
---
Make it verifiable.
`,
      },
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: task
title: First task
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["repository-unknown"],
    );
  });

  it("a plan holding both containment faults yields both findings", () => {
    const result = assertStable([
      {
        path: "plan/i--01/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAA
kind: initiative
title: Empty initiative
deliverable: expansion
verify:
  paths: []
  commands: []
---
Nothing below.
`,
      },
      {
        path: "plan/i--02/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAB
kind: initiative
title: Half initiative
deliverable: expansion
verify:
  paths: []
  commands: []
---
One objective below.
`,
      },
      {
        path: "plan/i--02/o--01/objective.md",
        content: `---
id: objective_01ARZ3NDEKTSV4RRFFQ69G5FAC
kind: objective
title: Empty objective
deliverable: expansion
verify:
  paths: []
  commands: []
repo: repo_a
---
Nothing below.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["initiative-without-objective", "objective-without-task"],
    );
    assert.deepEqual(
      result.findings.map((finding) => findingScope[finding.code]),
      ["completeness", "completeness"],
    );
  });

  it("a task whose objective directory holds no objective document is parent-missing", () => {
    const result = assertStable([
      {
        path: "plan/i--01/o--01/01-a.md",
        content: `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FAD
kind: task
title: Orphan task
worker: general@1
---
Work.

## Acceptance criteria

- Done.
`,
      },
    ]);
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["parent-missing"],
    );
  });
});
