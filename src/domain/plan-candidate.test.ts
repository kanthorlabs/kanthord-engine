import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCandidate,
  repairSuggestions,
  validateCandidate,
  validateCandidateCompleteness,
  validateCandidateStructural,
} from "./plan-candidate.ts";
import type { Candidate, CandidateNode } from "./plan-candidate.ts";
import { findingCodes, findingScope } from "./plan-finding.ts";
import type { Finding } from "./plan-finding.ts";
import type { StoredNode, ValidationContext } from "./plan-graph.ts";
import type { ResolvedDocument } from "./plan-identity.ts";
import type { Choice, ChoiceVerdict } from "./plan-choice.ts";
import type { NodeKind } from "./state.ts";
import { createPlanGraph } from "../../test/helpers/plan.ts";
import { workerKinds } from "./worker.ts";

const U_I = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const U_O1 = "01BQZ3NDEKTSV4RRFFQ69G5FAV";
const U_O2 = "01DRZ3NDEKTSV4RRFFQ69G5FAV";
const U_T1 = "01ERZ3NDEKTSV4RRFFQ69G5FAV";
const U_T2 = "01FQZ3NDEKTSV4RRFFQ69G5FAV";
const U_T3 = "01GQZ3NDEKTSV4RRFFQ69G5FAV";
const U_T4 = "01JQZ3NDEKTSV4RRFFQ69G5FAV";
const U_I2 = "01KQZ3NDEKTSV4RRFFQ69G5FAV";
const U_MM = "01HZY8QF3M4N5P6R7S8T9V0W1X";

const initiativeI = `initiative_${U_I}`;
const initiativeI2 = `initiative_${U_I2}`;
const objectiveO1 = `objective_${U_O1}`;
const objectiveO2 = `objective_${U_O2}`;
const task1 = `task_${U_T1}`;
const task2 = `task_${U_T2}`;
const task3 = `task_${U_T3}`;
const task4 = `task_${U_T4}`;
const initiativeMM = `initiative_${U_MM}`;
const objectiveMM = `objective_${U_MM}`;

const context: ValidationContext = {
  workerKinds: ["tdd"],
  boundRepositories: ["repo_a"],
  knownRepositories: ["repo_a", "repo_b"],
};

const harnessFourContext: ValidationContext = {
  workerKinds: [...workerKinds],
  boundRepositories: ["repo_a"],
  knownRepositories: ["repo_a", "repo_b"],
};

const graph = createPlanGraph();
const findCycles = graph.cycles;

const candidateFindingCodes = [
  "dependency-cross-parent",
  "dependency-cycle",
  "dependency-self",
  "identity-kind-mismatch",
  "initiative-without-objective",
  "objective-without-task",
  "parent-missing",
  "reference-unresolved",
  "repo-missing",
  "repo-on-task",
  "repository-unbound",
  "repository-unknown",
  "worker-unknown",
];

function storedNode(
  id: string,
  kind: NodeKind,
  overrides: Partial<StoredNode> = {},
): StoredNode {
  return {
    id,
    projectId: "project_a",
    kind,
    parentId: null,
    title: id,
    instructionBlob: `sha256:${"a".repeat(64)}`,
    acceptanceBlob: null,
    worker: null,
    repositoryId: null,
    state: "pending",
    blockReason: null,
    discardReason: null,
    revision: "revision_a",
    updatedAt: 1,
    dependencies: [],
    ...overrides,
  };
}

function submittedDocument(
  identity: string,
  kind: NodeKind,
  overrides: Partial<ResolvedDocument> = {},
): ResolvedDocument {
  return {
    path: `plan/${identity}.md`,
    kind,
    id: identity,
    title: identity,
    dependsOn: [],
    worker: null,
    repo: null,
    derivedParentPath: null,
    instruction: `${identity} work\n`,
    acceptance: null,
    identity,
    minted: false,
    parentIdentity: null,
    dependencies: [],
    ...overrides,
  };
}

function hashes(
  identities: readonly string[],
): Map<string, Readonly<{ instruction: string; acceptance: string | null }>> {
  return new Map(
    identities.map((id) => [
      id,
      { instruction: `submitted:${id}`, acceptance: null },
    ]),
  );
}

function candidateOf(
  submitted: readonly ResolvedDocument[],
  stored: readonly StoredNode[],
  takes: Readonly<Record<string, Choice>>,
): Candidate {
  return buildCandidate({
    submitted,
    stored,
    choices: Object.entries(takes).map(([id, take]) => ({ id, take })),
    blobHashes: hashes(submitted.map((document) => document.identity)),
  });
}

function verdict(suggested: Choice): ChoiceVerdict {
  return {
    suggested,
    submitted: { legal: true, reason: null },
    database: { legal: true, reason: null },
  };
}

