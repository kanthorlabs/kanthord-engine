import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Storage, Transaction } from "../../../services/storage/index.ts";
import type {
  EventLog,
  RecordedEvent,
  AppendEventInput,
} from "../../../services/event/index.ts";
import type { IdGenerator } from "../../../services/ids/index.ts";
import type { Clock } from "../../../services/clock/index.ts";
import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import { createProjectHandler } from "./create-project.ts";
import { createProject } from "../../../commands/project/create-project.ts";
import { projectCreateResponse } from "../../contract/project.ts";

const PROJECT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const SECOND_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const daemonHome = "/var/lib/kanthord";

function silentEventLog(): EventLog {
  return {
    append(_transaction: Transaction, input: AppendEventInput): RecordedEvent {
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
  };
}

function countProjects(storage: Storage): number {
  return (
    storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS c FROM project"),
    ) as { c: number }
  ).c;
}

describe("src/http/server/project/create-project.test", () => {
  it("POST /v1/project with a valid name answers 200 and the response schema parses the body", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids: IdGenerator = createMockIdGenerator({ ulids: [PROJECT_ULID] });
    const clock: Clock = createMockClock({ start: 1700000000000, step: 1000 });
    const storage = temporary.storage;
    const events = silentEventLog();
    const app = await createTestApp({
      handlers: {
        "project.create": createProjectHandler({
          createProject: (input) =>
            createProject({ storage, ids, clock, events }, input),
        }),
      },
    });

    const response = await app
      .post("/v1/project")
      .send({ name: "kanthord-verify" });

    assert.equal(response.status, 200);
    assert.equal(projectCreateResponse.safeParse(response.body).success, true);
    assert.equal(response.body.id, `project_${PROJECT_ULID}`);
    assert.deepEqual(response.body.repositories, []);
    assert.equal(response.body.updatedAt, 1700000000000);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("POST /v1/project with an uppercase name answers 400 invalid-request and writes nothing", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const storage = temporary.storage;
    const before = countProjects(storage);
    const app = await createTestApp({
      handlers: {
        "project.create": createProjectHandler({
          createProject: (input) =>
            createProject(
              {
                storage,
                ids: createMockIdGenerator({ ulids: [PROJECT_ULID] }),
                clock: createMockClock({ start: 1700000000000, step: 1000 }),
                events: silentEventLog(),
              },
              input,
            ),
        }),
      },
    });

    const response = await app.post("/v1/project").send({ name: "Kanthord" });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(countProjects(storage), before);
  });

  it("a duplicate name answers 400 with details.refusal name-taken and writes no second row", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const storage = temporary.storage;
    const app = await createTestApp({
      handlers: {
        "project.create": createProjectHandler({
          createProject: (input) =>
            createProject(
              {
                storage,
                ids: createMockIdGenerator({
                  ulids: [PROJECT_ULID, SECOND_ULID],
                }),
                clock: createMockClock({ start: 1700000000000, step: 1000 }),
                events: silentEventLog(),
              },
              input,
            ),
        }),
      },
    });

    const first = await app
      .post("/v1/project")
      .send({ name: "kanthord-verify" });
    assert.equal(first.status, 200);
    const before = countProjects(storage);

    const second = await app
      .post("/v1/project")
      .send({ name: "kanthord-verify" });

    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, "invalid-request");
    assert.equal(second.body.error.details.refusal, "name-taken");
    assert.equal(countProjects(storage), before);
  });
});
