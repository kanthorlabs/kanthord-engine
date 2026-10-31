import assert from "node:assert/strict";
import { CauseAssigner } from "../kernel/cause.ts";
import type { Transaction } from "../kernel/store.ts";
import { FlowStage } from "./contract.ts";
import type { FlowCounterColumn, FlowFacts } from "./flow-facts.ts";
import type { FlowTrace } from "./flow-model.ts";

export const FLOW_COLUMNS = [
  "kind",
  "stage",
  "root_end",
  "revoke_cause",
  "transition_to",
  "transition_rule",
  "cause_category",
  "cause_detail",
  "cause_assigner",
  "evaluation_stage",
  "tool_error_count",
  "turn_rate_limited",
  "turn_quota_exhausted",
  "turn_unavailable",
  "turn_error_other",
  "gate_routed",
  "gate_affected",
  "affected_runs",
  "affected_failed",
  "affected_base_red",
  "affected_flaky_runs",
  "flaky_tests",
  "late_records",
] as const;
export type FlowColumn = (typeof FLOW_COLUMNS)[number];
export type FlowColumns = Pick<FlowTrace, FlowColumn>;
export type FlowColumnValues = Readonly<Record<string, string | number | null>>;

export interface FlowTraceRow extends FlowTrace {
  execution_id: string | null;
  root_span_id: string;
  ended_at: number | null;
}

const NOT_HELD = -1;
const NO_COLUMNS = 0;
const ONE_ROW = 1;
const HUMAN_ASSIGNER = CauseAssigner.Human;
const STAGES: readonly string[] = Object.values(FlowStage);

function textOrNull(value: unknown): string | null {
  return value === null ? null : String(value);
}

export function readFlowTrace(
  tx: Transaction,
  traceId: string,
): FlowTraceRow | null {
  assert.ok(traceId);
  const row = tx.database
    .prepare(
      `SELECT execution_id, root_span_id, ended_at, project_id, worker_name, stop_reason, cost_usd, turn_count, tool_count, ${FLOW_COLUMNS.join(", ")} FROM tracking_trace WHERE trace_id = ?`,
    )
    .get(traceId);
  if (!row) return null;
  return {
    execution_id: textOrNull(row.execution_id),
    root_span_id: String(row.root_span_id),
    ended_at: row.ended_at === null ? null : Number(row.ended_at),
    project_id: textOrNull(row.project_id),
    worker_name: textOrNull(row.worker_name),
    stop_reason: textOrNull(row.stop_reason),
    cost_usd: Number(row.cost_usd),
    turn_count: Number(row.turn_count),
    tool_count: Number(row.tool_count),
    kind: textOrNull(row.kind),
    stage: textOrNull(row.stage),
    root_end: textOrNull(row.root_end),
    revoke_cause: textOrNull(row.revoke_cause),
    transition_to: textOrNull(row.transition_to),
    transition_rule: textOrNull(row.transition_rule),
    cause_category: String(row.cause_category),
    cause_detail: String(row.cause_detail),
    cause_assigner: String(row.cause_assigner),
    evaluation_stage: textOrNull(row.evaluation_stage),
    tool_error_count: Number(row.tool_error_count),
    turn_rate_limited: Number(row.turn_rate_limited),
    turn_quota_exhausted: Number(row.turn_quota_exhausted),
    turn_unavailable: Number(row.turn_unavailable),
    turn_error_other: Number(row.turn_error_other),
    gate_routed: Number(row.gate_routed),
    gate_affected: textOrNull(row.gate_affected),
    affected_runs: Number(row.affected_runs),
    affected_failed: Number(row.affected_failed),
    affected_base_red: Number(row.affected_base_red),
    affected_flaky_runs: Number(row.affected_flaky_runs),
    flaky_tests: Number(row.flaky_tests),
    late_records: Number(row.late_records),
  };
}

