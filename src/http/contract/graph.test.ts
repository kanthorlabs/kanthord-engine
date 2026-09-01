import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  nodeCreateRequest,
  nodeCreateResponse,
  nodeDeleteRequest,
  nodeDeleteResponse,
  nodeUpdateRequest,
  nodeUpdateResponse,
  nodeAttributes,
  nodeListItem,
  nodeShowResponse,
  planChoiceEntry,
  planChoiceValues,
  planImportRequest,
  planImportResponse,
  planValidateExamples,
  planValidateResponse,
  projectGraphResponse,
} from "./graph.ts";
import { findOperation } from "./registry.ts";

const body = (importId: string): Record<string, unknown> => ({
  fromRevision: "revision_a",
  importId,
  documents: [
    {
      path: "plan/i--01/o--01/01-t.md",
      content: `---
kind: task
title: Render the manifest
worker: tdd@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
    },
  ],
  choices: [{ id: "task_01ERZ3NDEKTSV4RRFFQ69G5FAV", take: "submitted" }],
  validatedRevision: "revision_a",
  documentsHash: `sha256:${"0".repeat(64)}`,
});

const choiceEntry = {
  id: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  kind: "task",
  presence: "both",
  state: "ready",
  suggested: "submitted",
  fields: ["title"],
  path: "initiative/atlas.md",
  submitted: { legal: true, reason: null, values: { title: "a" } },
  database: { legal: true, reason: null, values: { title: "b" } },
};

const nodeAttributesBase = {
  kind: "task",
  title: "add the health route",
  state: "ready",
  blockReason: null,
  discardReason: null,
  assignment: null,
  parentId: "objective_a",
  repositoryId: null,
};

describe("src/http/contract/graph.test", () => {
  it("planImportRequest accepts the legal importId values", () => {
    for (const importId of [
      "import_01JQ8Z7G3H",
      "a",
      "release candidate",
      "a".repeat(100),
      "!~",
    ]) {
      assert.equal(
        planImportRequest.safeParse(body(importId)).success,
        true,
        JSON.stringify(importId),
      );
    }
  });

  it("planImportRequest refuses the illegal importId values", () => {
    for (const importId of [
      "",
      "a".repeat(101),
      " ab",
      "ab ",
      " ",
      "a\tb",
      "café",
      "a\nb",
    ]) {
      assert.equal(
        planImportRequest.safeParse(body(importId)).success,
        false,
        JSON.stringify(importId),
      );
    }
  });

  it("planImportRequest parses a full valid body", () => {
    const parsed = planImportRequest.safeParse(body("import_01JQ8Z7G3H"));
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.importId, "import_01JQ8Z7G3H");
      assert.equal(parsed.data.documents.length, 1);
      assert.equal(parsed.data.choices.length, 1);
    }
  });

  it("planImportResponse parses the response shape and carries no retried member", () => {
    assert.equal(
      planImportResponse.safeParse({
        revision: "revision_a",
        documents: [
          {
            path: "plan/ship-kanthord--01arz3ndektsv4rrffq69g5fav/initiative.md",
            content:
              '---\nid: "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV"\n---\nBody.\n',
          },
        ],
        absent: [],
        completeness: [],
      }).success,
      true,
    );
    assert.equal(
      planImportResponse.safeParse({
        revision: "revision_a",
        documents: [{ path: "plan/x.md", content: "y" }],
        absent: [1],
      }).success,
      false,
    );
    assert.equal("retried" in planImportResponse.shape, false);
  });

  it("nodeCreateRequest parses an initiative with no parentId and no repo", () => {
    const parsed = nodeCreateRequest.safeParse({
      fromRevision: null,
      node: {
        kind: "initiative",
        title: "Ship the release",
        instruction: "Do the work.\n",
        worker: null,
        dependsOn: [],
      },
    });
    assert.equal(parsed.success, true);
  });

  it("nodeCreateRequest parses an objective with parentId and repo and no acceptance", () => {
    const parsed = nodeCreateRequest.safeParse({
      fromRevision: "revision_a",
      node: {
        kind: "objective",
        title: "Ship the release",
        parentId: "initiative_a",
        repo: "kanthord-verify",
        instruction: "Do the work.\n",
        worker: null,
        dependsOn: [],
      },
    });
    assert.equal(parsed.success, true);
  });

  it("nodeCreateRequest parses a task with parentId and acceptance and no repo", () => {
    const parsed = nodeCreateRequest.safeParse({
      fromRevision: "revision_a",
      node: {
        kind: "task",
        title: "Ship the release",
        parentId: "objective_a",
        instruction: "Do the work.\n",
        acceptance: "## Acceptance criteria\n- it works\n",
        worker: null,
        dependsOn: [],
      },
    });
    assert.equal(parsed.success, true);
  });

  it("nodeCreateRequest rejects a repo on a task, a missing repo on an objective and an omitted editable field", () => {
    const task = {
      kind: "task",
      title: "t",
      parentId: "objective_a",
      instruction: "i\n",
      acceptance: "a\n",
      worker: null,
      dependsOn: [],
    };
    assert.equal(
      nodeCreateRequest.safeParse({
        fromRevision: null,
        node: { ...task, repo: "kanthord-verify" },
      }).success,
      false,
    );
    assert.equal(
      nodeCreateRequest.safeParse({
        fromRevision: null,
        node: {
          kind: "objective",
          title: "o",
          parentId: "initiative_a",
          instruction: "i\n",
          worker: null,
          dependsOn: [],
        },
      }).success,
      false,
    );
    assert.equal(
      nodeCreateRequest.safeParse({
        fromRevision: null,
        node: {
          kind: "initiative",
          instruction: "i\n",
          worker: null,
          dependsOn: [],
        },
      }).success,
      false,
    );
  });

  it("nodeCreateRequest.fromRevision is nullable, nodeUpdateRequest and nodeDeleteRequest carry a string", () => {
    assert.equal(
      nodeCreateRequest.safeParse({
        fromRevision: null,
        node: {
          kind: "initiative",
          title: "t",
          instruction: "i\n",
          worker: null,
          dependsOn: [],
        },
      }).success,
      true,
    );
    assert.equal(
      nodeUpdateRequest.safeParse({
        fromRevision: null,
        node: {
          kind: "initiative",
          title: "t",
          instruction: "i\n",
          worker: null,
          dependsOn: [],
        },
      }).success,
      false,
    );
    assert.equal(
      nodeDeleteRequest.safeParse({ fromRevision: null }).success,
      false,
    );
    assert.equal(
      nodeDeleteRequest.safeParse({ fromRevision: "revision_a" }).success,
      true,
    );
  });

  it("the three responses parse with a revision string and the completeness array", () => {
    assert.equal(
      nodeCreateResponse.safeParse({
        revision: "revision_a",
        id: "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        completeness: [],
      }).success,
      true,
    );
    assert.equal(
      nodeCreateResponse.safeParse({
        id: "x",
        completeness: [],
      }).success,
      false,
    );
    assert.equal(
      nodeUpdateResponse.safeParse({
        revision: "revision_a",
        completeness: [
          {
            code: "objective-without-task",
            path: null,
            id: "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV",
            message: "an objective with no task is incomplete",
          },
        ],
      }).success,
      true,
    );
    assert.equal(
      nodeUpdateResponse.safeParse({ revision: "revision_a" }).success,
      false,
    );
    assert.equal(
      nodeDeleteResponse.safeParse({
        revision: "revision_a",
        deleted: ["task_a"],
        completeness: [],
      }).success,
      true,
    );
  });

  it("the three node operations declare memory idempotency, replayable 200 and the harness actor", () => {
    for (const operationId of ["node.create", "node.update", "node.delete"]) {
      const entry = findOperation(operationId);
      assert.ok(entry !== undefined, `${operationId} is not registered`);
      assert.equal(entry!.method, "POST");
      assert.equal(entry!.idempotency, "memory", operationId);
      assert.deepEqual(entry!.replayable, [200], operationId);
      assert.deepEqual(entry!.allowedActors, ["human", "harness"], operationId);
    }
  });

  it("the three node operations declare the four error codes beside the baseline", () => {
    for (const operationId of ["node.create", "node.update", "node.delete"]) {
      const entry = findOperation(operationId);
      assert.ok(entry !== undefined);
      const declared = Object.keys(entry!.errors ?? {}).sort();
      for (const code of [
        "stale-revision",
        "plan-invalid",
        "illegal-transition",
        "binding-in-use",
      ]) {
        assert.ok(declared.includes(code), `${operationId} misses ${code}`);
      }
    }
  });

  it("projectGraphResponse refuses unknown attribute keys in nodes, edges, attributes, options", () => {
    const validBase = {
      attributes: { projectId: "project_a", revision: "revision_a" },
      options: { allowSelfLoops: false, multi: false, type: "directed" },
      nodes: [
        {
          key: "initiative_a",
          attributes: {
            kind: "initiative",
            title: "Harden the verify CLI",
            state: "pending",
            blockReason: null,
            discardReason: null,
            assignment: null,
            parentId: null,
            repositoryId: null,
          },
        },
      ],
      edges: [
        {
          key: "edge_a",
          source: "task_a",
          target: "objective_a",
          attributes: { relation: "depends-on", waivedAt: null },
        },
      ],
    };

    // unknown key in top-level attributes
    assert.equal(
      projectGraphResponse.safeParse({
        ...validBase,
        attributes: { ...validBase.attributes, extra: "value" },
      }).success,
      false,
    );
    // unknown key in options
    assert.equal(
      projectGraphResponse.safeParse({
        ...validBase,
        options: { ...validBase.options, extra: "value" },
      }).success,
      false,
    );
    // unknown key in node attributes
    assert.equal(
      projectGraphResponse.safeParse({
        ...validBase,
        nodes: [
          {
            ...validBase.nodes[0]!,
            attributes: { ...validBase.nodes[0]!.attributes, extra: "value" },
          },
        ],
      }).success,
      false,
    );
    // unknown key in edge attributes
    assert.equal(
      projectGraphResponse.safeParse({
        ...validBase,
        edges: [
          {
            ...validBase.edges[0]!,
            attributes: { ...validBase.edges[0]!.attributes, extra: "value" },
          },
        ],
      }).success,
      false,
    );
  });

  it("nodeAttributes accepts a deliverable and a verify block", () => {
    assert.equal(
      nodeAttributes.safeParse({
        ...nodeAttributesBase,
        deliverable: "test",
        verify: { paths: ["/a/b.ts"], commands: ["npm test"] },
      }).success,
      true,
    );
  });

  it("nodeAttributes accepts null deliverable and verify fields", () => {
    assert.equal(
      nodeAttributes.safeParse({
        ...nodeAttributesBase,
        deliverable: null,
        verify: null,
      }).success,
      true,
    );
  });

  it("nodeAttributes refuses an invalid deliverable", () => {
    assert.equal(
      nodeAttributes.safeParse({
        ...nodeAttributesBase,
        deliverable: "invalid",
        verify: null,
      }).success,
      false,
    );
  });

  it("nodeShowResponse accepts nullable deliverable and verify fields", () => {
    const base = {
      id: "task_a",
      projectId: "project_a",
      kind: "task",
      title: "add the health route",
      state: "ready",
      blockReason: null,
      discardReason: null,
      parentId: "objective_a",
      dependencies: [],
      instructionBlob: `sha256:${"a".repeat(64)}`,
      acceptanceBlob: null,
      instruction: "Build the route.\n",
      acceptance: null,
      worker: null,
      assignment: null,
      repositoryId: null,
      repo: null,
      revision: "revision_a",
      updatedAt: 1,
      attestedObjectId: null,
      projection: null,
    };
    for (const fields of [
      { deliverable: null, verify: null },
      {
        deliverable: "review",
        verify: { paths: ["/a/b.ts"], commands: ["npm test"] },
      },
    ]) {
      assert.equal(
        nodeShowResponse.safeParse({ ...base, ...fields }).success,
        true,
      );
    }
  });

  it("nodeShowResponse carries assignment as a nullable string", () => {
    const base = {
      id: "task_a",
      projectId: "project_a",
      kind: "task",
      title: "add the health route",
      state: "ready",
      blockReason: null,
      discardReason: null,
      parentId: "objective_a",
      dependencies: [],
      instructionBlob: `sha256:${"a".repeat(64)}`,
      acceptanceBlob: null,
      instruction: "Build the route.\n",
      acceptance: null,
      worker: null,
      repositoryId: null,
      repo: null,
      revision: "revision_a",
      updatedAt: 1,
      attestedObjectId: null,
      projection: null,
      deliverable: null,
      verify: null,
    };
    assert.equal(
      nodeShowResponse.safeParse({ ...base, assignment: "general@1" }).success,
      true,
    );
    assert.equal(
      nodeShowResponse.safeParse({ ...base, assignment: null }).success,
      true,
    );
    assert.equal(nodeShowResponse.safeParse(base).success, false);
  });

  it("nodeListItem does not carry assignment", () => {
    const validListItem = {
      id: "task_a",
      projectId: "project_a",
      kind: "task",
      title: "add the health route",
      state: "ready",
      blockReason: null,
      discardReason: null,
      parentId: "objective_a",
      dependencies: [],
    };
    assert.equal(
      nodeListItem.safeParse({ ...validListItem, assignment: null }).success,
      false,
    );
  });

  it("planChoiceEntry accepts an entry whose branches carry values and a path", () => {
    assert.equal(planChoiceEntry.safeParse(choiceEntry).success, true);
  });

  it("planChoiceEntry refuses the pre-epic entry whose branches carry no values", () => {
    const preEpic = {
      ...choiceEntry,
      submitted: { legal: true, reason: null },
      database: { legal: true, reason: null },
    };
    assert.equal(planChoiceEntry.safeParse(preEpic).success, false);
  });

  it("planChoiceEntry refuses a branch that misses only its values", () => {
    const entry = {
      ...choiceEntry,
      submitted: { legal: true, reason: null },
    };
    assert.equal(planChoiceEntry.safeParse(entry).success, false);
  });

  it("planChoiceValues accepts an empty record and the three nullable names", () => {
    assert.equal(planChoiceValues.safeParse({}).success, true);
    assert.equal(
      planChoiceValues.safeParse({ parent: null, repo: null, worker: null })
        .success,
      true,
    );
  });

  it("planChoiceValues refuses a numeric title, a null title and an unknown key", () => {
    assert.equal(planChoiceValues.safeParse({ title: 1 }).success, false);
    assert.equal(planChoiceValues.safeParse({ title: null }).success, false);
    assert.equal(planChoiceValues.safeParse({ unknown: "x" }).success, false);
  });

  it("depends_on keeps its underscore and refuses the camelCase spelling", () => {
    assert.equal(planChoiceValues.safeParse({ dependsOn: [] }).success, false);
    assert.equal(
      planChoiceValues.safeParse({ depends_on: ["task_a", "task_b"] }).success,
      true,
    );
  });

  it("planChoiceValues parses all six names together", () => {
    assert.equal(
      planChoiceValues.safeParse({
        body: {
          instructionBlob: `sha256:${"a".repeat(64)}`,
          acceptanceBlob: null,
        },
        depends_on: ["task_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
        parent: null,
        repo: null,
        title: "a",
        worker: null,
      }).success,
      true,
    );
  });

  it("body carries a pair of blob hashes and accepts a null acceptanceBlob", () => {
    assert.equal(
      planChoiceValues.safeParse({
        body: {
          instructionBlob: `sha256:${"a".repeat(64)}`,
          acceptanceBlob: `sha256:${"b".repeat(64)}`,
        },
      }).success,
      true,
    );
    assert.equal(
      planChoiceValues.safeParse({
        body: {
          instructionBlob: `sha256:${"a".repeat(64)}`,
          acceptanceBlob: null,
        },
      }).success,
      true,
    );
  });

  it("body refuses a null instructionBlob, a non-hash, a missing hash and uppercase hex", () => {
    assert.equal(
      planChoiceValues.safeParse({
        body: { instructionBlob: null, acceptanceBlob: null },
      }).success,
      false,
    );
    assert.equal(
      planChoiceValues.safeParse({
        body: { instructionBlob: "not-a-hash", acceptanceBlob: null },
      }).success,
      false,
    );
    assert.equal(
      planChoiceValues.safeParse({ body: { acceptanceBlob: null } }).success,
      false,
    );
    assert.equal(
      planChoiceValues.safeParse({
        body: {
          instructionBlob: `sha256:${"A".repeat(64)}`,
          acceptanceBlob: null,
        },
      }).success,
      false,
    );
  });

  it("body refuses a third key", () => {
    assert.equal(
      planChoiceValues.safeParse({
        body: {
          instructionBlob: `sha256:${"a".repeat(64)}`,
          acceptanceBlob: null,
          extra: "x",
        },
      }).success,
      false,
    );
  });

  it("path is required and nullable", () => {
    assert.equal(
      planChoiceEntry.safeParse({ ...choiceEntry, path: null }).success,
      true,
    );
    const withoutPath: Record<string, unknown> = { ...choiceEntry };
    delete withoutPath.path;
    assert.equal(planChoiceEntry.safeParse(withoutPath).success, false);
    assert.equal(
      planChoiceEntry.safeParse({ ...choiceEntry, path: 1 }).success,
      false,
    );
  });

  it("the plan.validate example carries one both entry whose values name the two titles", () => {
    const parsed = planValidateResponse.parse(planValidateExamples.success);
    assert.equal(parsed.choices.length, 1);
    const entry = parsed.choices[0]!;
    assert.equal(entry.presence, "both");
    assert.deepEqual(entry.fields, ["title"]);
    assert.deepEqual(Object.keys(entry.submitted.values), ["title"]);
    assert.deepEqual(Object.keys(entry.database.values), ["title"]);
    assert.equal(entry.submitted.values.title, "add the health route");
    assert.equal(entry.database.values.title, "add the health check");
    assert.notEqual(entry.submitted.values.title, entry.database.values.title);
  });

  it("the plan.validate example joins its choice path to one document", () => {
    const parsed = planValidateResponse.parse(planValidateExamples.success);
    const entry = parsed.choices[0]!;
    assert.equal(entry.path, "initiative/atlas.md");
    assert.equal(
      parsed.documents.filter((document) => document.path === entry.path)
        .length,
      1,
    );
  });
});
