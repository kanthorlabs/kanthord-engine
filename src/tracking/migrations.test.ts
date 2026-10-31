import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { TRACKING_SERVICE_NAME } from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const TEXT_TABLE = "tracking_telemetry_text";
const ENTRY_TABLE = "tracking_session_entry";
const ENTRY_SEQUENCE_INDEX = "tracking_session_entry_sequence";
const TRACE_TABLE = "tracking_trace";
const FLOW_ROLLUP_TABLE = "tracking_flow_rollup";
const FLOW_HISTOGRAM_TABLE = "tracking_flow_histogram";
const USAGE_ROLLUP_TABLE = "tracking_usage_rollup";
const BUCKET_COLUMN = "bucket_start";
const COST_COLUMN = "cost_usd";
const CASCADE = "CASCADE";
const UNIQUE_INDEX = 1;

function migratedStore(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

test("the telemetry text table holds its identity, a required content and its creation time", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA table_info(${TEXT_TABLE})`)
      .all()
      .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
    [
      { name: "trace_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "text_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "content", type: "TEXT", notnull: 1, pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
    ],
  );
});

test("the telemetry text table cascades from its trace", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA foreign_key_list(${TEXT_TABLE})`)
      .all()
      .map((row) => ({
        table: row.table,
        from: row.from,
        to: row.to,
        on_delete: row.on_delete,
      })),
    [
      {
        table: TRACE_TABLE,
        from: "trace_id",
        to: "trace_id",
        on_delete: CASCADE,
      },
    ],
  );
});

test("the tracking schema holds no CHECK constraint", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'tracking_*' ORDER BY name",
      )
      .all()
      .map((row) => row.name),
    [
      "tracking_flow_histogram",
      "tracking_flow_rollup",
      "tracking_record",
      "tracking_session_entry",
      "tracking_span",
      "tracking_telemetry_text",
      "tracking_trace",
      "tracking_usage_rollup",
    ],
  );
  for (const row of store.database
    .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")
    .all())
    assert.doesNotMatch(String(row.sql), /\bCHECK\b/i);
});

test("the session entry table holds its identity, its sequence and its content", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA table_info(${ENTRY_TABLE})`)
      .all()
      .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
    [
      { name: "trace_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "session_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "entry_id", type: "TEXT", notnull: 1, pk: 3 },
      { name: "parent_entry_id", type: "TEXT", notnull: 0, pk: 0 },
      { name: "sequence", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "entry_type", type: "TEXT", notnull: 1, pk: 0 },
      { name: "entry_time", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "tool_call_id", type: "TEXT", notnull: 0, pk: 0 },
      { name: "truncated", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "content", type: "TEXT", notnull: 1, pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
    ],
  );
});

test("the session entry table cascades from its trace", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA foreign_key_list(${ENTRY_TABLE})`)
      .all()
      .map((row) => ({
        table: row.table,
        from: row.from,
        to: row.to,
        on_delete: row.on_delete,
      })),
    [
      {
        table: TRACE_TABLE,
        from: "trace_id",
        to: "trace_id",
        on_delete: CASCADE,
      },
    ],
  );
});

test("the session entry sequence is a unique index on the trace, the session and the sequence", (t) => {
  const store = migratedStore(t);
  const index = store.database
    .prepare(`PRAGMA index_list(${ENTRY_TABLE})`)
    .all()
    .find((row) => row.name === ENTRY_SEQUENCE_INDEX);
  assert.equal(index?.unique, UNIQUE_INDEX);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA index_info(${ENTRY_SEQUENCE_INDEX})`)
      .all()
      .map((row) => row.name),
    ["trace_id", "session_id", "sequence"],
  );
});

test("the trace table holds the summary columns with their defaults", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA table_info(${TRACE_TABLE})`)
      .all()
      .slice(5)
      .map(({ name, type, notnull, dflt_value }) => ({
        name,
        type,
        notnull,
        dflt_value,
      })),
    [
      { name: "node_id", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "attempt", type: "INTEGER", notnull: 0, dflt_value: null },
      { name: "state", type: "TEXT", notnull: 1, dflt_value: "'open'" },
      { name: "started_at", type: "INTEGER", notnull: 0, dflt_value: null },
      { name: "ended_at", type: "INTEGER", notnull: 0, dflt_value: null },
      { name: "stop_reason", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "worker_name", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "agent_names", type: "TEXT", notnull: 1, dflt_value: "'[]'" },
      { name: "models", type: "TEXT", notnull: 1, dflt_value: "'[]'" },
      { name: "error_types", type: "TEXT", notnull: 1, dflt_value: "'[]'" },
      { name: "input_tokens", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "output_tokens", type: "INTEGER", notnull: 1, dflt_value: "0" },
      {
        name: "cache_read_tokens",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      },
      {
        name: "cache_creation_tokens",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      },
      { name: "cost_usd", type: "REAL", notnull: 1, dflt_value: "0" },
      { name: "span_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "turn_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "tool_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "error_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
      {
        name: "first_error_span_id",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
      },
      ...flowColumns([
        ["kind", "TEXT"],
        ["stage", "TEXT"],
        ["root_end", "TEXT"],
        ["revoke_cause", "TEXT"],
        ["transition_to", "TEXT"],
        ["transition_rule", "TEXT"],
        ["cause_category", "TEXT", "''"],
        ["cause_detail", "TEXT", "''"],
        ["cause_assigner", "TEXT", "''"],
        ["evaluation_stage", "TEXT"],
        ["tool_error_count", "INTEGER", "0"],
        ["turn_rate_limited", "INTEGER", "0"],
        ["turn_quota_exhausted", "INTEGER", "0"],
        ["turn_unavailable", "INTEGER", "0"],
        ["turn_error_other", "INTEGER", "0"],
        ["gate_routed", "INTEGER", "0"],
        ["gate_affected", "TEXT"],
        ["affected_runs", "INTEGER", "0"],
        ["affected_failed", "INTEGER", "0"],
        ["affected_base_red", "INTEGER", "0"],
        ["affected_flaky_runs", "INTEGER", "0"],
        ["flaky_tests", "INTEGER", "0"],
        ["late_records", "INTEGER", "0"],
      ]),
    ],
  );
});

