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
import { MISSION_SERVICE_NAME } from "../../mission/contract.ts";
import { missionMigrations } from "../../mission/index.ts";

const PROJECT_SERVICE_NAME = "project";
const GATEWAY_SERVICE_NAME = "gateway";

const services: Migrations = [
  { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  { service: "gateway", migrations: gatewayMigrations },
  { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
  { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
  { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
];
const HISTORY_TABLE = "migration";
const CREDENTIAL_TABLE = "credential";
const WORKER_AGENT_ENABLEMENT_TABLE = "worker_agent_enablement";
const WORKER_INSTANCE_TABLE = "worker_instance";
const ERD2_WORKER_TABLES = [WORKER_INSTANCE_TABLE];
const PROJECT_PROJECT_TABLE = "project_project";
const PROJECT_BINDING_TABLE = "project_binding";
const SCHEDULER_JOB_TABLE = "scheduler_job";
const MISSION_MISSION_TABLE = "mission_mission";
const MISSION_NODE_TABLE = "mission_node";
const MISSION_NODE_REVISION_TABLE = "mission_node_revision";
const MISSION_DEPENDENCY_TABLE = "mission_dependency";
const MISSION_ATTEMPT_TABLE = "mission_attempt";
const MISSION_EVIDENCE_TABLE = "mission_evidence";
const MISSION_EVIDENCE_ASSET_TABLE = "mission_evidence_asset";
const MISSION_ASSESSMENT_TABLE = "mission_assessment";
const MISSION_OUTCOME_TABLE = "mission_outcome";
const MISSION_ATTEMPT_OPEN_INDEX = "mission_attempt_open";
const MISSION_EVIDENCE_REQUEST_INDEX = "mission_evidence_request";
const MISSION_ASSESSMENT_SEQUENCE_INDEX = "mission_assessment_sequence";
const MISSION_OUTCOME_SEQUENCE_INDEX = "mission_outcome_sequence";
const ERD2_MISSION_TABLES = [
  MISSION_ATTEMPT_TABLE,
  MISSION_EVIDENCE_TABLE,
  MISSION_EVIDENCE_ASSET_TABLE,
  MISSION_ASSESSMENT_TABLE,
  MISSION_OUTCOME_TABLE,
];
const MISSION_TABLES = [
  MISSION_MISSION_TABLE,
  MISSION_NODE_TABLE,
  MISSION_NODE_REVISION_TABLE,
  MISSION_DEPENDENCY_TABLE,
  ...ERD2_MISSION_TABLES,
];
const INTEGRITY_OK = "ok";
const NO_PREFIX_MATCHES = 0;
const SINGLE_PREFIX_MATCH = 1;
const ERD1_TABLES = [
  CREDENTIAL_TABLE,
  MISSION_DEPENDENCY_TABLE,
  MISSION_MISSION_TABLE,
  MISSION_NODE_TABLE,
  MISSION_NODE_REVISION_TABLE,
  PROJECT_BINDING_TABLE,
  PROJECT_PROJECT_TABLE,
  SCHEDULER_JOB_TABLE,
  WORKER_AGENT_ENABLEMENT_TABLE,
];

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
      ...ERD2_WORKER_TABLES,
      PROJECT_PROJECT_TABLE,
      PROJECT_BINDING_TABLE,
      SCHEDULER_JOB_TABLE,
      ...MISSION_TABLES,
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
      if (service.service === MISSION_SERVICE_NAME)
        assert.deepEqual(tables(store), MISSION_TABLES);
      if (service.service === WORKER_SERVICE_NAME)
        assert.deepEqual(tables(store), [
          WORKER_AGENT_ENABLEMENT_TABLE,
          ...ERD2_WORKER_TABLES,
        ]);
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

test("all migrations produce exactly the expected ERD 1 and implemented ERD 2 tables", () => {
  const erd1Services: Migrations = [
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
    { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
    { service: GATEWAY_SERVICE_NAME, migrations: gatewayMigrations },
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
    { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
  ];
  const prefixes = erd1Services.map(({ service }) => `${service}_`);
  assert.equal(new Set(prefixes).size, erd1Services.length);
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    const applied: Migrations[number][] = [];
    const owners = new Map<string, string>();
    for (const service of erd1Services) {
      const before = new Set(tables(store));
      applied.push(service);
      store.migrate(applied);
      for (const name of tables(store).filter((name) => !before.has(name))) {
        owners.set(name, service.service);
      }
    }
    assert.deepEqual(
      [...tables(store)].sort(),
      [...ERD1_TABLES, ...ERD2_MISSION_TABLES, ...ERD2_WORKER_TABLES].sort(),
    );
    for (const name of tables(store)) {
      const matches = erd1Services.filter(({ service }) =>
        name.startsWith(`${service}_`),
      );
      if (name === CREDENTIAL_TABLE) {
        assert.equal(matches.length, NO_PREFIX_MATCHES);
        assert.equal(owners.get(name), CUSTODY_SERVICE_NAME);
      } else {
        assert.equal(matches.length, SINGLE_PREFIX_MATCH, name);
        assert.equal(owners.get(name), matches[0]!.service);
      }
    }
    assert.deepEqual(
      tables(store).filter(
        (name) => !prefixes.some((prefix) => name.startsWith(prefix)),
      ),
      [CREDENTIAL_TABLE],
    );
  } finally {
    store.close();
  }
  for (const service of erd1Services) {
    const isolated = new Store(IN_MEMORY_DATABASE);
    try {
      isolated.migrate([service]);
      for (const name of tables(isolated)) {
        assert.ok(
          name.startsWith(`${service.service}_`) ||
            (name === CREDENTIAL_TABLE &&
              service.service === CUSTODY_SERVICE_NAME),
          `${service.service} created ${name}`,
        );
      }
    } finally {
      isolated.close();
    }
  }
});

test("Mission execution records have exactly four unique indexes with the ruled predicates", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
    ]);
    const indexes = store.database
      .prepare(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
      )
      .all()
      .filter((row) => ERD2_MISSION_TABLES.includes(String(row.tbl_name)));
    assert.deepEqual(indexes.map((row) => row.name).sort(), [
      MISSION_ASSESSMENT_SEQUENCE_INDEX,
      MISSION_ATTEMPT_OPEN_INDEX,
      MISSION_EVIDENCE_REQUEST_INDEX,
      MISSION_OUTCOME_SEQUENCE_INDEX,
    ]);
    for (const row of indexes)
      assert.match(String(row.sql), /^CREATE UNIQUE INDEX /);
    assert.match(
      String(
        indexes.find((row) => row.name === MISSION_ATTEMPT_OPEN_INDEX)?.sql,
      ),
      /WHERE closed_at IS NULL$/,
    );
    assert.match(
      String(
        indexes.find((row) => row.name === MISSION_EVIDENCE_REQUEST_INDEX)?.sql,
      ),
      /WHERE requirement_key IS NOT NULL$/,
    );
    for (const table of ERD2_MISSION_TABLES) {
      assert.doesNotMatch(
        String(
          store.database
            .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
            .get(table)?.sql,
        ),
        /\bCHECK\s*\(/i,
      );
    }
  } finally {
    store.close();
  }
});
