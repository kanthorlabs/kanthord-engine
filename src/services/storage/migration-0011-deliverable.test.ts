import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMockClock } from "../../../test/helpers/clock.ts";
import { createStorageAtVersion } from "../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedNode,
  seedNodeWithDeliverable,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { deliverables } from "../../domain/deliverable.ts";
import { nodePairLegality } from "../../domain/node-pair.ts";
import { nodeKinds } from "../../domain/state.ts";
import { migration0011Deliverable } from "./migration-0011-deliverable.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const INITIATIVE_ID = "ini_01JTEST000000000000000000";
const OBJECTIVE_ID = "obj_01JTEST000000000000000000";
const TASK_ID = "tsk_01JTEST000000000000000000";

const originalColumns = [
  "id",
  "project_id",
  "kind",
  "parent_id",
  "title",
  "instruction_blob",
  "acceptance_blob",
  "worker",
  "repository_id",
  "state",
  "block_reason",
  "discard_reason",
  "revision",
  "updated_at",
] as const;

describe("src/services/storage/migration-0011-deliverable.ts", () => {
  it("preserves existing nodes and enforces all deliverable and verify checks", () => {
    assert.equal(migration0011Deliverable.version, 11);
    assert.equal(migration0011Deliverable.name, "0011-deliverable");
    assert.equal(migration0011Deliverable.rebuild, true);

    const base = createStorageAtVersion(10);
    let storage: SqliteStorage | undefined;
    try {
      base.storage.transact((transaction) => {
        seedRegistry(transaction);
        transaction.run(
          "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, NULL, 'import', ?, ?, ?, ?)",
          [
            fixtureIds.planRevision,
            fixtureIds.project,
            "imp_0011",
            fixtureIds.instructionBlob,
            fixtureIds.instructionBlob,
            fixtureIds.instructionBlob,
          ],
        );
        seedNode(transaction, {
          id: INITIATIVE_ID,
          kind: "initiative",
          parentId: null,
          title: "root",
          state: "pending",
        });
        seedNode(transaction, {
          id: OBJECTIVE_ID,
          kind: "objective",
          parentId: INITIATIVE_ID,
          title: "objective",
          state: "pending",
          repositoryId: fixtureIds.repository,
        });
        seedNode(transaction, {
          id: TASK_ID,
          kind: "task",
          parentId: OBJECTIVE_ID,
          title: "task",
          state: "pending",
          acceptanceBlob: fixtureIds.acceptanceBlob,
        });
      });

      const before = base.storage.transact((transaction) =>
        transaction.all("SELECT * FROM node ORDER BY id"),
      ) as readonly Readonly<Record<string, unknown>>[];
      base.storage.close();

      storage = new SqliteStorage({
        path: base.path,
        clock: createMockClock({ start: 1700000000000, step: 1000 }),
        migrations,
      });
      storage.migrate();
      assert.ok(
        storage.status().applied.some((migration) => migration.version === 11),
      );

      const columns = storage.transact((transaction) =>
        transaction.all("PRAGMA table_info(node)"),
      ) as readonly Readonly<Record<string, unknown>>[];
      const columnNames = columns.map((column) => column.name);
      for (const column of ["deliverable", "verify_json", "assignment"]) {
        assert.ok(columnNames.includes(column));
      }

      const migrated = storage.transact((transaction) =>
        transaction.all("SELECT * FROM node ORDER BY id"),
      ) as readonly Readonly<Record<string, unknown>>[];
      assert.equal(migrated.length, before.length);
      for (let index = 0; index < before.length; index += 1) {
        const oldRow = before[index];
        const newRow = migrated[index];
        assert.ok(oldRow !== undefined);
        assert.ok(newRow !== undefined);
        for (const column of originalColumns) {
          assert.strictEqual(newRow[column], oldRow[column]);
        }
        assert.strictEqual(newRow.deliverable, null);
        assert.strictEqual(newRow.verify_json, null);
        assert.strictEqual(newRow.assignment, null);
      }

      const domainLegal: string[] = [];
      const sqliteLegal: string[] = [];
      let taskExpansionError: unknown;
      let sequence = 0;
      for (const kind of nodeKinds) {
        for (const deliverable of deliverables) {
          const pair = `${kind}:${deliverable}`;
          if (nodePairLegality(kind, deliverable).legal) {
            domainLegal.push(pair);
          }
          sequence += 1;
          try {
            storage.transact((transaction) => {
              seedNodeWithDeliverable(transaction, {
                id: `pair_${sequence}`,
                kind,
                parentId:
                  kind === "initiative"
                    ? null
                    : kind === "objective"
                      ? INITIATIVE_ID
                      : OBJECTIVE_ID,
                title: pair,
                deliverable,
              });
            });
            sqliteLegal.push(pair);
          } catch (error) {
            if (kind === "task" && deliverable === "expansion") {
              taskExpansionError = error;
            }
          }
        }
      }
      assert.deepStrictEqual(domainLegal.sort(), sqliteLegal.sort());

      assert.throws(() =>
        storage?.transact((transaction) => {
          seedNodeWithDeliverable(transaction, {
            id: "obj_malformed_verify",
            kind: "objective",
            parentId: INITIATIVE_ID,
            title: "malformed verify",
            deliverable: "test",
            verifyJson: "{",
          });
        }),
      );

      assert.ok(taskExpansionError instanceof Error);
      assert.match(taskExpansionError.message, /CHECK/);
    } finally {
      storage?.close();
      base.dispose();
    }
  });
});
