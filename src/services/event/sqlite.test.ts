import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { seedRegistry, seedGraph } from "../../../test/helpers/rows.ts";
import type { Storage } from "../storage/index.ts";
import { StorageError } from "../storage/index.ts";
import { SqliteEventLog } from "./sqlite.ts";

const ulids = [
  "01HZY8QF3M4N5P6R7S8T9V0W1X",
  "01HZY8QF3N4N5P6R7S8T9V0W1X",
  "01HZY8QF3P4N5P6R7S8T9V0W1X",
] as const;

const firstId = "event_01HZY8QF3M4N5P6R7S8T9V0W1X";
const secondId = "event_01HZY8QF3N4N5P6R7S8T9V0W1X";
const thirdId = "event_01HZY8QF3P4N5P6R7S8T9V0W1X";

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

function appendThree(storage: Storage, log: SqliteEventLog): readonly string[] {
  const first = storage.transact((t) =>
    log.append(t, {
      subjectKind: "node",
      subjectId: "task_a",
      type: "task.done",
      actorKind: "daemon",
      actorId: "daemon_a",
      payload: { note: 1 },
    }),
  );
  const second = storage.transact((t) =>
    log.append(t, {
      subjectKind: "node",
      subjectId: "task_b",
      type: "task.started",
      actorKind: "human",
      actorId: "human_a",
      payload: null,
    }),
  );
  const third = storage.transact((t) =>
    log.append(t, {
      subjectKind: "run",
      subjectId: "run_a",
      type: "task.done",
      actorKind: "daemon",
      actorId: "daemon_b",
      payload: [1, 2],
    }),
  );
  return [first.id, second.id, third.id];
}

describe("src/services/event/sqlite.test", () => {
  it("append returns the recorded event with occurredAt from the id", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    const recorded = storage.transact((t) =>
      log.append(t, {
        subjectKind: "node",
        subjectId: "task_a",
        type: "task.done",
        actorKind: "daemon",
        actorId: "daemon_a",
        payload: { note: 1 },
      }),
    );

    assert.deepEqual(recorded, {
      id: firstId,
      subjectKind: "node",
      subjectId: "task_a",
      type: "task.done",
      actorKind: "daemon",
      actorId: "daemon_a",
      payload: { note: 1 },
      occurredAt: 1717928967284,
    });
  });

  it("the stored payload_json is the exact stringified payload", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    const recorded = storage.transact((t) =>
      log.append(t, {
        subjectKind: "node",
        subjectId: "task_a",
        type: "task.done",
        actorKind: "daemon",
        actorId: "daemon_a",
        payload: { note: 1 },
      }),
    );
    const row = storage.transact(
      (t) =>
        t.get("SELECT payload_json FROM event WHERE id = ?", [recorded.id]) as {
          payload_json: string;
        },
    );

    assert.equal(row.payload_json, '{"note":1}');
  });

  it("list with no filter returns the ids ascending", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log.list({}).map((event) => event.id),
      [firstId, secondId, thirdId],
    );
  });

  it("subjectKind filters to the matching subset", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log.list({ subjectKind: "node" }).map((event) => event.id),
      [firstId, secondId],
    );
  });

  it("subject filters to the matching subset", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log.list({ subject: "task_a" }).map((event) => event.id),
      [firstId],
    );
  });

  it("type filters to the matching subset", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log.list({ type: "task.done" }).map((event) => event.id),
      [firstId, thirdId],
    );
  });

  it("actorKind filters to the matching subset", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log.list({ actorKind: "daemon" }).map((event) => event.id),
      [firstId, thirdId],
    );
  });

  it("actor filters to the matching subset", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log.list({ actor: "daemon_b" }).map((event) => event.id),
      [thirdId],
    );
  });

  it("two filters together are an AND", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log
        .list({ subjectKind: "node", type: "task.done" })
        .map((event) => event.id),
      [firstId],
    );
  });

  it("after the first id returns the second and third only", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log.list({ after: firstId }).map((event) => event.id),
      [secondId, thirdId],
    );
  });

  it("limit returns the first n ids", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(
      log.list({ limit: 2 }).map((event) => event.id),
      [firstId, secondId],
    );
  });

  it("a filter matching no row returns an empty array", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    appendThree(storage, log);

    assert.deepEqual(log.list({ subject: "task_missing" }), []);
  });

  it("a null payload round-trips as null", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    storage.transact((t) =>
      log.append(t, {
        subjectKind: "node",
        subjectId: "task_b",
        type: "task.started",
        actorKind: "human",
        actorId: "human_a",
        payload: null,
      }),
    );

    const events = log.list({ subject: "task_b" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload, null);
  });

  it("an array payload round-trips as an array", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    storage.transact((t) =>
      log.append(t, {
        subjectKind: "run",
        subjectId: "run_a",
        type: "task.done",
        actorKind: "daemon",
        actorId: "daemon_b",
        payload: [1, 2],
      }),
    );

    const events = log.list({ subject: "run_a" });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, [1, 2]);
  });

  it("actorKind human and daemon both append", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    storage.transact((t) =>
      log.append(t, {
        subjectKind: "node",
        subjectId: "task_a",
        type: "task.done",
        actorKind: "human",
        actorId: "human_a",
        payload: null,
      }),
    );
    storage.transact((t) =>
      log.append(t, {
        subjectKind: "node",
        subjectId: "task_a",
        type: "task.done",
        actorKind: "daemon",
        actorId: "daemon_a",
        payload: null,
      }),
    );

    assert.equal(log.list({}).length, 2);
  });

  it("list reads an event appended earlier in the caller's own transaction", () => {
    const { storage, log, dispose } = build();
    after(() => dispose());

    const events = storage.transact((t) => {
      log.append(t, {
        subjectKind: "node",
        subjectId: "task_a",
        type: "task.done",
        actorKind: "daemon",
        actorId: "daemon_a",
        payload: null,
      });
      return log.list({}, t);
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]!.id, firstId);
    assert.equal(events[0]!.type, "task.done");
  });

  it("list without the caller's transaction refuses inside an open transaction", () => {
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
          return log.list({});
        }),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, "storage-transaction-failed");
        assert.equal(error.message, "a transaction is already open");
        return true;
      },
    );
  });
});
