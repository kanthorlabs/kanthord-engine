import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Store,
  IN_MEMORY_DATABASE,
  type Migrations,
} from "../../kernel/store.ts";
import { CUSTODY_SERVICE_NAME } from "../../custody/contract.ts";
import { custodyMigrations } from "../../custody/index.ts";
import { gatewayMigrations } from "../../gateway/index.ts";
import { WORKER_SERVICE_NAME } from "../../worker/contract.ts";
import { workerMigrations } from "../../worker/index.ts";
import { projectMigrations } from "../../project/index.ts";
import { SCHEDULER_SERVICE_NAME } from "../../scheduler/contract.ts";
import { schedulerMigrations } from "../../scheduler/index.ts";

const PROJECT_SERVICE_NAME = "project";

const services: Migrations = [
  { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  { service: "gateway", migrations: gatewayMigrations },
  { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
  { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
];
const HISTORY_TABLE = "migration";
const CREDENTIAL_TABLE = "credential";
const WORKER_AGENT_ENABLEMENT_TABLE = "worker_agent_enablement";
const PROJECT_PROJECT_TABLE = "project_project";
const PROJECT_BINDING_TABLE = "project_binding";
const SCHEDULER_JOB_TABLE = "scheduler_job";
const INTEGRITY_OK = "ok";

function tables(store: Store): string[] {
  return store.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name))
    .filter((name) => name !== HISTORY_TABLE);
}

test("service migrations own distinct prefixes and create only tables in their namespace", () => {
  const prefixes = services.map(({ service }) => `${service}_`);
  assert.equal(new Set(prefixes).size, services.length);
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    const applied: Migrations[number][] = [];
    for (const service of services) {
      const before = new Set(tables(store));
      applied.push(service);
      store.migrate(applied);
      for (const name of tables(store).filter((name) => !before.has(name))) {
        const isCredentialException =
          service.service === CUSTODY_SERVICE_NAME && name === CREDENTIAL_TABLE;
        if (isCredentialException) continue;
        assert.ok(
          name.startsWith(`${service.service}_`),
          `${service.service} created ${name}`,
        );
        assert.deepEqual(
          prefixes.filter((prefix) => name.startsWith(prefix)),
          [`${service.service}_`],
        );
      }
    }
    assert.deepEqual(tables(store), [
      CREDENTIAL_TABLE,
      WORKER_AGENT_ENABLEMENT_TABLE,
      PROJECT_PROJECT_TABLE,
      PROJECT_BINDING_TABLE,
      SCHEDULER_JOB_TABLE,
    ]);
  } finally {
    store.close();
  }
});

test("each service migration set applies alone to an empty store", () => {
  for (const service of services) {
    const store = new Store(IN_MEMORY_DATABASE);
    try {
      assert.deepEqual(tables(store), []);
      assert.doesNotThrow(() => store.migrate([service]), service.service);
      assert.deepEqual(
        store.database.prepare("PRAGMA foreign_key_check").all(),
        [],
      );
      assert.equal(
        store.database.prepare("PRAGMA integrity_check").get()?.integrity_check,
        INTEGRITY_OK,
      );
      if (service.service === SCHEDULER_SERVICE_NAME)
        assert.deepEqual(tables(store), [SCHEDULER_JOB_TABLE]);
      if (service.service === WORKER_SERVICE_NAME)
        assert.deepEqual(tables(store), [WORKER_AGENT_ENABLEMENT_TABLE]);
      if (service.service === PROJECT_SERVICE_NAME) {
        assert.deepEqual(tables(store), [
          PROJECT_PROJECT_TABLE,
          PROJECT_BINDING_TABLE,
        ]);
        assert.deepEqual(
          store.database
            .prepare(
              `SELECT name, type, "notnull", pk FROM pragma_table_info('${PROJECT_PROJECT_TABLE}')`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "id", type: "TEXT", notnull: 1, pk: 1 },
            { name: "name", type: "TEXT", notnull: 1, pk: 0 },
            { name: "binding_set_version", type: "INTEGER", notnull: 1, pk: 0 },
            { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
          ],
        );
        assert.deepEqual(
          store.database
            .prepare(
              `SELECT name, type, "notnull", pk FROM pragma_table_info('${PROJECT_BINDING_TABLE}')`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "id", type: "TEXT", notnull: 1, pk: 1 },
            { name: "project_id", type: "TEXT", notnull: 1, pk: 0 },
            { name: "name", type: "TEXT", notnull: 1, pk: 0 },
            { name: "resource_identity", type: "TEXT", notnull: 1, pk: 0 },
            { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
            { name: "config", type: "TEXT", notnull: 1, pk: 0 },
            { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
            { name: "removed_at", type: "INTEGER", notnull: 0, pk: 0 },
          ],
        );
        assert.deepEqual(
          store.database
            .prepare(
              `SELECT "table", "from", "to" FROM pragma_foreign_key_list('${PROJECT_BINDING_TABLE}')`,
            )
            .all()
            .map((row) => ({ ...row })),
          [{ table: PROJECT_PROJECT_TABLE, from: "project_id", to: "id" }],
        );
        for (const [table, index] of [
          [PROJECT_PROJECT_TABLE, "project_project_name"],
          [PROJECT_BINDING_TABLE, "project_binding_revision"],
        ]) {
          assert.deepEqual(
            store.database
              .prepare(
                `SELECT name, "unique" FROM pragma_index_list('${table}') WHERE name NOT LIKE 'sqlite_autoindex%'`,
              )
              .all()
              .map((row) => ({ ...row })),
            [{ name: index, unique: 1 }],
          );
        }
      }
      if (service.service === CUSTODY_SERVICE_NAME) {
        assert.deepEqual(
          store.database
            .prepare(
              `SELECT name, type, "notnull", pk FROM pragma_table_info('${CREDENTIAL_TABLE}')`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            { name: "id", type: "TEXT", notnull: 1, pk: 1 },
            { name: "name", type: "TEXT", notnull: 1, pk: 0 },
            { name: "platform", type: "TEXT", notnull: 1, pk: 0 },
            { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
            { name: "nonce", type: "BLOB", notnull: 1, pk: 0 },
            { name: "ciphertext", type: "BLOB", notnull: 1, pk: 0 },
            { name: "metadata", type: "TEXT", notnull: 0, pk: 0 },
            { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
            { name: "ended_at", type: "INTEGER", notnull: 0, pk: 0 },
          ],
        );
        assert.deepEqual(
          store.database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'",
            )
            .all()
            .map((row) => ({ ...row })),
          [{ name: "credential_name_revision" }],
        );
      }
    } finally {
      store.close();
    }
  }
});
