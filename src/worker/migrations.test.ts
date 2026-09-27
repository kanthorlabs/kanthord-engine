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
