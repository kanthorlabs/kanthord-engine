import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { AGENT_COMPONENT_NAME } from "./contract.ts";
import { agentMigrations } from "./migrations.ts";

const AGENT_ENABLEMENT_TABLE = "agent_enablement";
const AGENT_ENABLEMENT_INDEX = "agent_enablement_agent_name_revision";
const INTEGRITY_OK = "ok";
const CREATED_INDEX_ORIGIN = "c";

test("agent migration creates the agent enablement schema", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    ]);
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all(AGENT_ENABLEMENT_TABLE)
        .map((row) => row.name),
      [AGENT_ENABLEMENT_TABLE],
    );
    assert.deepEqual(
      store.database
        .prepare(`PRAGMA table_info(${AGENT_ENABLEMENT_TABLE})`)
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
        .prepare(`PRAGMA index_list(${AGENT_ENABLEMENT_TABLE})`)
        .all()
        .filter((row) => row.origin === CREATED_INDEX_ORIGIN)
        .map((row) => ({ name: row.name, unique: row.unique })),
      [{ name: AGENT_ENABLEMENT_INDEX, unique: 1 }],
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

test("agent migration creates the prompt settings schema", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    ]);
    assert.deepEqual(
      store.database
        .prepare("PRAGMA table_info(agent_prompt)")
        .all()
        .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
      [
        { name: "id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "scope", type: "TEXT", notnull: 1, pk: 0 },
        { name: "agent_name", type: "TEXT", notnull: 1, pk: 0 },
        { name: "switches", type: "TEXT", notnull: 1, pk: 0 },
        { name: "custom_text", type: "TEXT", notnull: 1, pk: 0 },
        { name: "system_layer", type: "TEXT", notnull: 0, pk: 0 },
        { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
      ],
    );
    assert.deepEqual(
      store.database
        .prepare("PRAGMA index_list(agent_prompt)")
        .all()
        .filter((row) => row.origin === CREATED_INDEX_ORIGIN)
        .map((row) => ({ name: row.name, unique: row.unique })),
      [{ name: "agent_prompt_scope_agent_name", unique: 1 }],
    );
    assert.equal(
      store.database
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_prompt'")
        .get()
        ?.sql?.toString()
        .includes("CHECK"),
      false,
    );
  } finally {
    store.close();
  }
});
