import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Storage, Transaction } from "../../../services/storage/index.ts";
import type {
  EventLog,
  RecordedEvent,
  AppendEventInput,
} from "../../../services/event/index.ts";
import type { Clock } from "../../../services/clock/index.ts";
import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createPlanStore } from "../../../../test/helpers/plan.ts";
import {
  fixtureIds,
  seedRegistry,
  seedGraph,
} from "../../../../test/helpers/rows.ts";
import { replaceProjectRepositoriesHandler } from "./replace-project-repositories.ts";
import { replaceProjectRepositories } from "../../../commands/project/replace-project-repositories.ts";
import { projectRepositoriesResponse } from "../../contract/project.ts";

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

function count(
  table: "project_binding" | "event",
): (storage: Storage) => number {
  return (storage: Storage): number =>
    (
      storage.transact((transaction) =>
        transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
      ) as { c: number }
    ).c;
}

describe("src/http/server/project/replace-project-repositories.test", () => {
  it("PUT /v1/project/:id/repository replaces the binding set and answers 200", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);
    const storage = temporary.storage;
    const clock: Clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = silentEventLog();
    const plan = createPlanStore();
    const app = await createTestApp({
      handlers: {
        "project.repositories": replaceProjectRepositoriesHandler({
          replaceProjectRepositories: (input) =>
            replaceProjectRepositories({ storage, clock, events, plan }, input),
        }),
      },
    });

    const response = await app
      .put(`/v1/project/${fixtureIds.project}/repository`)
      .send({ repositories: [fixtureIds.repository] });

    assert.equal(response.status, 200);
    assert.equal(
      projectRepositoriesResponse.safeParse(response.body).success,
      true,
    );
    assert.deepEqual(response.body.repositories, [fixtureIds.repository]);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("PUT with two repository ids answers 400 with details.refusal too-many-repositories", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);
    temporary.storage.transact((transaction) =>
      transaction.run(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "repo_b",
          "second-repository",
          "https://example.invalid/second.git",
          fixtureIds.provider,
          "repos/second.git",
          "main",
          1,
          "ready",
          null,
          null,
          null,
          1,
        ],
      ),
    );
    const storage = temporary.storage;
    const clock: Clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = silentEventLog();
    const plan = createPlanStore();
    const app = await createTestApp({
      handlers: {
        "project.repositories": replaceProjectRepositoriesHandler({
          replaceProjectRepositories: (input) =>
            replaceProjectRepositories({ storage, clock, events, plan }, input),
        }),
      },
    });

    const response = await app
      .put(`/v1/project/${fixtureIds.project}/repository`)
      .send({ repositories: [fixtureIds.repository, "repo_b"] });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "too-many-repositories");
  });

  it("PUT /v1/project/:id/binding/worker answers 501 ships in phase-2 and writes nothing", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);
    const storage = temporary.storage;
    const countBindings = count("project_binding");
    const countEvents = count("event");
    const bindingsBefore = countBindings(storage);
    const eventsBefore = countEvents(storage);
    const clock: Clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = silentEventLog();
    const plan = createPlanStore();
    const app = await createTestApp({
      handlers: {
        "project.repositories": replaceProjectRepositoriesHandler({
          replaceProjectRepositories: (input) =>
            replaceProjectRepositories({ storage, clock, events, plan }, input),
        }),
      },
    });

    const response = await app.put(
      `/v1/project/${fixtureIds.project}/binding/worker`,
    );

    assert.equal(response.status, 501);
    assert.ok(
      String(response.body.error.message).endsWith("ships in phase-2"),
      String(response.body.error.message),
    );
    assert.equal(countBindings(storage), bindingsBefore);
    assert.equal(countEvents(storage), eventsBefore);
  });

  it("PUT dropping a repository a stored objective names answers 409 binding-in-use", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });
    const storage = temporary.storage;
    const clock: Clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = silentEventLog();
    const plan = createPlanStore();
    const app = await createTestApp({
      handlers: {
        "project.repositories": replaceProjectRepositoriesHandler({
          replaceProjectRepositories: (input) =>
            replaceProjectRepositories({ storage, clock, events, plan }, input),
        }),
      },
    });

    const response = await app
      .put(`/v1/project/${fixtureIds.project}/repository`)
      .send({ repositories: [] });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "binding-in-use");
    assert.deepEqual(response.body.error.details, {
      blockers: [{ nodeId: fixtureIds.objective, blocker: "repository-bound" }],
    });
  });
});
