import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { WORKER_SERVICE_NAME } from "./contract.ts";
import { workerMigrations } from "./migrations.ts";

const WORKER_AGENT_ENABLEMENT_TABLE = "worker_agent_enablement";
const WORKER_AGENT_ENABLEMENT_INDEX =
  "worker_agent_enablement_agent_name_revision";
const INTEGRITY_OK = "ok";
const CREATED_INDEX_ORIGIN = "c";
const WORKER_INSTANCE_TABLE = "worker_instance";
const WORKER_INSTANCE_INDEX = "worker_instance_live_client";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE_IDENTITY = "worker:kanthord:general";
const CLIENT_ID = "client_identity_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLIENT_NAME = "worker-a";
const REGISTERED_AT = 1000;
const ENDED_AT = 2000;
const EXPECTED_REGISTRATIONS = 3;

test("worker migration creates agent enablement schema", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
    ]);
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all(WORKER_AGENT_ENABLEMENT_TABLE)
        .map((row) => row.name),
      [WORKER_AGENT_ENABLEMENT_TABLE],
    );
    assert.deepEqual(
      store.database
        .prepare(`PRAGMA table_info(${WORKER_AGENT_ENABLEMENT_TABLE})`)
        .all()
        .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
      [
        { name: "id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "agent_name", type: "TEXT", notnull: 1, pk: 0 },
        { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "state", type: "TEXT", notnull: 1, pk: 0 },
        { name: "agent_providers", type: "TEXT", notnull: 1, pk: 0 },
        { name: "default_configuration", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "removed_at", type: "INTEGER", notnull: 0, pk: 0 },
      ],
    );
    assert.deepEqual(
      store.database
        .prepare(`PRAGMA index_list(${WORKER_AGENT_ENABLEMENT_TABLE})`)
        .all()
        .filter((row) => row.origin === CREATED_INDEX_ORIGIN)
        .map((row) => ({ name: row.name, unique: row.unique })),
      [{ name: WORKER_AGENT_ENABLEMENT_INDEX, unique: 1 }],
    );
    assert.equal(
      store.database.prepare("PRAGMA integrity_check").get()?.integrity_check,
      INTEGRITY_OK,
    );
    assert.deepEqual(
      store.database.prepare("PRAGMA foreign_key_check").all(),
      [],
    );
  } finally {
    store.close();
  }
});

test("worker instance schema holds only the live-client partial unique index", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
    ]);
    assert.deepEqual(
      store.database
        .prepare(`PRAGMA table_info(${WORKER_INSTANCE_TABLE})`)
        .all()
        .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
      [
        { name: "id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "project_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "resource_identity", type: "TEXT", notnull: 1, pk: 0 },
        { name: "client_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "client_name", type: "TEXT", notnull: 1, pk: 0 },
        { name: "registered_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "ended_at", type: "INTEGER", notnull: 0, pk: 0 },
      ],
    );
    assert.deepEqual(
      store.database
        .prepare(`PRAGMA index_list(${WORKER_INSTANCE_TABLE})`)
        .all()
        .filter((row) => row.origin === CREATED_INDEX_ORIGIN)
        .map(({ name, unique, partial }) => ({ name, unique, partial })),
      [{ name: WORKER_INSTANCE_INDEX, unique: 1, partial: 1 }],
    );
    assert.match(
      String(
        store.database
          .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
          .get(WORKER_INSTANCE_INDEX)?.sql,
      ),
      /ON worker_instance \(client_id\) WHERE ended_at IS NULL$/,
    );
    assert.deepEqual(
      store.database
        .prepare(`PRAGMA foreign_key_list(${WORKER_INSTANCE_TABLE})`)
        .all(),
      [],
    );
    assert.doesNotMatch(
      String(
        store.database
          .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
          .get(WORKER_INSTANCE_TABLE)?.sql,
      ),
      /\bCHECK\s*\(/i,
    );
  } finally {
    store.close();
  }
});

test("worker instance uniqueness allows history and releases a client after its end", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
    ]);
    const insert = store.database.prepare(
      "INSERT INTO worker_instance VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const values = [
      PROJECT_ID,
      RESOURCE_IDENTITY,
      CLIENT_ID,
      CLIENT_NAME,
      REGISTERED_AT,
    ];
    insert.run("live", ...values, null);
    assert.throws(
      () => insert.run("second", ...values, null),
      /UNIQUE constraint failed: worker_instance.client_id/,
    );
    assert.doesNotThrow(() => insert.run("ended", ...values, ENDED_AT));
    store.database
      .prepare("UPDATE worker_instance SET ended_at = ? WHERE id = ?")
      .run(ENDED_AT, "live");
    assert.doesNotThrow(() => insert.run("second", ...values, null));
    assert.equal(
      store.database
        .prepare("SELECT count(*) AS count FROM worker_instance")
        .get()?.count,
      EXPECTED_REGISTRATIONS,
    );
  } finally {
    store.close();
  }
});
