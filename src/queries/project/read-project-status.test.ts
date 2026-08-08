import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readProjectStatus } from "./read-project-status.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { projectStatusResponse } from "../../http/contract/project.ts";
import type { Storage } from "../../services/storage/index.ts";

describe("src/queries/project/read-project-status.test", () => {
  function build(): { storage: Storage; dispose(): void } {
    const temporary = createMigratedStorage();
    return { storage: temporary.storage, dispose: temporary.dispose };
  }

  it("returns the seeded project's node counts grouped by kind, state and block reason", (t) => {
    const { storage, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const result = readProjectStatus({ storage }, { id: fixtureIds.project });

    assert.deepEqual(
      result?.nodes.map((row) => ({ ...row })),
      [
        { kind: "initiative", state: "pending", blockReason: null, count: 1 },
        { kind: "objective", state: "pending", blockReason: null, count: 1 },
        { kind: "task", state: "pending", blockReason: null, count: 1 },
      ],
    );
  });

  it("an unknown project id returns null", (t) => {
    const { storage, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedRegistry);

    const result = readProjectStatus({ storage }, { id: "project_missing" });

    assert.equal(result, null);
  });

  it("a project with no nodes returns an empty node list, not null", (t) => {
    const { storage, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedRegistry);

    const result = readProjectStatus({ storage }, { id: fixtureIds.project });

    assert.deepEqual(result, { nodes: [] });
  });

  it("counts only the named project's nodes, never a second project's", (t) => {
    const { storage, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_b", "second-project", "general@1", null, 1],
      );
      transaction.run(
        "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          "revision_b",
          "project_b",
          null,
          "imp_b",
          fixtureIds.instructionBlob,
          fixtureIds.instructionBlob,
          fixtureIds.instructionBlob,
        ],
      );
      transaction.run(
        "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "b_initiative",
          "project_b",
          "initiative",
          null,
          "Second project",
          fixtureIds.instructionBlob,
          null,
          null,
          null,
          "pending",
          null,
          null,
          "revision_b",
          1,
        ],
      );
    });

    const result = readProjectStatus({ storage }, { id: fixtureIds.project });

    assert.deepEqual(
      result?.nodes.map((row) => ({ ...row })),
      [
        { kind: "initiative", state: "pending", blockReason: null, count: 1 },
        { kind: "objective", state: "pending", blockReason: null, count: 1 },
        { kind: "task", state: "pending", blockReason: null, count: 1 },
      ],
    );
  });

  it("each result passes projectStatusResponse.parse", (t) => {
    const { storage, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const result = readProjectStatus({ storage }, { id: fixtureIds.project });
    assert.equal(projectStatusResponse.safeParse(result).success, true);
  });
});
