import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { differingFields, storedValues, submittedValues } from "./plan-diff.ts";
import { differingFields as differingFieldNames } from "./node-write-legality.ts";
import type { StoredNode } from "./plan-graph.ts";
import type { ResolvedDocument } from "./plan-identity.ts";

const taskIdentity = "task_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const objectiveIdentity = "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV";
const otherTaskIdentity = "task_01DRZ3NDEKTSV4RRFFQ69G5FAV";
const otherObjectiveIdentity = "objective_01EZQZ3NDEKTSV4RRFFQ69G5FAV";

const emojiIdentity = "task_\u{1F600}";
const replacementIdentity = "task_\uFFFD";

const instructionHash = `sha256:${"a".repeat(64)}`;
const acceptanceHash = `sha256:${"b".repeat(64)}`;
const otherInstructionHash = `sha256:${"c".repeat(64)}`;
const otherAcceptanceHash = `sha256:${"d".repeat(64)}`;

const storedBase: StoredNode = {
  id: taskIdentity,
  projectId: "project_a",
  kind: "task",
  parentId: objectiveIdentity,
  title: "Render the manifest",
  instructionBlob: instructionHash,
  acceptanceBlob: acceptanceHash,
  worker: null,
  assignment: null,
  repositoryId: null,
  state: "pending",
  blockReason: null,
  discardReason: null,
  revision: "revision_a",
  updatedAt: 1,
  deliverable: null,
  verifyJson: null,
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
  deliverable: null,
  verify: null,
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

  it("storedValues publishes exactly the selected field", () => {
    assert.deepEqual(storedValues(stored(), ["title"]), {
      title: "Render the manifest",
    });
  });

  it("storedValues selects nothing when the field list is empty", () => {
    assert.deepEqual(storedValues(stored(), []), {});
  });

  it("storedValues publishes all six values when the side is the only side", () => {
    assert.deepEqual(storedValues(stored(), null), {
      body: {
        instructionBlob: instructionHash,
        acceptanceBlob: acceptanceHash,
      },
      depends_on: [otherTaskIdentity],
      parent: objectiveIdentity,
      repo: null,
      title: "Render the manifest",
      worker: null,
    });
  });

  it("a stored node without an acceptance publishes a null acceptanceBlob", () => {
    assert.deepEqual(
      storedValues(stored({ acceptanceBlob: null }), ["body"]).body,
      { instructionBlob: instructionHash, acceptanceBlob: null },
    );
  });

  it("a null value stays a present key with a null value", () => {
    const result = storedValues(
      stored({ worker: null, repositoryId: null, parentId: null }),
      null,
    );
    assert.equal(Object.hasOwn(result, "worker"), true);
    assert.equal(Object.hasOwn(result, "repo"), true);
    assert.equal(Object.hasOwn(result, "parent"), true);
    assert.equal(result.worker, null);
    assert.equal(result.repo, null);
    assert.equal(result.parent, null);
  });

  it("an unselected name is absent from the record", () => {
    const result = storedValues(stored(), ["worker"]);
    assert.equal(Object.hasOwn(result, "worker"), true);
    assert.equal(Object.hasOwn(result, "title"), false);
  });

  it("storedValues maps parent from parentId and repo from repositoryId", () => {
    assert.deepEqual(
      storedValues(
        stored({
          parentId: otherObjectiveIdentity,
          repositoryId: "repository_a",
        }),
        ["parent", "repo"],
      ),
      { parent: otherObjectiveIdentity, repo: "repository_a" },
    );
  });

  it("submittedValues publishes exactly the selected field", () => {
    assert.deepEqual(submittedValues(submitted(), sameBlobs(), ["title"]), {
      title: "Render the manifest",
    });
  });

  it("submittedValues selects nothing when the field list is empty", () => {
    assert.deepEqual(submittedValues(submitted(), sameBlobs(), []), {});
  });

  it("submittedValues publishes all six values when the side is the only side", () => {
    assert.deepEqual(submittedValues(submitted(), sameBlobs(), null), {
      body: {
        instructionBlob: instructionHash,
        acceptanceBlob: acceptanceHash,
      },
      depends_on: [otherTaskIdentity],
      parent: objectiveIdentity,
      repo: null,
      title: "Render the manifest",
      worker: null,
    });
  });

  it("a submitted body pair comes from the blob hashes argument", () => {
    assert.deepEqual(
      submittedValues(
        submitted(),
        { instruction: otherInstructionHash, acceptance: null },
        ["body"],
      ).body,
      { instructionBlob: otherInstructionHash, acceptanceBlob: null },
    );
  });

  it("submittedValues maps parent from parentIdentity and repo from repo", () => {
    assert.deepEqual(
      submittedValues(
        submitted({
          parentIdentity: otherObjectiveIdentity,
          repo: "repository_b",
        }),
        sameBlobs(),
        ["parent", "repo"],
      ),
      { parent: otherObjectiveIdentity, repo: "repository_b" },
    );
  });

  it("submittedValues reads the resolved dependencies and not the raw frontmatter list", () => {
    assert.deepEqual(
      submittedValues(
        submitted({
          dependencies: [otherTaskIdentity],
          dependsOn: ["plan/whatever.md"],
        }),
        sameBlobs(),
        ["depends_on"],
      ),
      { depends_on: [otherTaskIdentity] },
    );
  });

  it("a body conflict names both blobs on each side", () => {
    const database = storedValues(stored(), ["body"]);
    const document = submittedValues(
      submitted(),
      { instruction: instructionHash, acceptance: otherAcceptanceHash },
      ["body"],
    );
    assert.deepEqual(database.body, {
      instructionBlob: instructionHash,
      acceptanceBlob: acceptanceHash,
    });
    assert.deepEqual(document.body, {
      instructionBlob: instructionHash,
      acceptanceBlob: otherAcceptanceHash,
    });
    assert.equal(
      database.body?.instructionBlob,
      document.body?.instructionBlob,
    );
    assert.notEqual(
      database.body?.acceptanceBlob,
      document.body?.acceptanceBlob,
    );
  });

  it("an absent stored acceptance and a supplied submitted acceptance differ inside body", () => {
    assert.equal(
      storedValues(stored({ acceptanceBlob: null }), ["body"]).body
        ?.acceptanceBlob,
      null,
    );
    assert.equal(
      submittedValues(submitted(), sameBlobs(), ["body"]).body?.acceptanceBlob,
      acceptanceHash,
    );
  });

  it("a reorder with a repeat is no conflict and still publishes the normalized list", () => {
    const thatStored = stored({
      dependencies: [otherTaskIdentity, taskIdentity],
    });
    const thatSubmitted = submitted({
      dependencies: [taskIdentity, otherTaskIdentity, otherTaskIdentity],
    });
    assert.equal(
      differingFields(thatStored, thatSubmitted, sameBlobs()).includes(
        "depends_on",
      ),
      false,
    );
    assert.deepEqual(storedValues(thatStored, null).depends_on, [
      taskIdentity,
      otherTaskIdentity,
    ]);
    assert.deepEqual(
      submittedValues(thatSubmitted, sameBlobs(), null).depends_on,
      [taskIdentity, otherTaskIdentity],
    );
    assert.deepEqual(
      storedValues(thatStored, null).depends_on,
      submittedValues(thatSubmitted, sameBlobs(), null).depends_on,
    );
  });

  it("a genuinely different dependency publishes two different normalized lists", () => {
    const thatStored = stored({ dependencies: [otherTaskIdentity] });
    const thatSubmitted = submitted({
      dependencies: [taskIdentity, taskIdentity],
    });
    assert.equal(
      differingFields(thatStored, thatSubmitted, sameBlobs()).includes(
        "depends_on",
      ),
      true,
    );
    assert.deepEqual(storedValues(thatStored, ["depends_on"]), {
      depends_on: [otherTaskIdentity],
    });
    assert.deepEqual(
      submittedValues(thatSubmitted, sameBlobs(), ["depends_on"]),
      {
        depends_on: [taskIdentity],
      },
    );
  });

  it("depends_on is ordered by code point and not by UTF-16 code unit", () => {
    assert.deepEqual(
      storedValues(
        stored({ dependencies: [emojiIdentity, replacementIdentity] }),
        ["depends_on"],
      ),
      { depends_on: [replacementIdentity, emojiIdentity] },
    );
    assert.deepEqual(
      submittedValues(
        submitted({ dependencies: [emojiIdentity, replacementIdentity] }),
        sameBlobs(),
        ["depends_on"],
      ),
      { depends_on: [replacementIdentity, emojiIdentity] },
    );
    assert.deepEqual([emojiIdentity, replacementIdentity].sort(), [
      emojiIdentity,
      replacementIdentity,
    ]);
  });

  it("the value keys follow the differingFields order whatever the argument order", () => {
    const forward = [
      "body",
      "depends_on",
      "parent",
      "repo",
      "title",
      "worker",
    ] as const;
    const reversed = [...forward].reverse();
    assert.deepEqual(Object.keys(storedValues(stored(), null)), [...forward]);
    assert.deepEqual(Object.keys(storedValues(stored(), reversed)), [
      ...forward,
    ]);
    assert.equal(
      JSON.stringify(storedValues(stored(), reversed)),
      JSON.stringify(storedValues(stored(), forward)),
    );
    assert.deepEqual(
      Object.keys(submittedValues(submitted(), sameBlobs(), reversed)),
      [...forward],
    );
    assert.deepEqual(
      Object.keys(submittedValues(submitted(), sameBlobs(), forward)),
      [...forward],
    );
    assert.equal(
      JSON.stringify(submittedValues(submitted(), sameBlobs(), reversed)),
      JSON.stringify(submittedValues(submitted(), sameBlobs(), forward)),
    );
    assert.deepEqual(Object.keys(storedValues(stored(), ["worker", "body"])), [
      "body",
      "worker",
    ]);
  });

  it("the value keys are the differingFields vocabulary in its own order", () => {
    assert.deepEqual(Object.keys(storedValues(stored(), null)), [
      ...differingFieldNames,
    ]);
    assert.deepEqual(
      Object.keys(submittedValues(submitted(), sameBlobs(), null)),
      [...differingFieldNames],
    );
  });
});
