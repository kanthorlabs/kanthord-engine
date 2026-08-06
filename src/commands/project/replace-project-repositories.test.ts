import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { ProjectView } from "../../domain/project-view.ts";
import { replaceProjectRepositories } from "./replace-project-repositories.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";

type ReplaceProjectRepositoriesDependencies = Readonly<{
  storage: Storage;
  clock: Clock;
  events: EventLog;
}>;

function createRecordingEventLog(): Readonly<{
  events: EventLog;
  recorded: readonly AppendEventInput[];
}> {
  const recorded: AppendEventInput[] = [];
  return {
    recorded,
    events: {
      append(
        _transaction: Transaction,
        input: AppendEventInput,
      ): RecordedEvent {
        recorded.push(input);
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

function refusalOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    return (error as Readonly<Record<string, unknown>>).refusal as string;
  }
  return undefined;
}

function countGitBindings(storage: Storage): number {
  return (
    storage.transact((transaction) =>
      transaction.get(
        "SELECT COUNT(*) AS c FROM project_binding WHERE kind = 'git'",
      ),
    ) as { c: number }
  ).c;
}

function readBindings(storage: Storage): readonly unknown[] {
  return storage.transact((transaction) =>
    transaction.all(
      "SELECT project_id, kind, target_id FROM project_binding ORDER BY target_id",
    ),
  ) as readonly unknown[];
}

function insertRepository(storage: Storage, id: string): void {
  storage.transact((transaction) =>
    transaction.run(
      "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        "second-repository",
        "https://example.invalid/second.git",
        fixtureIds.provider,
        "repos/second.git",
        "main",
        "main",
        "refs/heads/main",
        1,
        "ready",
        null,
        null,
        null,
        1,
      ],
    ),
  );
}

describe("src/commands/project/replace-project-repositories.test", () => {
  it("replacing with an empty list removes every git binding", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    const view = replaceProjectRepositories(
      {
        storage: temporary.storage,
        clock: createMockClock({ start: 1700000000000, step: 1000 }),
        events: createRecordingEventLog().events,
      },
      { id: fixtureIds.project, repositories: [], actor: "ulrich" },
    );

    assert.equal(countGitBindings(temporary.storage), 0);
    assert.deepEqual(view.repositories, []);
    assert.equal(view.id, fixtureIds.project);
  });

  it("replacing with one repository inserts exactly that binding", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    const view = replaceProjectRepositories(
      {
        storage: temporary.storage,
        clock: createMockClock({ start: 1700000000000, step: 1000 }),
        events: createRecordingEventLog().events,
      },
      {
        id: fixtureIds.project,
        repositories: [fixtureIds.repository],
        actor: "ulrich",
      },
    );

    assert.equal(countGitBindings(temporary.storage), 1);
    assert.deepEqual(view.repositories, [fixtureIds.repository]);
  });

  it("two repositories refuse too-many-repositories and leave the bindings byte-identical", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
    });
    insertRepository(temporary.storage, "repo_b");
    const before = readBindings(temporary.storage);

    assert.throws(
      () =>
        replaceProjectRepositories(
          {
            storage: temporary.storage,
            clock: createMockClock({ start: 1700000000000, step: 1000 }),
            events: createRecordingEventLog().events,
          },
          {
            id: fixtureIds.project,
            repositories: [fixtureIds.repository, "repo_b"],
            actor: "ulrich",
          },
        ),
      (error: unknown) => refusalOf(error) === "too-many-repositories",
    );
    assert.deepEqual(readBindings(temporary.storage), before);
  });

  it("a repeated id in a two-entry list refuses too-many-repositories before duplicate-repository", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    assert.throws(
      () =>
        replaceProjectRepositories(
          {
            storage: temporary.storage,
            clock: createMockClock({ start: 1700000000000, step: 1000 }),
            events: createRecordingEventLog().events,
          },
          {
            id: fixtureIds.project,
            repositories: [fixtureIds.repository, fixtureIds.repository],
            actor: "ulrich",
          },
        ),
      (error: unknown) => refusalOf(error) === "too-many-repositories",
    );
    assert.equal(countGitBindings(temporary.storage), 1);
  });

  it("a missing repository refuses repository-not-found and the existing binding survives", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    assert.throws(
      () =>
        replaceProjectRepositories(
          {
            storage: temporary.storage,
            clock: createMockClock({ start: 1700000000000, step: 1000 }),
            events: createRecordingEventLog().events,
          },
          {
            id: fixtureIds.project,
            repositories: ["repo_missing"],
            actor: "ulrich",
          },
        ),
      (error: unknown) => refusalOf(error) === "repository-not-found",
    );
    assert.equal(countGitBindings(temporary.storage), 1);
  });

  it("an unknown project refuses project-not-found", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    assert.throws(
      () =>
        replaceProjectRepositories(
          {
            storage: temporary.storage,
            clock: createMockClock({ start: 1700000000000, step: 1000 }),
            events: createRecordingEventLog().events,
          },
          { id: "project_missing", repositories: [], actor: "ulrich" },
        ),
      (error: unknown) => refusalOf(error) === "project-not-found",
    );
    assert.equal(countGitBindings(temporary.storage), 1);
  });

  it("a provider binding survives a git replacement", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run(
        "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, 'provider', ?, ?)",
        [fixtureIds.project, fixtureIds.provider, 2],
      );
    });

    replaceProjectRepositories(
      {
        storage: temporary.storage,
        clock: createMockClock({ start: 1700000000000, step: 1000 }),
        events: createRecordingEventLog().events,
      },
      { id: fixtureIds.project, repositories: [], actor: "ulrich" },
    );

    assert.equal(countGitBindings(temporary.storage), 0);
    const providerBindings = temporary.storage.transact((transaction) =>
      transaction.all(
        "SELECT target_id FROM project_binding WHERE kind = 'provider'",
      ),
    ) as readonly { target_id: string }[];
    assert.deepEqual(
      providerBindings.map((row) => row.target_id),
      [fixtureIds.provider],
    );
  });

  it("a successful replacement leaves project.updated_at untouched", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);
    const readUpdatedAt = (): number =>
      (
        temporary.storage.transact((transaction) =>
          transaction.get("SELECT updated_at FROM project WHERE id = ?", [
            fixtureIds.project,
          ]),
        ) as { updated_at: number }
      ).updated_at;

    const before = readUpdatedAt();
    replaceProjectRepositories(
      {
        storage: temporary.storage,
        clock: createMockClock({ start: 1700000000000, step: 1000 }),
        events: createRecordingEventLog().events,
      },
      { id: fixtureIds.project, repositories: [], actor: "ulrich" },
    );
    assert.equal(readUpdatedAt(), before);
  });

  it("the single-entry case writes created_at from the mock clock", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    replaceProjectRepositories(
      {
        storage: temporary.storage,
        clock: createMockClock({ start: 1700000000000, step: 1000 }),
        events: createRecordingEventLog().events,
      },
      {
        id: fixtureIds.project,
        repositories: [fixtureIds.repository],
        actor: "ulrich",
      },
    );

    const created = temporary.storage.transact((transaction) =>
      transaction.get(
        "SELECT created_at FROM project_binding WHERE project_id = ? AND kind = 'git'",
        [fixtureIds.project],
      ),
    ) as { created_at: number };
    assert.equal(created.created_at, 1700000000000);
  });

  it("a length and existence fault together refuse too-many-repositories first", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    assert.throws(
      () =>
        replaceProjectRepositories(
          {
            storage: temporary.storage,
            clock: createMockClock({ start: 1700000000000, step: 1000 }),
            events: createRecordingEventLog().events,
          },
          {
            id: fixtureIds.project,
            repositories: ["repo_missing", fixtureIds.repository],
            actor: "ulrich",
          },
        ),
      (error: unknown) => refusalOf(error) === "too-many-repositories",
    );
  });

  it("a successful replacement appends one repositoriesReplaced event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);
    const log = createRecordingEventLog();

    replaceProjectRepositories(
      {
        storage: temporary.storage,
        clock: createMockClock({ start: 1700000000000, step: 1000 }),
        events: log.events,
      },
      { id: fixtureIds.project, repositories: [], actor: "ulrich" },
    );

    assert.equal(log.recorded.length, 1);
    const input = log.recorded[0]!;
    assert.equal(input.subjectKind, "project");
    assert.equal(input.subjectId, fixtureIds.project);
    assert.equal(input.type, "project.repositoriesReplaced");
    assert.deepEqual(input.payload, { repositories: [] });
  });

  it("returns a ProjectView assembled from the read row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    const view: ProjectView = replaceProjectRepositories(
      {
        storage: temporary.storage,
        clock: createMockClock({ start: 1700000000000, step: 1000 }),
        events: createRecordingEventLog().events,
      },
      {
        id: fixtureIds.project,
        repositories: [fixtureIds.repository],
        actor: "ulrich",
      },
    );

    assert.deepEqual(view, {
      id: fixtureIds.project,
      name: "kanthord-verify",
      repositories: [fixtureIds.repository],
      updatedAt: 1,
    });
  });
});
