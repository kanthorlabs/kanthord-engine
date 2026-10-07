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

test("agent migration keeps every row of the legacy worker enablement table", () => {
  const legacyTable = "worker_agent_enablement";
  const rows = [
    ["agent_enablement_a", "swe@1", 1, "enabled", "[]", "{}", 1000, null],
    ["agent_enablement_b", "swe@1", 2, "disabled", "[]", "{}", 2000, 3000],
  ];
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.database.exec(`
      CREATE TABLE ${legacyTable} (
        id TEXT NOT NULL PRIMARY KEY,
        agent_name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        agent_providers TEXT NOT NULL,
        default_configuration TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        removed_at INTEGER
      );
    `);
    const insert = store.database.prepare(
      `INSERT INTO ${legacyTable} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) insert.run(...row);
    store.migrate([
      { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    ]);
    assert.deepEqual(
      store.database
        .prepare(`SELECT * FROM ${AGENT_ENABLEMENT_TABLE} ORDER BY revision`)
        .all()
        .map((row) => Object.values(row)),
      rows,
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
        { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "system_layer", type: "TEXT", notnull: 0, pk: 0 },
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

test("agent migration sets the system layer override of an existing agent row to inherit", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      {
        service: AGENT_COMPONENT_NAME,
        migrations: agentMigrations.slice(0, 2),
      },
    ]);
    const insert = store.database.prepare(
      `INSERT INTO agent_prompt (id, scope, agent_name, switches, custom_text, revision, updated_at)
       VALUES (?, ?, ?, '{}', '', 1, 0)`,
    );
    insert.run("agent_prompt_a", "agent", "swe@1");
    insert.run("agent_prompt_s", "system", "");
    store.migrate([
      { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    ]);
    assert.deepEqual(
      store.database
        .prepare("SELECT scope, system_layer FROM agent_prompt ORDER BY scope")
        .all()
        .map(({ scope, system_layer }) => ({ scope, system_layer })),
      [
        { scope: "agent", system_layer: "inherit" },
        { scope: "system", system_layer: null },
      ],
    );
  } finally {
    store.close();
  }
});

test("agent migration renames the keys of the default configuration of every enablement row", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      {
        service: AGENT_COMPONENT_NAME,
        migrations: agentMigrations.slice(0, 3),
      },
    ]);
    const insert = store.database.prepare(
      `INSERT INTO agent_enablement
       (id, agent_name, revision, state, agent_providers, default_configuration, created_at, removed_at)
       VALUES (?, ?, ?, 'enabled', ?, ?, 0, ?)`,
    );
    const providers = JSON.stringify([
      { name: "default", provider: "anthropic", credential: "anthro-1" },
    ]);
    insert.run(
      "agent_enablement_a",
      "swe@1",
      1,
      providers,
      '{"agentProvider":"default","modelIdentifier":"claude-sonnet-4-5","reasoningEffort":"off"}',
      null,
    );
    insert.run(
      "agent_enablement_b",
      "re@1",
      2,
      providers,
      '{"agentProvider":"default","modelIdentifier":"claude-opus-4-5","reasoningEffort":"high"}',
      5,
    );
    store.migrate([
      { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    ]);
    const rows = store.database
      .prepare(
        "SELECT id, agent_providers, default_configuration FROM agent_enablement ORDER BY id",
      )
      .all();
    assert.deepEqual(
      rows.map((row) => row.default_configuration),
      [
        '{"agent_provider":"default","model_identifier":"claude-sonnet-4-5","reasoning_effort":"off"}',
        '{"agent_provider":"default","model_identifier":"claude-opus-4-5","reasoning_effort":"high"}',
      ],
    );
    assert.deepEqual(
      rows.map((row) => row.agent_providers),
      [providers, providers],
    );
  } finally {
    store.close();
  }
});
