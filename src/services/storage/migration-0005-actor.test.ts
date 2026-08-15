import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createMigratedStorage,
  createStorageAtVersion,
} from "../../../test/helpers/database.ts";
import { proposalStatements } from "../../../test/helpers/proposal.ts";
import { bootstrapActorId } from "../../domain/actor.ts";
import { StorageError, type Storage } from "./index.ts";
import {
  actorTableDdl,
  eventTableDdl,
  migration0005Actor,
} from "./migration-0005-actor.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const HARNESS_ID = "actor_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HARNESS_ID_2 = "actor_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const HARNESS_ID_3 = "actor_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const HARNESS_ID_4 = "actor_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const HARNESS_ID_5 = "actor_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const HARNESS_ID_6 = "actor_01ARZ3NDEKTSV4RRFFQ69G5GA0";
const HARNESS_ID_7 = "actor_01ARZ3NDEKTSV4RRFFQ69G5GA1";

const ZERO_DIGEST = Buffer.alloc(32);
const SHORT_DIGEST = Buffer.alloc(31);

const normalize = (sql: string): readonly string[] =>
  sql
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

function insertLegacyEvents(storage: Storage): void {
  storage.transact((t) => {
    t.run(
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["e1", "node", "node_x", "node.approved", "human", "ulrich", "{}"],
    );
    t.run(
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["e2", "node", "node_x", "node.waived", "human", "someone-else", "{}"],
    );
    t.run(
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["e3", "run", "run_x", "run.started", "daemon", "daemon", "{}"],
    );
    t.run(
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["e4", "node", "node_y", "node.approved", "human", "ulrich", "{}"],
    );
  });
}

function readEvents(storage: Storage): readonly Record<string, unknown>[] {
  return storage.transact((t) =>
    t.all(
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event ORDER BY id ASC",
    ),
  ) as readonly Record<string, unknown>[];
}

function insertEvent(
  storage: Storage,
  input: Readonly<{ id: string; actorKind: string; actorId: string }>,
): void {
  storage.transact((t) =>
    t.run(
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        input.id,
        "node",
        "node_x",
        "node.created",
        input.actorKind,
        input.actorId,
        "{}",
      ],
    ),
  );
}

function insertActor(
  storage: Storage,
  input: Readonly<{
    id: string;
    kind: string;
    name: string;
    tokenSha256: Uint8Array | null;
    registeredBy?: string | null;
    createdAt?: number;
    revokedAt?: number | null;
    revokedBy?: string | null;
  }>,
): void {
  storage.transact((t) =>
    t.run(
      "INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        input.id,
        input.kind,
        input.name,
        input.tokenSha256,
        input.registeredBy ?? null,
        input.createdAt ?? 1,
        input.revokedAt ?? null,
        input.revokedBy ?? null,
      ],
    ),
  );
}

