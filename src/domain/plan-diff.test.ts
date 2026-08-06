import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { differingFields } from "./plan-diff.ts";
import type { StoredNode } from "./plan-graph.ts";
import type { ResolvedDocument } from "./plan-identity.ts";

const taskIdentity = "task_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const objectiveIdentity = "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV";
const otherTaskIdentity = "task_01DRZ3NDEKTSV4RRFFQ69G5FAV";
const otherObjectiveIdentity = "objective_01EZQZ3NDEKTSV4RRFFQ69G5FAV";

const instructionHash = `sha256:${"a".repeat(64)}`;
const acceptanceHash = `sha256:${"b".repeat(64)}`;

const storedBase: StoredNode = {
  id: taskIdentity,
  projectId: "project_a",
  kind: "task",
  parentId: objectiveIdentity,
  title: "Render the manifest",
  instructionBlob: instructionHash,
  acceptanceBlob: acceptanceHash,
  worker: null,
  repositoryId: null,
  state: "pending",
  blockReason: null,
  discardReason: null,
  revision: "revision_a",
  updatedAt: 1,
  dependencies: [otherTaskIdentity],
};

const submittedBase: ResolvedDocument = {
  path: "plan/i--01/o--01/01-render.md",
  kind: "task",
  id: taskIdentity,
  title: "Render the manifest",
  dependsOn: [],
  worker: null,
  repo: null,
  derivedParentPath: "plan/i--01/o--01/objective.md",
  instruction: "Build the renderer.\n",
  acceptance: "## Acceptance criteria\n- The bytes match.\n",
  identity: taskIdentity,
  minted: false,
  parentIdentity: objectiveIdentity,
  dependencies: [otherTaskIdentity],
};

function stored(overrides: Partial<StoredNode> = {}): StoredNode {
  return { ...storedBase, ...overrides };
}

function submitted(
  overrides: Partial<ResolvedDocument> = {},
): ResolvedDocument {
  return { ...submittedBase, ...overrides };
}

function sameBlobs(): Readonly<{
  instruction: string;
  acceptance: string | null;
}> {
  return { instruction: instructionHash, acceptance: acceptanceHash };
}

describe("src/domain/plan-diff.test", () => {
  it("no difference returns an empty field list", () => {
    assert.deepEqual(differingFields(stored(), submitted(), sameBlobs()), []);
  });

  it("a title change returns title", () => {
    assert.deepEqual(
      differingFields(
        stored(),
        submitted({ title: "Render the other" }),
        sameBlobs(),
      ),
      ["title"],
    );
  });

  it("an instruction body change returns body", () => {
    assert.deepEqual(
      differingFields(stored(), submitted(), {
        instruction: `sha256:${"c".repeat(64)}`,
        acceptance: acceptanceHash,
      }),
      ["body"],
    );
  });

  it("an acceptance body change returns body", () => {
    assert.deepEqual(
      differingFields(stored(), submitted(), {
        instruction: instructionHash,
        acceptance: `sha256:${"c".repeat(64)}`,
      }),
      ["body"],
    );
  });

  it("an acceptance appearing where the stored node has none returns body", () => {
    assert.deepEqual(
      differingFields(stored({ acceptanceBlob: null }), submitted(), {
        instruction: instructionHash,
        acceptance: `sha256:${"c".repeat(64)}`,
      }),
      ["body"],
    );
  });

  it("a depends_on change returns depends_on", () => {
    assert.deepEqual(
      differingFields(
        stored(),
        submitted({ dependencies: [otherObjectiveIdentity] }),
        sameBlobs(),
      ),
      ["depends_on"],
    );
  });

  it("a depends_on reorder returns nothing", () => {
    assert.deepEqual(
      differingFields(
        stored({ dependencies: [otherTaskIdentity, otherObjectiveIdentity] }),
        submitted({
          dependencies: [otherObjectiveIdentity, otherTaskIdentity],
        }),
        sameBlobs(),
      ),
      [],
    );
  });

  it("a depends_on duplicate returns nothing", () => {
    assert.deepEqual(
      differingFields(
        stored(),
        submitted({ dependencies: [otherTaskIdentity, otherTaskIdentity] }),
        sameBlobs(),
      ),
      [],
    );
  });

  it("a worker change in either direction returns worker", () => {
    assert.deepEqual(
      differingFields(stored(), submitted({ worker: "tdd@1" }), sameBlobs()),
      ["worker"],
    );
    assert.deepEqual(
      differingFields(
        stored({ worker: "tdd@1" }),
        submitted({ worker: null }),
        sameBlobs(),
      ),
      ["worker"],
    );
  });

  it("a repo change returns repo", () => {
    assert.deepEqual(
      differingFields(stored(), submitted({ repo: "repo_a" }), sameBlobs()),
      ["repo"],
    );
  });

  it("a cosmetic path move returns nothing", () => {
    assert.deepEqual(
      differingFields(
        stored(),
        submitted({ path: "plan/i--01/o--01/09-moved.md" }),
        sameBlobs(),
      ),
      [],
    );
  });

  it("a real parent move returns parent", () => {
    assert.deepEqual(
      differingFields(
        stored(),
        submitted({ parentIdentity: otherObjectiveIdentity }),
        sameBlobs(),
      ),
      ["parent"],
    );
  });

  it("two changes return the fields sorted", () => {
    assert.deepEqual(
      differingFields(
        stored(),
        submitted({ title: "Render the other", repo: "repo_a" }),
        sameBlobs(),
      ),
      ["repo", "title"],
    );
  });
});