export function flowColumnsOf(trace: FlowTrace): FlowColumns {
  return {
    kind: trace.kind,
    stage: trace.stage,
    root_end: trace.root_end,
    revoke_cause: trace.revoke_cause,
    transition_to: trace.transition_to,
    transition_rule: trace.transition_rule,
    cause_category: trace.cause_category,
    cause_detail: trace.cause_detail,
    cause_assigner: trace.cause_assigner,
    evaluation_stage: trace.evaluation_stage,
    tool_error_count: trace.tool_error_count,
    turn_rate_limited: trace.turn_rate_limited,
    turn_quota_exhausted: trace.turn_quota_exhausted,
    turn_unavailable: trace.turn_unavailable,
    turn_error_other: trace.turn_error_other,
    gate_routed: trace.gate_routed,
    gate_affected: trace.gate_affected,
    affected_runs: trace.affected_runs,
    affected_failed: trace.affected_failed,
    affected_base_red: trace.affected_base_red,
    affected_flaky_runs: trace.affected_flaky_runs,
    flaky_tests: trace.flaky_tests,
    late_records: trace.late_records,
  };
}

function rankOf(stage: string | null): number {
  return stage === null ? NOT_HELD : STAGES.indexOf(stage);
}

function stageOf(current: string | null, fact: FlowFacts["stage"]) {
  if (fact === null || rankOf(fact) <= rankOf(current)) return current;
  return fact;
}

function pick<T>(change: T | undefined, current: T): T {
  return change === undefined ? current : change;
}

function countersAdded(
  columns: FlowColumns,
  counters: FlowFacts["counters"],
): Record<FlowCounterColumn, number> {
  const added = (column: FlowCounterColumn) =>
    columns[column] + (counters[column] ?? 0);
  return {
    tool_error_count: added("tool_error_count"),
    turn_rate_limited: added("turn_rate_limited"),
    turn_quota_exhausted: added("turn_quota_exhausted"),
    turn_unavailable: added("turn_unavailable"),
    turn_error_other: added("turn_error_other"),
    gate_routed: added("gate_routed"),
    affected_runs: added("affected_runs"),
    affected_failed: added("affected_failed"),
    affected_base_red: added("affected_base_red"),
    affected_flaky_runs: added("affected_flaky_runs"),
    flaky_tests: added("flaky_tests"),
    late_records: added("late_records"),
  };
}

function causeOf(columns: FlowColumns, cause: FlowFacts["cause"]) {
  if (cause === null) return columns;
  if (cause.unlessHuman && columns.cause_assigner === HUMAN_ASSIGNER)
    return columns;
  return { ...columns, ...cause.value };
}

export function applyFlowFacts(
  columns: FlowColumns,
  facts: FlowFacts,
): FlowColumns {
  const caused = causeOf(columns, facts.cause);
  return {
    ...caused,
    ...countersAdded(caused, facts.counters),
    kind: pick(facts.set.kind, caused.kind),
    stage: stageOf(caused.stage, facts.stage),
    root_end: pick(facts.set.root_end, caused.root_end),
    revoke_cause: pick(facts.set.revoke_cause, caused.revoke_cause),
    transition_to: pick(facts.set.transition_to, caused.transition_to),
    transition_rule: pick(facts.set.transition_rule, caused.transition_rule),
    evaluation_stage: pick(facts.set.evaluation_stage, caused.evaluation_stage),
    gate_affected: pick(facts.set.gate_affected, caused.gate_affected),
  };
}

export function changedFlowColumns(
  before: FlowColumns,
  after: FlowColumns,
): FlowColumnValues {
  return Object.fromEntries(
    FLOW_COLUMNS.filter((column) => before[column] !== after[column]).map(
      (column) => [column, after[column]],
    ),
  );
}

export function writeFlowColumns(
  tx: Transaction,
  traceId: string,
  changed: FlowColumnValues,
): void {
  assert.ok(traceId);
  const names = Object.keys(changed);
  if (names.length === NO_COLUMNS) return;
  const known: readonly string[] = FLOW_COLUMNS;
  assert.ok(names.every((name) => known.includes(name)));
  const assignments = names.map((name) => `${name} = ?`).join(", ");
  const result = tx.database
    .prepare(`UPDATE tracking_trace SET ${assignments} WHERE trace_id = ?`)
    .run(...Object.values(changed), traceId);
  assert.equal(Number(result.changes), ONE_ROW);
}
