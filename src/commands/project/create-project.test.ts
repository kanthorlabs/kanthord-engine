import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { ProjectView } from "../../domain/project-view.ts";
import {
  CreateProjectError,
  createProject,
  type CreateProjectDependencies,
} from "./create-project.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";

const PROJECT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const SECOND_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const projectId = `project_${PROJECT_ULID}`;

type RecordedAppend = Readonly<{
  transaction: Transaction;
  input: AppendEventInput;
}>;

function createRecordingEventLog(): Readonly<{
  events: EventLog;
  recorded: readonly RecordedAppend[];
}> {
  const recorded: RecordedAppend[] = [];
  return {
    recorded,
    events: {
      append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
        recorded.push({ transaction, input });
        return {
          id: "event_1",
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          type: input.type,
          actorKind: input.actorKind,
          actorId: input.actorId,
          payload: input.payload,
          occurredAt: 0,
        };
      },
      list(): readonly RecordedEvent[] {
        return [];
      },
    },
  };
}

function transactionSpy(
  storage: Storage,
): Readonly<{ storage: Storage; transactions: readonly Transaction[] }> {
  const transactions: Transaction[] = [];
  return {
    transactions,
    storage: {
      transact<T>(work: (transaction: Transaction) => T): T {
        return storage.transact((transaction) => {
          transactions.push(transaction);
          return work(transaction);
        });
      },
      migrate() {
        return storage.migrate();
      },
      status() {
        return storage.status();
      },
      close() {
        storage.close();
      },
      ping() {
        storage.ping();
      },
    },
  };
}

function countProjects(storage: Storage): number {
  return (
    storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS c FROM project"),
    ) as { c: number }
  ).c;
}

function bytewiseSorted(keys: readonly string[]): readonly string[] {
  return [...keys].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
}

describe("src/commands/project/create-project.test", () => {
  it("creates a project view with the minted id, an empty repository set and the clock time", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids: IdGenerator = createMockIdGenerator({ ulids: [PROJECT_ULID] });
    const clock: Clock = createMockClock({ start: 1700000000000, step: 1000 });
    const log = createRecordingEventLog();
    const dependencies: CreateProjectDependencies = {
      storage: temporary.storage,
      ids,
      clock,
      events: log.events,
    };

    const view: ProjectView = createProject(dependencies, {
      name: "kanthord-verify",
      actor: "ulrich",
    });

    assert.deepEqual(view, {
      id: projectId,
      name: "kanthord-verify",
      repositories: [],
      updatedAt: 1700000000000,
    });
    assert.deepEqual(bytewiseSorted(Object.keys(view)), [
      "id",
      "name",
      "repositories",
      "updatedAt",
    ]);
  });

  it("inserts worker and e2e_json as null", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const dependencies: CreateProjectDependencies = {
      storage: temporary.storage,
      ids: createMockIdGenerator({ ulids: [PROJECT_ULID] }),
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      events: createRecordingEventLog().events,
    };

    createProject(dependencies, {
      name: "kanthord-verify",
      actor: "ulrich",
    });

    const row = temporary.storage.transact((transaction) =>
      transaction.get("SELECT worker, e2e_json FROM project WHERE id = ?", [
        projectId,
      ]),
    ) as { worker: unknown; e2e_json: unknown };
    assert.equal(row.worker, null);
    assert.equal(row.e2e_json, null);
  });

  it("a second create with the same name refuses name-taken and writes nothing", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const dependencies: CreateProjectDependencies = {
      storage: temporary.storage,
      ids: createMockIdGenerator({ ulids: [PROJECT_ULID, SECOND_ULID] }),
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      events: createRecordingEventLog().events,
    };

    createProject(dependencies, {
      name: "kanthord-verify",
      actor: "ulrich",
    });
    const before = countProjects(temporary.storage);

    assert.throws(
      () =>
        createProject(dependencies, {
          name: "kanthord-verify",
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof CreateProjectError && error.refusal === "name-taken",
    );
    assert.equal(countProjects(temporary.storage), before);
  });

  it("appends exactly one project.created event in the same transaction as the insert", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const spied = transactionSpy(temporary.storage);
    const log = createRecordingEventLog();
    const dependencies: CreateProjectDependencies = {
      storage: spied.storage,
      ids: createMockIdGenerator({ ulids: [PROJECT_ULID] }),
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      events: log.events,
    };

    createProject(dependencies, {
      name: "kanthord-verify",
      actor: "ulrich",
    });

    assert.equal(log.recorded.length, 1);
    const recorded = log.recorded[0]!;
    assert.equal(recorded.input.subjectKind, "project");
    assert.equal(recorded.input.subjectId, projectId);
    assert.equal(recorded.input.type, "project.created");
    assert.equal(recorded.input.actorKind, "human");
    assert.equal(recorded.input.actorId, "ulrich");
    assert.deepEqual(recorded.input.payload, { name: "kanthord-verify" });
    assert.equal(recorded.transaction, spied.transactions[0]);
  });

  it("the name-taken refusal appends no event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const log = createRecordingEventLog();
    const dependencies: CreateProjectDependencies = {
      storage: temporary.storage,
      ids: createMockIdGenerator({ ulids: [PROJECT_ULID, SECOND_ULID] }),
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      events: log.events,
    };

    createProject(dependencies, {
      name: "kanthord-verify",
      actor: "ulrich",
    });
    assert.throws(
      () =>
        createProject(dependencies, {
          name: "kanthord-verify",
          actor: "ulrich",
        }),
      (error: unknown) => error instanceof CreateProjectError,
    );
    assert.equal(log.recorded.length, 1);
  });
});
