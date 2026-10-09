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
import { AGENT_COMPONENT_NAME } from "../../agent/contract.ts";
import { agentMigrations } from "../../agent/index.ts";
import { workerMigrations } from "../../worker/index.ts";
import { projectMigrations } from "../../project/index.ts";
import { SCHEDULER_SERVICE_NAME } from "../../scheduler/contract.ts";
import { schedulerMigrations } from "../../scheduler/index.ts";
import { MISSION_SERVICE_NAME } from "../../mission/contract.ts";
import { missionMigrations } from "../../mission/index.ts";
import { workbenchMigrations } from "../../workbench/index.ts";
import { WORKBENCH_SERVICE_NAME } from "../../workbench/contract.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { intakeMigrations } from "../../intake/index.ts";

const PROJECT_SERVICE_NAME = "project";
const GATEWAY_SERVICE_NAME = "gateway";

const services: Migrations = [
  { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  { service: "gateway", migrations: gatewayMigrations },
  { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
  { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
  { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
  { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
  { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
  { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
];
const HISTORY_TABLE = "migration";
const CREDENTIAL_TABLE = "credential";
const AGENT_ENABLEMENT_TABLE = "agent_enablement";
const AGENT_PROMPT_TABLE = "agent_prompt";
const WORKER_INSTANCE_TABLE = "worker_instance";
const ERD2_WORKER_TABLES = [WORKER_INSTANCE_TABLE];
const PROJECT_PROJECT_TABLE = "project_project";
const PROJECT_BINDING_TABLE = "project_binding";
const SCHEDULER_JOB_TABLE = "scheduler_job";
const SCHEDULER_EXECUTION_TABLE = "scheduler_execution";
const SCHEDULER_TABLES = [SCHEDULER_JOB_TABLE, SCHEDULER_EXECUTION_TABLE];
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
const INTAKE_INBOUND_TABLE = "intake_inbound";
const INTAKE_INBOUND_EVENT_TABLE = "intake_inbound_event";
const INTAKE_OUTBOUND_REQUEST_TABLE = "intake_outbound_request";
const INTAKE_TABLES = [
  INTAKE_INBOUND_TABLE,
  INTAKE_INBOUND_EVENT_TABLE,
  INTAKE_OUTBOUND_REQUEST_TABLE,
];
const INTEGRITY_OK = "ok";
const NO_PREFIX_MATCHES = 0;
const SINGLE_PREFIX_MATCH = 1;
const INDEX_SCHEMA_TYPE = "index";
const UNIQUE_INDEX = 1;
const ALL_TABLES = [
  AGENT_ENABLEMENT_TABLE,
  AGENT_PROMPT_TABLE,
  CREDENTIAL_TABLE,
  ...INTAKE_TABLES,
  MISSION_ASSESSMENT_TABLE,
  MISSION_ATTEMPT_TABLE,
  MISSION_DEPENDENCY_TABLE,
  MISSION_EVIDENCE_TABLE,
  MISSION_EVIDENCE_ASSET_TABLE,
  MISSION_MISSION_TABLE,
  MISSION_NODE_TABLE,
  MISSION_NODE_REVISION_TABLE,
  MISSION_OUTCOME_TABLE,
  PROJECT_BINDING_TABLE,
  PROJECT_PROJECT_TABLE,
  SCHEDULER_EXECUTION_TABLE,
  SCHEDULER_JOB_TABLE,
  WORKER_INSTANCE_TABLE,
];
const ALL_INDEXES = [
  "agent_enablement_agent_name_revision",
  "agent_prompt_scope_agent_name",
  "credential_name_revision",
  "intake_inbound_event_inbound_event",
  "intake_outbound_request_operation_key",
  MISSION_ASSESSMENT_SEQUENCE_INDEX,
  MISSION_ATTEMPT_OPEN_INDEX,
  MISSION_EVIDENCE_REQUEST_INDEX,
  "mission_node_filename_active",
  MISSION_OUTCOME_SEQUENCE_INDEX,
  "project_binding_revision",
  "project_project_name",
  "scheduler_execution_node_live",
  "scheduler_execution_runtime_live",
  "scheduler_job_node_id",
  "worker_instance_live_client",
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
      AGENT_ENABLEMENT_TABLE,
      AGENT_PROMPT_TABLE,
      ...ERD2_WORKER_TABLES,
      PROJECT_PROJECT_TABLE,
      PROJECT_BINDING_TABLE,
      ...SCHEDULER_TABLES,
      ...MISSION_TABLES,
      ...INTAKE_TABLES,
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
        assert.deepEqual(tables(store), SCHEDULER_TABLES);
      if (service.service === MISSION_SERVICE_NAME)
        assert.deepEqual(tables(store), MISSION_TABLES);
      if (service.service === AGENT_COMPONENT_NAME)
        assert.deepEqual(tables(store), [
          AGENT_ENABLEMENT_TABLE,
          AGENT_PROMPT_TABLE,
        ]);
      if (service.service === WORKER_SERVICE_NAME)
        assert.deepEqual(tables(store), ERD2_WORKER_TABLES);
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

test("all ERD 1, ERD 2 and ERD 3 migrations produce exactly the twenty tables", () => {
  const allServices: Migrations = [
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
    { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
    { service: GATEWAY_SERVICE_NAME, migrations: gatewayMigrations },
    { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    { service: WORKER_SERVICE_NAME, migrations: workerMigrations },
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
    { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
    { service: WORKBENCH_SERVICE_NAME, migrations: workbenchMigrations },
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ];
  const prefixes = allServices.map(({ service }) => `${service}_`);
  assert.equal(new Set(prefixes).size, allServices.length);
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    const applied: Migrations[number][] = [];
    const owners = new Map<string, string>();
    for (const service of allServices) {
      const before = new Set(tables(store));
      applied.push(service);
      store.migrate(applied);
      for (const name of tables(store).filter((name) => !before.has(name))) {
        owners.set(name, service.service);
      }
    }
    assert.deepEqual([...tables(store)].sort(), ALL_TABLES);
    assertSchemaRules(store, owners);
    for (const name of tables(store)) {
      const matches = allServices.filter(({ service }) =>
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
  for (const service of allServices) {
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

function assertSchemaRules(store: Store, owners: ReadonlyMap<string, string>) {
  const schema = store.database
    .prepare("SELECT name, type, sql FROM sqlite_master ORDER BY name")
    .all();
  assert.deepEqual(
    schema
      .filter((row) => row.type === INDEX_SCHEMA_TYPE && row.sql !== null)
      .map((row) => row.name),
    ALL_INDEXES,
  );
  for (const row of schema) assert.doesNotMatch(String(row.sql), /\bCHECK\b/i);
  const executionReferences: string[] = [];
  const intakeReferences: string[] = [];
  for (const table of ALL_TABLES) {
    const indexes = store.database
      .prepare("SELECT * FROM pragma_index_list(?)")
      .all(table);
    for (const index of indexes)
      assert.equal(index.unique, UNIQUE_INDEX, String(index.name));
    const references = store.database
      .prepare("SELECT * FROM pragma_foreign_key_list(?)")
      .all(table);
    for (const reference of references) {
      assert.ok(owners.has(String(reference.table)));
      assert.equal(owners.get(table), owners.get(String(reference.table)));
    }
    if (ERD2_MISSION_TABLES.includes(table)) {
      executionReferences.push(
        ...references.map(
          (row) =>
            `${table}.${String(row.from)}->${String(row.table)}.${String(row.to)}`,
        ),
      );
    }
    if (INTAKE_TABLES.includes(table)) {
      intakeReferences.push(
        ...references.map(
          (row) =>
            `${table}.${String(row.from)}->${String(row.table)}.${String(row.to)}`,
        ),
      );
    }
    if (
      table === WORKER_INSTANCE_TABLE ||
      table === SCHEDULER_EXECUTION_TABLE ||
      table === INTAKE_INBOUND_TABLE ||
      table === INTAKE_OUTBOUND_REQUEST_TABLE
    )
      assert.deepEqual(references, []);
  }
  assert.deepEqual(intakeReferences, [
    `${INTAKE_INBOUND_EVENT_TABLE}.inbound_id->${INTAKE_INBOUND_TABLE}.id`,
  ]);
  assert.deepEqual(executionReferences.sort(), [
    "mission_assessment.node_id->mission_node.id",
    "mission_attempt.node_id->mission_node.id",
    "mission_evidence.node_id->mission_node.id",
    "mission_evidence_asset.evidence_id->mission_evidence.id",
    "mission_outcome.assessment_id->mission_assessment.id",
    "mission_outcome.node_id->mission_node.id",
  ]);
}

test("Scheduler executions have exactly the ruled columns and partial unique indexes", (t) => {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: SCHEDULER_SERVICE_NAME, migrations: schedulerMigrations },
  ]);
  const columns = store.database
    .prepare(`PRAGMA table_info('${SCHEDULER_EXECUTION_TABLE}')`)
    .all();
  assert.deepEqual(
    columns.map((row) => [row.name, row.type, row.notnull, row.pk]),
    [
      ["id", "TEXT", 1, 1],
      ["project_id", "TEXT", 1, 0],
      ["node_id", "TEXT", 1, 0],
      ["worker_binding_id", "TEXT", 1, 0],
      ["resource_identity", "TEXT", 1, 0],
      ["runtime_identity", "TEXT", 1, 0],
      ["attempt", "INTEGER", 1, 0],
      ["pinned_revision", "INTEGER", 1, 0],
      ["credentials", "TEXT", 1, 0],
      ["expired_at", "INTEGER", 1, 0],
      ["trace_id", "TEXT", 1, 0],
      ["root_span_id", "TEXT", 1, 0],
      ["created_at", "INTEGER", 1, 0],
      ["ended_at", "INTEGER", 0, 0],
      ["stop", "TEXT", 0, 0],
    ],
  );
  const indexes = store.database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
    )
    .all(SCHEDULER_EXECUTION_TABLE);
  assert.deepEqual(
    indexes.map((row) => row.name),
    ["scheduler_execution_node_live", "scheduler_execution_runtime_live"],
  );
  for (const row of indexes) {
    assert.match(String(row.sql), /^CREATE UNIQUE INDEX /);
    assert.match(String(row.sql), /WHERE ended_at IS NULL$/);
  }
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA foreign_key_list('${SCHEDULER_EXECUTION_TABLE}')`)
      .all(),
    [],
  );
  assert.doesNotMatch(
    String(
      store.database
        .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
        .get(SCHEDULER_EXECUTION_TABLE)?.sql,
    ),
    /\bCHECK\s*\(/i,
  );
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