function repairedCandidate(
  repaired: ReadonlyMap<string, Choice>,
  submitted: readonly ResolvedDocument[],
  stored: readonly StoredNode[],
): Candidate {
  return buildCandidate({
    submitted,
    stored,
    choices: [...repaired.entries()].map(([id, take]) => ({ id, take })),
    blobHashes: hashes(submitted.map((document) => document.identity)),
  });
}

function sortedEntries<T>(
  map: ReadonlyMap<string, T>,
): ReadonlyArray<readonly [string, T]> {
  return [...map.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

describe("buildCandidate", () => {
  it("all submitted on a document-only set returns every submitted node, ascending by id", () => {
    const submitted = [
      submittedDocument(task1, "task", { worker: "tdd" }),
      submittedDocument(initiativeI, "initiative"),
      submittedDocument(objectiveO1, "objective", { repo: "repo_a" }),
    ];
    const candidate = candidateOf(submitted, [], {
      [initiativeI]: "submitted",
      [objectiveO1]: "submitted",
      [task1]: "submitted",
    });
    const expected: CandidateNode[] = [
      {
        id: initiativeI,
        kind: "initiative",
        parentId: null,
        title: initiativeI,
        instructionBlob: `submitted:${initiativeI}`,
        acceptanceBlob: null,
        worker: null,
        repositoryId: null,
        dependencies: [],
        source: "submitted",
      },
      {
        id: objectiveO1,
        kind: "objective",
        parentId: null,
        title: objectiveO1,
        instructionBlob: `submitted:${objectiveO1}`,
        acceptanceBlob: null,
        worker: null,
        repositoryId: "repo_a",
        dependencies: [],
        source: "submitted",
      },
      {
        id: task1,
        kind: "task",
        parentId: null,
        title: task1,
        instructionBlob: `submitted:${task1}`,
        acceptanceBlob: null,
        worker: "tdd",
        repositoryId: null,
        dependencies: [],
        source: "submitted",
      },
    ];
    assert.deepEqual(candidate.nodes, expected);
  });

  it("all database on a stored set returns every stored node", () => {
    const stored = [storedNode(task2, "task"), storedNode(task1, "task")];
    const candidate = candidateOf([], stored, {
      [task1]: "database",
      [task2]: "database",
    });
    assert.deepEqual(candidate.nodes, [
      {
        id: task1,
        kind: "task",
        parentId: null,
        title: task1,
        instructionBlob: `sha256:${"a".repeat(64)}`,
        acceptanceBlob: null,
        worker: null,
        repositoryId: null,
        dependencies: [],
        source: "database",
      },
      {
        id: task2,
        kind: "task",
        parentId: null,
        title: task2,
        instructionBlob: `sha256:${"a".repeat(64)}`,
        acceptanceBlob: null,
        worker: null,
        repositoryId: null,
        dependencies: [],
        source: "database",
      },
    ]);
  });

  it("a database-only node taking submitted is dropped", () => {
    const stored = [storedNode(task1, "task")];
    const candidate = candidateOf([], stored, { [task1]: "submitted" });
    assert.deepEqual(candidate.nodes, []);
  });

  it("a document-only node taking database is dropped", () => {
    const submitted = [submittedDocument(task1, "task")];
    const candidate = candidateOf(submitted, [], { [task1]: "database" });
    assert.deepEqual(candidate.nodes, []);
  });

  it("a mixed set returns the right source per node, asserted as an exact table", () => {
    const submitted = [
      submittedDocument(task1, "task", {
        parentIdentity: objectiveO1,
        worker: "tdd",
        dependencies: [task2],
      }),
      submittedDocument(task3, "task", { dependencies: [] }),
    ];
    const stored = [
      storedNode(task1, "task", { parentId: objectiveO1, worker: "tdd" }),
      storedNode(task2, "task", { dependencies: [task1] }),
    ];
    const candidate = candidateOf(submitted, stored, {
      [task1]: "submitted",
      [task2]: "database",
      [task3]: "submitted",
    });
    const expected: CandidateNode[] = [
      {
        id: task1,
        kind: "task",
        parentId: objectiveO1,
        title: task1,
        instructionBlob: `submitted:${task1}`,
        acceptanceBlob: null,
        worker: "tdd",
        repositoryId: null,
        dependencies: [task2],
        source: "submitted",
      },
      {
        id: task2,
        kind: "task",
        parentId: null,
        title: task2,
        instructionBlob: `sha256:${"a".repeat(64)}`,
        acceptanceBlob: null,
        worker: null,
        repositoryId: null,
        dependencies: [task1],
        source: "database",
      },
      {
        id: task3,
        kind: "task",
        parentId: null,
        title: task3,
        instructionBlob: `submitted:${task3}`,
        acceptanceBlob: null,
        worker: null,
        repositoryId: null,
        dependencies: [],
        source: "submitted",
      },
    ];
    assert.deepEqual(candidate.nodes, expected);
  });

  it("the cycle construction: stored holds B -> A, submitted holds A -> B, and both edges survive", () => {
    const stored = [
      storedNode(task1, "task", { parentId: objectiveO1 }),
      storedNode(task2, "task", {
        parentId: objectiveO1,
        dependencies: [task1],
      }),
    ];
    const submitted = [
      submittedDocument(task1, "task", {
        parentIdentity: objectiveO1,
        dependencies: [task2],
      }),
    ];
    const candidate = candidateOf(submitted, stored, {
      [task1]: "submitted",
      [task2]: "database",
    });
    assert.equal(candidate.nodes.length, 2);
    const byId = new Map(candidate.nodes.map((node) => [node.id, node]));
    assert.equal(byId.get(task1)?.source, "submitted");
    assert.deepEqual(byId.get(task1)?.dependencies, [task2]);
    assert.equal(byId.get(task2)?.source, "database");
    assert.deepEqual(byId.get(task2)?.dependencies, [task1]);
  });

  it("a dependency naming a dropped identity survives in dependencies", () => {
    const submitted = [
      submittedDocument(task1, "task", { dependencies: [task2] }),
      submittedDocument(task2, "task"),
    ];
    const candidate = candidateOf(submitted, [], {
      [task1]: "submitted",
      [task2]: "database",
    });
    assert.equal(candidate.nodes.length, 1);
    assert.deepEqual(candidate.nodes[0]?.dependencies, [task2]);
  });
});

describe("validateCandidate", () => {
  const emittedCodes: string[] = [];
  function record(findings: readonly Finding[]): void {
    for (const finding of findings) emittedCodes.push(finding.code);
  }

  function hierarchy(): {
    submitted: readonly ResolvedDocument[];
    takes: Readonly<Record<string, Choice>>;
  } {
    return {
      submitted: [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(objectiveO1, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeI,
        }),
        submittedDocument(task1, "task", {
          parentIdentity: objectiveO1,
          worker: "tdd",
        }),
      ],
      takes: {
        [initiativeI]: "submitted",
        [objectiveO1]: "submitted",
        [task1]: "submitted",
      },
    };
  }

  it("a valid candidate returns []", () => {
    const { submitted, takes } = hierarchy();
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(submitted, [], takes), context },
    );
    record(findings);
    assert.deepEqual(findings, []);
  });

  it("the cycle case is refused with exactly one dependency-cycle naming both ids", () => {
    const { submitted } = hierarchy();
    const cycleSubmitted = submitted.map((document) =>
      document.identity === task1
        ? { ...document, dependencies: [task2] }
        : document,
    );
    const stored = [
      storedNode(task2, "task", {
        parentId: objectiveO1,
        dependencies: [task1],
      }),
    ];
    const candidate = candidateOf(cycleSubmitted, stored, {
      [initiativeI]: "submitted",
      [objectiveO1]: "submitted",
      [task1]: "submitted",
      [task2]: "database",
    });
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "dependency-cycle");
    assert.equal(findings[0]?.path, null);
    assert.equal(findings[0]?.id, task1);
    assert.equal(findings[0]?.message, `${task1} -> ${task2}`);
  });

  it("reports parent-missing for a task whose parent was dropped", () => {
    const candidate = candidateOf(
      [
        submittedDocument(task1, "task", {
          parentIdentity: objectiveO1,
          worker: "tdd",
        }),
      ],
      [],
      { [task1]: "submitted" },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "parent-missing");
    assert.equal(findings[0]?.id, task1);
    assert.equal(findings[0]?.path, null);
  });

  it("a task under an initiative is parent-missing", () => {
    const candidate = candidateOf(
      [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(task1, "task", {
          parentIdentity: initiativeI,
          worker: "tdd",
        }),
      ],
      [],
      { [initiativeI]: "submitted", [task1]: "submitted" },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    const parentFindings = findings.filter(
      (finding) => finding.code === "parent-missing",
    );
    assert.equal(parentFindings.length, 1);
    assert.equal(parentFindings[0]?.id, task1);
    assert.equal(parentFindings[0]?.path, null);
    assert.equal(
      parentFindings[0]?.message,
      `the parent ${initiativeI} is not an objective`,
    );
  });

  it("an objective under a task is parent-missing", () => {
    const candidate = candidateOf(
      [
        submittedDocument(task1, "task", {
          parentIdentity: objectiveO1,
          worker: "tdd",
        }),
        submittedDocument(objectiveO1, "objective", {
          repo: "repo_a",
          parentIdentity: task1,
        }),
      ],
      [],
      { [task1]: "submitted", [objectiveO1]: "submitted" },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    const parentFindings = findings.filter(
      (finding) => finding.code === "parent-missing",
    );
    assert.equal(parentFindings.length, 1);
    assert.equal(parentFindings[0]?.id, objectiveO1);
    assert.equal(parentFindings[0]?.path, null);
    assert.equal(
      parentFindings[0]?.message,
      `the parent ${task1} is not an initiative`,
    );
  });

  it("a task under an objective and an objective under an initiative are clean", () => {
    const { submitted, takes } = hierarchy();
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(submitted, [], takes), context },
    );
    record(findings);
    assert.deepEqual(findings, []);
  });

  it("an initiative is exempt from the parent-kind rule", () => {
    const candidate = candidateOf(
      [submittedDocument(initiativeI, "initiative")],
      [],
      { [initiativeI]: "submitted" },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    assert.deepEqual(
      findings.filter((finding) => finding.code === "parent-missing"),
      [],
    );
  });

  it("the parent-kind rule is structural", () => {
    assert.equal(findingScope["parent-missing"], "structural");
  });

  it("validateCandidateStructural drops both completeness codes", () => {
    const candidate = candidateOf(
      [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(initiativeI2, "initiative"),
        submittedDocument(objectiveO1, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeI2,
        }),
      ],
      [],
      {
        [initiativeI]: "submitted",
        [initiativeI2]: "submitted",
        [objectiveO1]: "submitted",
      },
    );
    assert.deepEqual(
      validateCandidateStructural({ findCycles }, { candidate, context }),
      [],
    );
  });

  it("validateCandidateCompleteness keeps both completeness codes and nothing else", () => {
    const candidate = candidateOf(
      [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(initiativeI2, "initiative"),
        submittedDocument(objectiveO1, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeI2,
        }),
      ],
      [],
      {
        [initiativeI]: "submitted",
        [initiativeI2]: "submitted",
        [objectiveO1]: "submitted",
      },
    );
    const completeness = validateCandidateCompleteness(
      { findCycles },
      { candidate, context },
    );
    assert.deepEqual(
      completeness.map((finding) => finding.code),
      ["initiative-without-objective", "objective-without-task"],
    );
    assert.equal(completeness.length, 2);
  });

  it("the two partitions are exhaustive", () => {
    const candidate = candidateOf(
      [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(initiativeI2, "initiative"),
        submittedDocument(objectiveO1, "objective", {
          parentIdentity: initiativeI2,
        }),
      ],
      [],
      {
        [initiativeI]: "submitted",
        [initiativeI2]: "submitted",
        [objectiveO1]: "submitted",
      },
    );
    const all = validateCandidate({ findCycles }, { candidate, context });
    const structural = validateCandidateStructural(
      { findCycles },
      { candidate, context },
    );
    const completeness = validateCandidateCompleteness(
      { findCycles },
      { candidate, context },
    );
    assert.deepEqual(
      structural.map((finding) => finding.code),
      ["repo-missing"],
    );
    assert.deepEqual(
      completeness.map((finding) => finding.code),
      ["initiative-without-objective", "objective-without-task"],
    );
    assert.equal(structural.length + completeness.length, all.length);
  });

  it("reports objective-without-task for an objective with no task child", () => {
    const candidate = candidateOf(
      [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(objectiveO1, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeI,
        }),
      ],
      [],
      { [initiativeI]: "submitted", [objectiveO1]: "submitted" },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "objective-without-task");
    assert.equal(findings[0]?.id, objectiveO1);
    assert.deepEqual(
      validateCandidateStructural({ findCycles }, { candidate, context }),
      [],
    );
  });

  it("reports initiative-without-objective for an initiative with no objective child", () => {
    const candidate = candidateOf(
      [submittedDocument(initiativeI, "initiative")],
      [],
      { [initiativeI]: "submitted" },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "initiative-without-objective");
    assert.equal(findings[0]?.id, initiativeI);
    assert.deepEqual(
      validateCandidateStructural({ findCycles }, { candidate, context }),
      [],
    );
  });

  it("reports repo-on-task for a task carrying a repository", () => {
    const { submitted, takes } = hierarchy();
    const edited = submitted.map((document) =>
      document.identity === task1 ? { ...document, repo: "repo_a" } : document,
    );
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(edited, [], takes), context },
    );
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "repo-on-task");
    assert.equal(findings[0]?.id, task1);
  });

  it("reports repo-missing for an objective without a repository", () => {
    const { submitted, takes } = hierarchy();
    const edited = submitted.map((document) =>
      document.identity === objectiveO1
        ? { ...document, repo: null }
        : document,
    );
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(edited, [], takes), context },
    );
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "repo-missing");
    assert.equal(findings[0]?.id, objectiveO1);
  });

  it("reports worker-unknown for a worker outside the known kinds", () => {
    const { submitted, takes } = hierarchy();
    const edited = submitted.map((document) =>
      document.identity === task1
        ? { ...document, worker: "nope@1" }
        : document,
    );
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(edited, [], takes), context },
    );
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "worker-unknown");
    assert.equal(findings[0]?.id, task1);
    assert.equal(findings[0]?.path, null);
  });

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
      {
        candidate: candidateOf(edited, [], takes),
        context: harnessFourContext,
      },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "worker-unknown");
    assert.equal(findings[0]?.id, task1);
    assert.equal(findings[0]?.path, null);
  });

  it("reports repository-unknown for a repo outside the known repositories", () => {
    const { submitted, takes } = hierarchy();
    const edited = submitted.map((document) =>
      document.identity === objectiveO1
        ? { ...document, repo: "repo_nope" }
        : document,
    );
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(edited, [], takes), context },
    );
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "repository-unknown");
    assert.equal(findings[0]?.id, objectiveO1);
  });

  it("an objective whose repo is known but unbound returns repository-unbound", () => {
    const { submitted, takes } = hierarchy();
    const edited = submitted.map((document) =>
      document.identity === objectiveO1
        ? { ...document, repo: "repo_b" }
        : document,
    );
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(edited, [], takes), context },
    );
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "repository-unbound");
    assert.equal(findings[0]?.id, objectiveO1);
  });

  it("reports reference-unresolved for a dependency naming an absent identity", () => {
    const { submitted, takes } = hierarchy();
    const edited = submitted.map((document) =>
      document.identity === task1
        ? { ...document, dependencies: [task2] }
        : document,
    );
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(edited, [], takes), context },
    );
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "reference-unresolved");
    assert.equal(findings[0]?.id, task1);
  });

  it("reports dependency-self for a dependency naming its own identity", () => {
    const { submitted, takes } = hierarchy();
    const edited = submitted.map((document) =>
      document.identity === task1
        ? { ...document, dependencies: [task1] }
        : document,
    );
    const findings = validateCandidate(
      { findCycles },
      { candidate: candidateOf(edited, [], takes), context },
    );
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "dependency-self");
    assert.equal(findings[0]?.id, task1);
  });

  it("reports dependency-cross-parent for a dependency under a different parent", () => {
    const candidate = candidateOf(
      [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(objectiveO1, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeI,
        }),
        submittedDocument(objectiveO2, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeI,
        }),
        submittedDocument(task1, "task", {
          parentIdentity: objectiveO1,
          worker: "tdd",
          dependencies: [task2],
        }),
        submittedDocument(task2, "task", {
          parentIdentity: objectiveO2,
          worker: "tdd",
        }),
      ],
      [],
      {
        [initiativeI]: "submitted",
        [objectiveO1]: "submitted",
        [objectiveO2]: "submitted",
        [task1]: "submitted",
        [task2]: "submitted",
      },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, "dependency-cross-parent");
    assert.equal(findings[0]?.id, task1);
  });

  it("reports identity-kind-mismatch for one ULID payload under two kind prefixes", () => {
    const candidate = candidateOf(
      [
        submittedDocument(initiativeMM, "initiative"),
        submittedDocument(objectiveMM, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeMM,
        }),
      ],
      [],
      { [initiativeMM]: "submitted", [objectiveMM]: "submitted" },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    const mismatches = findings.filter(
      (finding) => finding.code === "identity-kind-mismatch",
    );
    assert.ok(mismatches.length > 0);
    for (const finding of mismatches) {
      assert.equal(finding.id, null);
      assert.equal(finding.path, null);
    }
  });

  it("findings are returned sorted, asserted on a case producing three", () => {
    const candidate = candidateOf(
      [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(objectiveO1, "objective", {
          repo: "repo_b",
          parentIdentity: initiativeI,
        }),
        submittedDocument(objectiveO2, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeI,
        }),
        submittedDocument(task1, "task", {
          parentIdentity: objectiveO1,
          worker: "nope@1",
        }),
      ],
      [],
      {
        [initiativeI]: "submitted",
        [objectiveO1]: "submitted",
        [objectiveO2]: "submitted",
        [task1]: "submitted",
      },
    );
    const findings = validateCandidate({ findCycles }, { candidate, context });
    record(findings);
    assert.equal(findings.length, 3);
    assert.deepEqual(
      findings.map((finding) => ({ code: finding.code, id: finding.id })),
      [
        { code: "objective-without-task", id: objectiveO2 },
        { code: "repository-unbound", id: objectiveO1 },
        { code: "worker-unknown", id: task1 },
      ],
    );
  });

  it("every emitted code is one of the thirteen candidate codes", () => {
    const difference = [...new Set(emittedCodes)].filter(
      (code) => !(candidateFindingCodes as readonly string[]).includes(code),
    );
    assert.deepEqual(difference, []);
    assert.deepEqual([...new Set(emittedCodes)].sort(), candidateFindingCodes);
  });
});

