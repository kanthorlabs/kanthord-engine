import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { seedRegistry, seedGraph } from "../../../test/helpers/rows.ts";
import { StorageError } from "../storage/index.ts";
import type { Storage } from "../storage/index.ts";
import { SqliteEventLog } from "./sqlite.ts";

const ulids = [
  "01HZY8QF3M4N5P6R7S8T9V0W1X",
  "01HZY8QF3N4N5P6R7S8T9V0W1X",
  "01HZY8QF3P4N5P6R7S8T9V0W1X",
] as const;

function build(): { storage: Storage; log: SqliteEventLog; dispose(): void } {
  const temporary = createMigratedStorage();
  temporary.storage.transact((t) => {
    seedRegistry(t);
    seedGraph(t);
  });
  return {
    storage: temporary.storage,
    log: new SqliteEventLog({
      storage: temporary.storage,
      ids: createMockIdGenerator({ ulids }),
    }),
    dispose: temporary.dispose,
  };
}

describe("src/services/event/atomicity.test", () => {
  it("a failed event append leaves the state row unchanged", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    assert.throws(
      () =>
        storage.transact((t) => {
          t.run(
            "UPDATE node SET state = 'done', updated_at = 2 WHERE id = 'task_a'",
          );
          log.append(t, {
            subjectKind: "node",
            subjectId: "task_a",
            type: "task.done",
            actorKind: "robot" as never,
            actorId: "daemon_a",
            payload: null,
          });
        }),
      (error: unknown) => {
        assert.ok(!(error instanceof StorageError));
        return true;
      },
    );

    const nodeRow = storage.transact(
      (t) =>
        t.get("SELECT state, updated_at FROM node WHERE id = 'task_a'") as {
          state: string;
          updated_at: number;
        },
    );
    const count = storage.transact(
      (t) => t.get("SELECT COUNT(*) AS c FROM event") as { c: number },
    );
    assert.deepEqual({ ...nodeRow }, { state: "pending", updated_at: 1 });
    assert.equal(count.c, 0);
  });

  it("a failed state write leaves no event", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    assert.throws(() =>
      storage.transact((t) => {
        log.append(t, {
          subjectKind: "node",
          subjectId: "task_a",
          type: "task.done",
          actorKind: "daemon",
          actorId: "daemon_a",
          payload: null,
        });
        t.run("UPDATE node SET state = 'nonsense' WHERE id = 'task_a'");
      }),
    );

    const count = storage.transact(
      (t) => t.get("SELECT COUNT(*) AS c FROM event") as { c: number },
    );
    const nodeRow = storage.transact(
      (t) =>
        t.get("SELECT state FROM node WHERE id = 'task_a'") as {
          state: string;
        },
    );
    assert.equal(count.c, 0);
    assert.equal(nodeRow.state, "pending");
  });

  it("the success case commits the state write and the event append", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    storage.transact((t) => {
      t.run(
        "UPDATE node SET state = 'done', updated_at = 2 WHERE id = 'task_a'",
      );
      log.append(t, {
        subjectKind: "node",
        subjectId: "task_a",
        type: "task.done",
        actorKind: "daemon",
        actorId: "daemon_a",
        payload: { note: 1 },
      });
    });

    const nodeRow = storage.transact(
      (t) =>
        t.get("SELECT state, updated_at FROM node WHERE id = 'task_a'") as {
          state: string;
          updated_at: number;
        },
    );
    const count = storage.transact(
      (t) => t.get("SELECT COUNT(*) AS c FROM event") as { c: number },
    );
    assert.deepEqual({ ...nodeRow }, { state: "done", updated_at: 2 });
    assert.equal(count.c, 1);

    const events = log.list({ subject: "task_a" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "task.done");
    assert.equal((events[0]!.payload as { note: number }).note, 1);
  });

  it("the thrown error in a failed transaction is not a StorageError", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    assert.throws(
      () =>
        storage.transact((t) => {
          log.append(t, {
            subjectKind: "node",
            subjectId: "task_a",
            type: "task.done",
            actorKind: "daemon",
            actorId: "daemon_a",
            payload: null,
          });
          t.run("UPDATE node SET state = 'nonsense' WHERE id = 'task_a'");
        }),
      (error: unknown) => {
        assert.ok(!(error instanceof StorageError));
        return true;
      },
    );
  });
});
