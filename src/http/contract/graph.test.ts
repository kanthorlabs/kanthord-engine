import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  nodeCreateRequest,
  nodeCreateResponse,
  nodeDeleteRequest,
  nodeDeleteResponse,
  nodeUpdateRequest,
  nodeUpdateResponse,
  planImportRequest,
  planImportResponse,
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
});
