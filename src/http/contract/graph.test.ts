import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planImportRequest, planImportResponse } from "./graph.ts";

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
});
