import type { Migration } from "../kernel/store.ts";

const createTraceTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE tracking_trace (
      trace_id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT,
      execution_id TEXT,
      root_span_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      node_id TEXT,
      attempt INTEGER,
      state TEXT NOT NULL DEFAULT 'open',
      started_at INTEGER,
      ended_at INTEGER,
      stop_reason TEXT,
      worker_name TEXT,
      agent_names TEXT NOT NULL DEFAULT '[]',
      models TEXT NOT NULL DEFAULT '[]',
      error_types TEXT NOT NULL DEFAULT '[]',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      span_count INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
      tool_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      first_error_span_id TEXT,
      kind TEXT,
      stage TEXT,
      root_end TEXT,
      revoke_cause TEXT,
      transition_to TEXT,
      transition_rule TEXT,
      cause_category TEXT NOT NULL DEFAULT '',
      cause_detail TEXT NOT NULL DEFAULT '',
      cause_assigner TEXT NOT NULL DEFAULT '',
      evaluation_stage TEXT,
      tool_error_count INTEGER NOT NULL DEFAULT 0,
      turn_rate_limited INTEGER NOT NULL DEFAULT 0,
      turn_quota_exhausted INTEGER NOT NULL DEFAULT 0,
      turn_unavailable INTEGER NOT NULL DEFAULT 0,
      turn_error_other INTEGER NOT NULL DEFAULT 0,
      gate_routed INTEGER NOT NULL DEFAULT 0,
      gate_affected TEXT,
      affected_runs INTEGER NOT NULL DEFAULT 0,
      affected_failed INTEGER NOT NULL DEFAULT 0,
      affected_base_red INTEGER NOT NULL DEFAULT 0,
      affected_flaky_runs INTEGER NOT NULL DEFAULT 0,
      flaky_tests INTEGER NOT NULL DEFAULT 0,
      late_records INTEGER NOT NULL DEFAULT 0
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
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (trace_id, text_id)
    );
    CREATE TABLE tracking_session_entry (
      trace_id TEXT NOT NULL REFERENCES tracking_trace (trace_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      parent_entry_id TEXT,
      sequence INTEGER NOT NULL,
      entry_type TEXT NOT NULL,
      entry_time INTEGER NOT NULL,
      tool_call_id TEXT,
      truncated INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (trace_id, session_id, entry_id)
    );
    CREATE UNIQUE INDEX tracking_session_entry_sequence ON tracking_session_entry (trace_id, session_id, sequence);
    CREATE TABLE tracking_flow_rollup (
      grain TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      worker_name TEXT NOT NULL,
      stage TEXT NOT NULL,
      exit TEXT NOT NULL,
      stop_reason TEXT NOT NULL,
      cause_category TEXT NOT NULL,
      cause_detail TEXT NOT NULL,
      cause_assigner TEXT NOT NULL,
      executions INTEGER NOT NULL,
      unobserved INTEGER NOT NULL,
      awaiting_ingestion INTEGER NOT NULL,
      changed_after_end INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      turn_count INTEGER NOT NULL,
      tool_count INTEGER NOT NULL,
      tool_error_count INTEGER NOT NULL,
      turn_rate_limited INTEGER NOT NULL,
      turn_quota_exhausted INTEGER NOT NULL,
      turn_unavailable INTEGER NOT NULL,
      turn_error_other INTEGER NOT NULL,
      gate_routed INTEGER NOT NULL,
      gate_affected_passed INTEGER NOT NULL,
      gate_affected_base_red INTEGER NOT NULL,
      gate_affected_absent INTEGER NOT NULL,
      affected_runs INTEGER NOT NULL,
      affected_failed INTEGER NOT NULL,
      affected_base_red INTEGER NOT NULL,
      affected_flaky_runs INTEGER NOT NULL,
      flaky_tests INTEGER NOT NULL,
      evaluation_setup INTEGER NOT NULL,
      evaluation_verification INTEGER NOT NULL,
      evaluation_affected INTEGER NOT NULL,
      evaluation_judgement INTEGER NOT NULL,
      blocked_rework_limit INTEGER NOT NULL,
      blocked_plan_defect INTEGER NOT NULL,
      late_records INTEGER NOT NULL,
      PRIMARY KEY (grain, bucket_start, project_id, worker_name, stage, exit,
                   stop_reason, cause_category, cause_detail, cause_assigner)
    ) WITHOUT ROWID;
    CREATE TABLE tracking_flow_histogram (
      grain TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      worker_name TEXT NOT NULL,
      measure TEXT NOT NULL,
      bins BLOB NOT NULL,
      PRIMARY KEY (grain, bucket_start, project_id, worker_name, measure)
    );
    CREATE TABLE tracking_usage_rollup (
      grain TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      worker_name TEXT NOT NULL,
      model TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      unpriced_tokens INTEGER NOT NULL,
      PRIMARY KEY (grain, bucket_start, project_id, worker_name, model)
    ) WITHOUT ROWID;
  `);
};

export const trackingMigrations: readonly Migration[] = [createTraceTables];
