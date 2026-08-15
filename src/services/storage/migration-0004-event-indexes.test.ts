import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { createMigratedStorage } from "../../../test/helpers/database.ts";
import type { TemporaryStorage } from "../../../test/helpers/database.ts";
import { migrations } from "./migrations.ts";

function explain(
  temporary: TemporaryStorage,
  sql: string,
  parameters: readonly unknown[] = [],
): readonly string[] {
  const rows = temporary.storage.transact((t) =>
    t.all(`EXPLAIN QUERY PLAN ${sql}`, parameters),
  ) as readonly Record<string, unknown>[];
  return rows.map((row) => String(row.detail));
}

describe("src/services/storage/migration-0004-event-indexes.test", () => {
  it("the three index names exist", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const rows = temporary.storage.transact((t) =>
      t.all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(
      rows.map((row) => row.name),
      ["event_actor", "event_subject", "event_type"],
    );
  });

  it("migrations holds six entries, versions 1 to 6 in order", () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      migrations.map((migration) => migration.name),
      [
        "0001-core-entities",
        "0002-graph-and-plan",
        "0003-execution-and-journal",
        "0004-event-indexes",
        "0005-actor",
        "0006-revision-origin",
      ],
    );
  });

  it("a subjectKind + subject filter is satisfied from event_subject", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const plan = explain(
      temporary,
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event WHERE subject_kind = ? AND subject_id = ? ORDER BY id ASC LIMIT ?",
      ["node", "node_x", 10],
    );
    assert.ok(
      plan.some((line) => line.includes("event_subject")),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("USE TEMP B-TREE FOR ORDER BY")),
      plan.join("\n"),
    );
  });

  it("a type filter is satisfied from event_type", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const plan = explain(
      temporary,
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event WHERE type = ? ORDER BY id ASC LIMIT ?",
      ["node.created", 10],
    );
    assert.ok(
      plan.some((line) => line.includes("event_type")),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("USE TEMP B-TREE FOR ORDER BY")),
      plan.join("\n"),
    );
  });

  it("an actorKind + actor filter is satisfied from event_actor", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const plan = explain(
      temporary,
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event WHERE actor_kind = ? AND actor_id = ? ORDER BY id ASC LIMIT ?",
      ["daemon", "d1", 10],
    );
    assert.ok(
      plan.some((line) => line.includes("event_actor")),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("USE TEMP B-TREE FOR ORDER BY")),
      plan.join("\n"),
    );
  });

  it("a subjectKind + subject filter with a cursor is seeked from event_subject", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const plan = explain(
      temporary,
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event WHERE subject_kind = ? AND subject_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
      ["node", "node_x", "01ARZ3NDEKTSV4RRFFQ69G5FAV", 10],
    );
    assert.ok(
      plan.some((line) =>
        line.includes(
          "event_subject (subject_kind=? AND subject_id=? AND id>?)",
        ),
      ),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("USE TEMP B-TREE FOR ORDER BY")),
      plan.join("\n"),
    );
  });

  it("a type filter with a cursor is seeked from event_type", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const plan = explain(
      temporary,
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event WHERE type = ? AND id > ? ORDER BY id ASC LIMIT ?",
      ["node.created", "01ARZ3NDEKTSV4RRFFQ69G5FAV", 10],
    );
    assert.ok(
      plan.some((line) => line.includes("event_type (type=? AND id>?)")),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("USE TEMP B-TREE FOR ORDER BY")),
      plan.join("\n"),
    );
  });

  it("an actorKind + actor filter with a cursor is seeked from event_actor", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const plan = explain(
      temporary,
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event WHERE actor_kind = ? AND actor_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
      ["daemon", "d1", "01ARZ3NDEKTSV4RRFFQ69G5FAV", 10],
    );
    assert.ok(
      plan.some((line) =>
        line.includes("event_actor (actor_kind=? AND actor_id=? AND id>?)"),
      ),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("USE TEMP B-TREE FOR ORDER BY")),
      plan.join("\n"),
    );
  });

  it("the unfiltered read walks the primary key, using no index and no temp b-tree", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const plan = explain(temporary, "SELECT id FROM event ORDER BY id ASC");
    assert.ok(
      !plan.some((line) => line.includes("event_subject")),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("event_type")),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("event_actor")),
      plan.join("\n"),
    );
    assert.ok(
      !plan.some((line) => line.includes("USE TEMP B-TREE FOR ORDER BY")),
      plan.join("\n"),
    );
  });
});