describe("repairSuggestions", () => {
  const repairDependencies = {
    findCycles: graph.cycles,
    findComponents: graph.components,
  };

  function cycleInput(): {
    submitted: readonly ResolvedDocument[];
    stored: readonly StoredNode[];
    verdicts: Map<string, ChoiceVerdict>;
  } {
    return {
      stored: [
        storedNode(initiativeI, "initiative"),
        storedNode(objectiveO1, "objective", {
          parentId: initiativeI,
          repositoryId: "repo_a",
        }),
        storedNode(task1, "task", { parentId: objectiveO1 }),
        storedNode(task2, "task", {
          parentId: objectiveO1,
          dependencies: [task1],
        }),
      ],
      submitted: [
        submittedDocument(initiativeI, "initiative"),
        submittedDocument(objectiveO1, "objective", {
          repo: "repo_a",
          parentIdentity: initiativeI,
        }),
        submittedDocument(task1, "task", {
          parentIdentity: objectiveO1,
          dependencies: [task2],
        }),
      ],
      verdicts: new Map<string, ChoiceVerdict>([
        [initiativeI, verdict("submitted")],
        [objectiveO1, verdict("submitted")],
        [task1, verdict("submitted")],
        [task2, verdict("database")],
      ]),
    };
  }

  it("a set whose local suggestions build a valid graph is returned unchanged", () => {
    const submitted = [
      submittedDocument(initiativeI, "initiative"),
      submittedDocument(objectiveO1, "objective", {
        repo: "repo_a",
        parentIdentity: initiativeI,
      }),
      submittedDocument(task1, "task", {
        parentIdentity: objectiveO1,
        worker: "tdd",
      }),
    ];
    const verdicts = new Map<string, ChoiceVerdict>([
      [initiativeI, verdict("submitted")],
      [objectiveO1, verdict("submitted")],
      [task1, verdict("submitted")],
    ]);
    const repaired = repairSuggestions(repairDependencies, {
      submitted,
      stored: [],
      verdicts,
      blobHashes: hashes([initiativeI, objectiveO1, task1]),
      context,
    });
    assert.deepEqual(
      sortedEntries(repaired),
      sortedEntries(
        new Map([...verdicts].map(([id, value]) => [id, value.suggested])),
      ),
    );
  });

  it("the normative cycle: both nodes end at database and the repaired set validates clean", () => {
    const { submitted, stored, verdicts } = cycleInput();
    const repaired = repairSuggestions(repairDependencies, {
      submitted,
      stored,
      verdicts,
      blobHashes: hashes([initiativeI, objectiveO1, task1]),
      context,
    });
    assert.deepEqual(sortedEntries(repaired), [
      [initiativeI, "database"],
      [objectiveO1, "database"],
      [task1, "database"],
      [task2, "database"],
    ]);
    assert.deepEqual(
      validateCandidate(
        { findCycles },
        { candidate: repairedCandidate(repaired, submitted, stored), context },
      ),
      [],
    );
  });

  it("the reset is by component: a third node in the same component with no finding of its own is also reset", () => {
    const { submitted, stored, verdicts } = cycleInput();
    const repaired = repairSuggestions(repairDependencies, {
      submitted,
      stored,
      verdicts,
      blobHashes: hashes([initiativeI, objectiveO1, task1]),
      context,
    });
    assert.equal(repaired.get(initiativeI), "database");
    assert.equal(repaired.get(objectiveO1), "database");
  });

  it("a node in a different component keeps its submitted suggestion", () => {
    const stored = [
      storedNode(initiativeI, "initiative"),
      storedNode(objectiveO1, "objective", {
        parentId: initiativeI,
        repositoryId: "repo_a",
      }),
      storedNode(task1, "task", { parentId: objectiveO1 }),
      storedNode(task2, "task", {
        parentId: objectiveO1,
        dependencies: [task1],
      }),
    ];
    const submitted = [
      submittedDocument(initiativeI, "initiative"),
      submittedDocument(objectiveO1, "objective", {
        repo: "repo_a",
        parentIdentity: initiativeI,
      }),
      submittedDocument(task1, "task", {
        parentIdentity: objectiveO1,
        dependencies: [task2],
      }),
      submittedDocument(initiativeI2, "initiative"),
      submittedDocument(objectiveO2, "objective", {
        repo: "repo_a",
        parentIdentity: initiativeI2,
      }),
      submittedDocument(task3, "task", {
        parentIdentity: objectiveO2,
        worker: "tdd",
      }),
    ];
    const verdicts = new Map<string, ChoiceVerdict>([
      [initiativeI, verdict("submitted")],
      [objectiveO1, verdict("submitted")],
      [task1, verdict("submitted")],
      [task2, verdict("database")],
      [initiativeI2, verdict("submitted")],
      [objectiveO2, verdict("submitted")],
      [task3, verdict("submitted")],
    ]);
    const repaired = repairSuggestions(repairDependencies, {
      submitted,
      stored,
      verdicts,
      blobHashes: hashes([
        initiativeI,
        objectiveO1,
        task1,
        initiativeI2,
        objectiveO2,
        task3,
      ]),
      context,
    });
    assert.deepEqual(sortedEntries(repaired), [
      [initiativeI, "database"],
      [initiativeI2, "submitted"],
      [objectiveO1, "database"],
      [objectiveO2, "submitted"],
      [task1, "database"],
      [task2, "database"],
      [task3, "submitted"],
    ]);
    assert.equal(repaired.get(task3), "submitted");
  });

  it("two independent invalid components are both reset in one pass", () => {
    const stored = [
      storedNode(initiativeI, "initiative"),
      storedNode(objectiveO1, "objective", {
        parentId: initiativeI,
        repositoryId: "repo_a",
      }),
      storedNode(task1, "task", { parentId: objectiveO1 }),
      storedNode(task2, "task", {
        parentId: objectiveO1,
        dependencies: [task1],
      }),
      storedNode(initiativeI2, "initiative"),
      storedNode(objectiveO2, "objective", {
        parentId: initiativeI2,
        repositoryId: "repo_a",
      }),
      storedNode(task3, "task", { parentId: objectiveO2 }),
      storedNode(task4, "task", {
        parentId: objectiveO2,
        dependencies: [task3],
      }),
    ];
    const submitted = [
      submittedDocument(initiativeI, "initiative"),
      submittedDocument(objectiveO1, "objective", {
        repo: "repo_a",
        parentIdentity: initiativeI,
      }),
      submittedDocument(task1, "task", {
        parentIdentity: objectiveO1,
        dependencies: [task2],
      }),
      submittedDocument(initiativeI2, "initiative"),
      submittedDocument(objectiveO2, "objective", {
        repo: "repo_a",
        parentIdentity: initiativeI2,
      }),
      submittedDocument(task3, "task", {
        parentIdentity: objectiveO2,
        dependencies: [task4],
      }),
    ];
    const verdicts = new Map<string, ChoiceVerdict>([
      [initiativeI, verdict("submitted")],
      [objectiveO1, verdict("submitted")],
      [task1, verdict("submitted")],
      [task2, verdict("database")],
      [initiativeI2, verdict("submitted")],
      [objectiveO2, verdict("submitted")],
      [task3, verdict("submitted")],
      [task4, verdict("database")],
    ]);
    const repaired = repairSuggestions(repairDependencies, {
      submitted,
      stored,
      verdicts,
      blobHashes: hashes([
        initiativeI,
        objectiveO1,
        task1,
        initiativeI2,
        objectiveO2,
        task3,
      ]),
      context,
    });
    for (const take of repaired.values()) {
      assert.equal(take, "database");
    }
    assert.deepEqual(
      validateCandidate(
        { findCycles },
        { candidate: repairedCandidate(repaired, submitted, stored), context },
      ),
      [],
    );
  });

  it("a repair needing two iterations terminates and the final set is valid", () => {
    const stored = [
      storedNode(initiativeI, "initiative"),
      storedNode(objectiveO1, "objective", {
        parentId: initiativeI,
        repositoryId: "repo_a",
      }),
      storedNode(task1, "task", { parentId: objectiveO1 }),
      storedNode(task2, "task", {
        parentId: objectiveO1,
        dependencies: [task1],
      }),
      storedNode(initiativeI2, "initiative"),
      storedNode(objectiveO2, "objective", {
        parentId: initiativeI2,
        repositoryId: "repo_a",
      }),
      storedNode(task3, "task", { parentId: objectiveO2 }),
    ];
    const submitted = [
      submittedDocument(initiativeI, "initiative"),
      submittedDocument(objectiveO1, "objective", {
        repo: "repo_a",
        parentIdentity: initiativeI,
      }),
      submittedDocument(task1, "task", {
        parentIdentity: objectiveO1,
        dependencies: [task2],
      }),
      submittedDocument(initiativeI2, "initiative"),
      submittedDocument(objectiveO2, "objective", {
        repo: "repo_a",
        parentIdentity: initiativeI2,
      }),
      submittedDocument(task3, "task", {
        parentIdentity: objectiveO2,
        worker: "tdd",
        dependencies: [task1],
      }),
    ];
    const verdicts = new Map<string, ChoiceVerdict>([
      [initiativeI, verdict("submitted")],
      [objectiveO1, verdict("submitted")],
      [task1, verdict("submitted")],
      [task2, verdict("database")],
      [initiativeI2, verdict("submitted")],
      [objectiveO2, verdict("submitted")],
      [task3, verdict("submitted")],
    ]);
    const repaired = repairSuggestions(repairDependencies, {
      submitted,
      stored,
      verdicts,
      blobHashes: hashes([
        initiativeI,
        objectiveO1,
        task1,
        initiativeI2,
        objectiveO2,
        task3,
      ]),
      context,
    });
    for (const take of repaired.values()) {
      assert.equal(take, "database");
    }
    assert.deepEqual(
      validateCandidate(
        { findCycles },
        { candidate: repairedCandidate(repaired, submitted, stored), context },
      ),
      [],
    );
  });

  it("the all-database set is always valid on a stored graph with an empty submission", () => {
    const stored = [
      storedNode(initiativeI, "initiative"),
      storedNode(objectiveO1, "objective", {
        parentId: initiativeI,
        repositoryId: "repo_a",
      }),
      storedNode(task1, "task", { parentId: objectiveO1, worker: "tdd" }),
    ];
    const verdicts = new Map<string, ChoiceVerdict>([
      [initiativeI, verdict("database")],
      [objectiveO1, verdict("database")],
      [task1, verdict("database")],
    ]);
    const repaired = repairSuggestions(repairDependencies, {
      submitted: [],
      stored,
      verdicts,
      blobHashes: new Map(),
      context,
    });
    assert.deepEqual(sortedEntries(repaired), [
      [initiativeI, "database"],
      [objectiveO1, "database"],
      [task1, "database"],
    ]);
    assert.deepEqual(
      validateCandidate(
        { findCycles },
        { candidate: repairedCandidate(repaired, [], stored), context },
      ),
      [],
    );
  });

  it("a finding with a null id resets every node", () => {
    const submitted = [
      submittedDocument(initiativeMM, "initiative"),
      submittedDocument(objectiveMM, "objective", {
        repo: "repo_a",
        parentIdentity: initiativeMM,
      }),
    ];
    const verdicts = new Map<string, ChoiceVerdict>([
      [initiativeMM, verdict("submitted")],
      [objectiveMM, verdict("submitted")],
    ]);
    const repaired = repairSuggestions(repairDependencies, {
      submitted,
      stored: [],
      verdicts,
      blobHashes: hashes([initiativeMM, objectiveMM]),
      context,
    });
    for (const take of repaired.values()) {
      assert.equal(take, "database");
    }
  });

  it("is deterministic across two runs and a reversed submitted array", () => {
    const { submitted, stored, verdicts } = cycleInput();
    const first = repairSuggestions(repairDependencies, {
      submitted,
      stored,
      verdicts,
      blobHashes: hashes([initiativeI, objectiveO1, task1]),
      context,
    });
    const second = repairSuggestions(repairDependencies, {
      submitted,
      stored,
      verdicts,
      blobHashes: hashes([initiativeI, objectiveO1, task1]),
      context,
    });
    assert.deepEqual([...second.entries()], [...first.entries()]);
    const reversed = repairSuggestions(repairDependencies, {
      submitted: [...submitted].reverse(),
      stored,
      verdicts,
      blobHashes: hashes([initiativeI, objectiveO1, task1]),
      context,
    });
    assert.deepEqual([...reversed.entries()], [...first.entries()]);
  });

  it("repairSuggestions terminates on an incomplete baseline", () => {
    const stored = [
      storedNode(initiativeI, "initiative"),
      storedNode(objectiveO1, "objective", {
        parentId: initiativeI,
        repositoryId: "repo_a",
      }),
    ];
    const verdicts = new Map<string, ChoiceVerdict>([
      [initiativeI, verdict("database")],
      [objectiveO1, verdict("database")],
    ]);
    const repaired = repairSuggestions(repairDependencies, {
      submitted: [],
      stored,
      verdicts,
      blobHashes: new Map(),
      context,
    });
    assert.deepEqual(sortedEntries(repaired), [
      [initiativeI, "database"],
      [objectiveO1, "database"],
    ]);
  });
});
