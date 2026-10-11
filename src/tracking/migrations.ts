import type { Migration } from "../kernel/store.ts";

const createTraceTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE tracking_trace (
      trace_id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT,
      execution_id TEXT,
      root_span_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX tracking_trace_execution ON tracking_trace (execution_id) WHERE execution_id IS NOT NULL;
    CREATE TABLE tracking_span (
      trace_id TEXT NOT NULL REFERENCES tracking_trace (trace_id) ON DELETE CASCADE,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      producer TEXT NOT NULL,
      origin TEXT NOT NULL,
      operation TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      status TEXT NOT NULL,
      attributes TEXT NOT NULL,
      events TEXT NOT NULL,
      links TEXT NOT NULL,
      text_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (trace_id, span_id)
    );
    CREATE TABLE tracking_record (
      trace_id TEXT NOT NULL REFERENCES tracking_trace (trace_id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (trace_id, record_id)
    );
    CREATE TABLE tracking_telemetry_text (
      trace_id TEXT NOT NULL REFERENCES tracking_trace (trace_id) ON DELETE CASCADE,
      text_id TEXT NOT NULL,
      content TEXT,
      expired_at INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (trace_id, text_id)
    );
  `);
};

export const trackingMigrations: readonly Migration[] = [createTraceTables];