describe("src/services/storage/migration-0005-actor.test", () => {
  it("migration0005Actor carries version 5 and the name migration.md declares", () => {
    assert.equal(migration0005Actor.version, 5);
    assert.equal(migration0005Actor.name, "0005-actor");

    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const migrationDoc = fs.readFileSync(
      join(repositoryRoot, "docs", "proposal", "database", "migration.md"),
      "utf8",
    );
    assert.ok(migrationDoc.includes("0005-actor"));
  });

  it("statements holds the nine entries of the rebuild in the exact order", () => {
    assert.deepEqual(migration0005Actor.statements.flatMap(normalize), [
      ...normalize(actorTableDdl),
      "INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES ('actor_00000000000000000000000000', 'human', 'bootstrap', NULL, NULL, 0, NULL, NULL)",
      "ALTER TABLE event RENAME TO event_old",
      ...normalize(eventTableDdl),
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event_old",
      "DROP TABLE event_old",
      "CREATE INDEX event_subject ON event (subject_kind, subject_id, id)",
      "CREATE INDEX event_type ON event (type, id)",
      "CREATE INDEX event_actor ON event (actor_kind, actor_id, id)",
    ]);
  });

  it("the bootstrap-id literal matches the domain constant", () => {
    assert.equal(actorTableDdl.split(bootstrapActorId).length - 1, 2);
    assert.ok(migration0005Actor.statements[1]!.includes(bootstrapActorId));
  });

  it("parity: the two DDL constants reproduce their proposal tables", () => {
    assert.deepEqual(normalize(actorTableDdl), proposalStatements("actor"));
    assert.deepEqual(normalize(eventTableDdl), proposalStatements("event"));
  });

  it("applies on a version-4 database that already holds event rows", () => {
    const temporary = createStorageAtVersion(4);
    after(() => temporary.dispose());

    insertLegacyEvents(temporary.storage);
    const before = readEvents(temporary.storage);

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations,
    });
    after(() => second.close());
    second.migrate();

    const migrated = readEvents(second);
    assert.equal(migrated.length, before.length);
    assert.deepEqual(migrated, before);
  });

  it("the actor table holds exactly the bootstrap row after migration", () => {
    const temporary = createStorageAtVersion(4);
    after(() => temporary.dispose());

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations,
    });
    after(() => second.close());
    second.migrate();

    const rows = second.transact((t) =>
      t.all(
        "SELECT id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by FROM actor",
      ),
    ) as readonly Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { ...rows[0] },
      {
        id: bootstrapActorId,
        kind: "human",
        name: "bootstrap",
        token_sha256: null,
        registered_by: null,
        created_at: 0,
        revoked_at: null,
        revoked_by: null,
      },
    );
  });

  it("the rebuilt event table refuses a bad harness row at the database level", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    assert.throws(() =>
      insertEvent(temporary.storage, {
        id: "ev-harness-bad",
        actorKind: "harness",
        actorId: "ulrich",
      }),
    );
    insertEvent(temporary.storage, {
      id: "ev-harness-ok",
      actorKind: "harness",
      actorId: HARNESS_ID,
    });
    insertEvent(temporary.storage, {
      id: "ev-human",
      actorKind: "human",
      actorId: "ulrich",
    });
  });

  it("the actor table refuses each CHECK violation", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    assert.throws(() =>
      insertActor(temporary.storage, {
        id: HARNESS_ID,
        kind: "harness",
        name: "h-null-token",
        tokenSha256: null,
        registeredBy: bootstrapActorId,
      }),
    );
    assert.throws(() =>
      insertActor(temporary.storage, {
        id: HARNESS_ID_2,
        kind: "harness",
        name: "h-null-registered",
        tokenSha256: ZERO_DIGEST,
        registeredBy: null,
      }),
    );
    assert.throws(() =>
      insertActor(temporary.storage, {
        id: HARNESS_ID_3,
        kind: "harness",
        name: "h-short-token",
        tokenSha256: SHORT_DIGEST,
        registeredBy: bootstrapActorId,
      }),
    );
    assert.throws(() =>
      insertActor(temporary.storage, {
        id: HARNESS_ID_4,
        kind: "harness",
        name: "h-revoked",
        tokenSha256: ZERO_DIGEST,
        registeredBy: bootstrapActorId,
        revokedAt: 2,
        revokedBy: null,
      }),
    );
    assert.throws(() =>
      insertActor(temporary.storage, {
        id: HARNESS_ID_5,
        kind: "daemon",
        name: "h-daemon",
        tokenSha256: ZERO_DIGEST,
        registeredBy: bootstrapActorId,
      }),
    );
    insertActor(temporary.storage, {
      id: HARNESS_ID_6,
      kind: "harness",
      name: "h-dup",
      tokenSha256: ZERO_DIGEST,
      registeredBy: bootstrapActorId,
    });
    assert.throws(() =>
      insertActor(temporary.storage, {
        id: HARNESS_ID_7,
        kind: "harness",
        name: "h-dup",
        tokenSha256: ZERO_DIGEST,
        registeredBy: bootstrapActorId,
      }),
    );
  });

  it("an injected failure after the event drop rolls the whole migration back", () => {
    const temporary = createStorageAtVersion(4);
    after(() => temporary.dispose());
    insertLegacyEvents(temporary.storage);

    const broken = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [
        ...migrations.slice(0, 4),
        {
          ...migration0005Actor,
          statements: [
            ...migration0005Actor.statements,
            "SELECT this_column_does_not_exist FROM event",
          ],
        },
      ],
    });
    after(() => broken.close());

    assert.throws(
      () => broken.migrate(),
      (error) =>
        error instanceof StorageError &&
        error.code === "storage-migration-failed",
    );

    const status = broken.status();
    assert.deepEqual(
      status.applied.map((row) => row.version),
      [1, 2, 3, 4],
    );

    const tableRows = broken.transact((t) =>
      t.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ),
    ) as readonly Record<string, unknown>[];
    const tableNames = tableRows.map((row) => row.name);
    assert.ok(!tableNames.includes("actor"));
    assert.ok(!tableNames.includes("event_old"));

    const eventSql = broken.transact((t) =>
      t.get("SELECT sql FROM sqlite_master WHERE name = 'event'"),
    ) as { sql: string };
    assert.ok(String(eventSql.sql).includes("'human', 'daemon'"));
    assert.ok(!String(eventSql.sql).includes("'harness'"));

    const eventRows = broken.transact((t) =>
      t.all("SELECT id FROM event ORDER BY id ASC"),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(
      eventRows.map((row) => row.id),
      ["e1", "e2", "e3", "e4"],
    );
  });

  it("the three migration-0004 indexes exist after the rebuild", () => {
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

    const orphan = temporary.storage.transact((t) =>
      t.all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_old'",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(orphan, []);
  });
});