test("the trace table holds only its execution index", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA index_list(${TRACE_TABLE})`)
      .all()
      .map((row) => row.name)
      .sort(),
    ["sqlite_autoindex_tracking_trace_1", "tracking_trace_execution"],
  );
});

function tableColumns(
  store: Store,
  table: string,
): { name: unknown; type: unknown; notnull: unknown; pk: unknown }[] {
  return store.database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
}

function keyedColumns(
  columns: readonly (readonly [string, string])[],
  keys: readonly string[],
) {
  return columns.map(([name, type]) => ({
    name,
    type,
    notnull: 1,
    pk: keys.indexOf(name) + 1,
  }));
}

function onlyAutomaticIndex(store: Store, table: string) {
  const indexes = store.database.prepare(`PRAGMA index_list(${table})`).all();
  return indexes.map((row) => ({ origin: row.origin, unique: row.unique }));
}

const ROLLUP_KEYS = [
  "grain",
  "bucket_start",
  "project_id",
  "worker_name",
  "stage",
  "exit",
  "stop_reason",
  "cause_category",
  "cause_detail",
  "cause_assigner",
];
const ROLLUP_COUNTERS = [
  "executions",
  "unobserved",
  "awaiting_ingestion",
  "changed_after_end",
  "cost_usd",
  "turn_count",
  "tool_count",
  "tool_error_count",
  "turn_rate_limited",
  "turn_quota_exhausted",
  "turn_unavailable",
  "turn_error_other",
  "gate_routed",
  "gate_affected_passed",
  "gate_affected_base_red",
  "gate_affected_absent",
  "affected_runs",
  "affected_failed",
  "affected_base_red",
  "affected_flaky_runs",
  "flaky_tests",
  "evaluation_setup",
  "evaluation_verification",
  "evaluation_affected",
  "evaluation_judgement",
  "blocked_rework_limit",
  "blocked_plan_defect",
  "late_records",
];

test("the flow rollup table holds its keys and its counters", (t) => {
  const store = migratedStore(t);
  const columns: [string, string][] = [
    ...ROLLUP_KEYS.map((name): [string, string] => [
      name,
      name === BUCKET_COLUMN ? "INTEGER" : "TEXT",
    ]),
    ...ROLLUP_COUNTERS.map((name): [string, string] => [
      name,
      name === COST_COLUMN ? "REAL" : "INTEGER",
    ]),
  ];
  assert.deepEqual(
    tableColumns(store, FLOW_ROLLUP_TABLE),
    keyedColumns(columns, ROLLUP_KEYS),
  );
  assert.deepEqual(onlyAutomaticIndex(store, FLOW_ROLLUP_TABLE), [
    { origin: "pk", unique: UNIQUE_INDEX },
  ]);
});

test("the flow histogram table holds its keys and its bins", (t) => {
  const store = migratedStore(t);
  const keys = [
    "grain",
    "bucket_start",
    "project_id",
    "worker_name",
    "measure",
  ];
  assert.deepEqual(
    tableColumns(store, FLOW_HISTOGRAM_TABLE),
    keyedColumns(
      [
        ["grain", "TEXT"],
        ["bucket_start", "INTEGER"],
        ["project_id", "TEXT"],
        ["worker_name", "TEXT"],
        ["measure", "TEXT"],
        ["bins", "BLOB"],
      ],
      keys,
    ),
  );
  assert.deepEqual(onlyAutomaticIndex(store, FLOW_HISTOGRAM_TABLE), [
    { origin: "pk", unique: UNIQUE_INDEX },
  ]);
});

test("the usage rollup table holds its keys and its sums", (t) => {
  const store = migratedStore(t);
  const keys = ["grain", "bucket_start", "project_id", "worker_name", "model"];
  assert.deepEqual(
    tableColumns(store, USAGE_ROLLUP_TABLE),
    keyedColumns(
      [
        ["grain", "TEXT"],
        ["bucket_start", "INTEGER"],
        ["project_id", "TEXT"],
        ["worker_name", "TEXT"],
        ["model", "TEXT"],
        ["turn_count", "INTEGER"],
        ["input_tokens", "INTEGER"],
        ["output_tokens", "INTEGER"],
        ["cache_read_tokens", "INTEGER"],
        ["cost_usd", "REAL"],
        ["unpriced_tokens", "INTEGER"],
      ],
      keys,
    ),
  );
  assert.deepEqual(onlyAutomaticIndex(store, USAGE_ROLLUP_TABLE), [
    { origin: "pk", unique: UNIQUE_INDEX },
  ]);
});

function flowColumns(columns: readonly (readonly [string, string, string?])[]) {
  return columns.map(([name, type, dflt]) => ({
    name,
    type,
    notnull: dflt === undefined ? 0 : 1,
    dflt_value: dflt ?? null,
  }));
}
