import assert from "node:assert/strict";
import { z } from "zod";
import {
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
} from "../kernel/cause.ts";
import { NodeState } from "../mission/contract.ts";
import { bucketStart } from "./analytics-bucket.ts";
import {
  AnalyticsBucket,
  ExecutionEnd,
  FlowEvaluationStage,
  flowEvaluationStageSchema,
  FlowExit,
  FlowGateAffected,
  flowGateAffectedSchema,
  FlowKind,
  flowKindSchema,
  FlowStage,
  flowStageSchema,
  FlowStopReason,
  flowStopReasonSchema,
  RevokeCause,
  revokeCauseSchema,
  TransitionRule,
  transitionRuleSchema,
} from "./contract.ts";

export const FLOW_HOUR_RETENTION_DAYS = 8;
export const FLOW_DAY_RETENTION_DAYS = 64;
export const FLOW_HOUR_RANGE_DAYS_MAX = 2;
export const LATE_RECORD_MS = 3600000;

export const FlowStageKey = { ...FlowStage, None: "" } as const;
export const flowStageKeySchema = z.enum(FlowStageKey);
export type FlowStageKey = z.infer<typeof flowStageKeySchema>;

export const StopReasonKey = { ...FlowStopReason, None: "" } as const;
export const stopReasonKeySchema = z.enum(StopReasonKey);
export type StopReasonKey = z.infer<typeof stopReasonKeySchema>;

export const FlowCauseCategory = { ...CauseCategory, None: "" } as const;
export const flowCauseCategorySchema = z.enum(FlowCauseCategory);
export type FlowCauseCategory = z.infer<typeof flowCauseCategorySchema>;

export const FlowCauseDetail = {
  ...CauseSubcategory,
  ...CauseCategory,
  None: "",
} as const;
export const flowCauseDetailSchema = z.enum(FlowCauseDetail);
export type FlowCauseDetail = z.infer<typeof flowCauseDetailSchema>;

export const FlowCauseAssigner = { ...CauseAssigner, None: "" } as const;
export const flowCauseAssignerSchema = z.enum(FlowCauseAssigner);
export type FlowCauseAssigner = z.infer<typeof flowCauseAssignerSchema>;

const executionEndSchema = z.enum(ExecutionEnd);
const nodeStateSchema = z.enum(NodeState);

function closedValue<T extends string>(schema: z.ZodType<T>) {
  return (value: unknown): T | null => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
}

export const validRootEnd = closedValue(executionEndSchema);
export const validRevokeCause = closedValue(revokeCauseSchema);
export const validTransitionTo = closedValue(nodeStateSchema);
export const validTransitionRule = closedValue(transitionRuleSchema);
export const validEvaluationStage = closedValue(flowEvaluationStageSchema);
export const validGateAffected = closedValue(flowGateAffectedSchema);
export const validKind = closedValue(flowKindSchema);
export const validStage = closedValue(flowStageSchema);

export interface FlowTrace {
  project_id: string | null;
  worker_name: string | null;
  stop_reason: string | null;
  cost_usd: number;
  turn_count: number;
  tool_count: number;
  kind: string | null;
  stage: string | null;
  root_end: string | null;
  revoke_cause: string | null;
  transition_to: string | null;
  transition_rule: string | null;
  cause_category: string;
  cause_detail: string;
  cause_assigner: string;
  evaluation_stage: string | null;
  tool_error_count: number;
  turn_rate_limited: number;
  turn_quota_exhausted: number;
  turn_unavailable: number;
  turn_error_other: number;
  gate_routed: number;
  gate_affected: string | null;
  affected_runs: number;
  affected_failed: number;
  affected_base_red: number;
  affected_flaky_runs: number;
  flaky_tests: number;
  late_records: number;
}

export const FLOW_VECTOR_COLUMNS = [
  "executions",
  "unobserved",
  "awaiting_ingestion",
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
] as const;
export type FlowVectorColumn = (typeof FLOW_VECTOR_COLUMNS)[number];
export type FlowVector = Record<FlowVectorColumn, number>;

export interface FlowKey {
  project_id: string;
  worker_name: string;
  stage: FlowStageKey;
  exit: FlowExit;
  stop_reason: StopReasonKey;
  cause_category: string;
  cause_detail: string;
  cause_assigner: string;
}

export interface FlowContribution {
  key: FlowKey;
  vector: FlowVector;
}

const OUTCOME_TRANSITIONS: Readonly<Record<string, FlowExit>> = {
  [NodeState.Completed]: FlowExit.Completed,
  [NodeState.ExternalRequested]: FlowExit.External,
  [NodeState.ExternalSuccess]: FlowExit.External,
  [NodeState.Available]: FlowExit.Rework,
  [NodeState.Blocked]: FlowExit.Blocked,
  [NodeState.ExternalFailed]: FlowExit.Blocked,
};
const OUTCOME_EXITS: ReadonlySet<FlowExit> = new Set([
  FlowExit.Completed,
  FlowExit.External,
  FlowExit.Rework,
  FlowExit.Blocked,
]);
const CAUSE_EXITS: ReadonlySet<FlowExit> = new Set([
  FlowExit.Stopped,
  FlowExit.Paused,
  FlowExit.Revoked,
  FlowExit.Rework,
  FlowExit.Blocked,
  FlowExit.Budget,
]);
const NOT_A_STOP: ReadonlySet<string> = new Set([
  FlowStopReason.Lost,
  FlowStopReason.BudgetEnd,
]);
const NO_VALUE = "";
const NO_TURNS = 0;

function isAssessedEnd(trace: FlowTrace): boolean {
  if (trace.kind !== FlowKind.Evaluation) return false;
  if (trace.root_end === ExecutionEnd.Revoked)
    return trace.revoke_cause === RevokeCause.Assessment;
  return trace.root_end === ExecutionEnd.Finished && trace.stop_reason === null;
}

export function exitOf(trace: FlowTrace): FlowExit {
  if (trace.root_end === null) return FlowExit.Open;
  if (
    trace.root_end === ExecutionEnd.Revoked &&
    trace.revoke_cause === RevokeCause.Human
  )
    return FlowExit.Revoked;
  if (trace.transition_to === NodeState.Paused) return FlowExit.Paused;
  const outcome = OUTCOME_TRANSITIONS[trace.transition_to ?? NO_VALUE];
  if (isAssessedEnd(trace) && outcome !== undefined) return outcome;
  if (trace.stop_reason === FlowStopReason.BudgetEnd) return FlowExit.Budget;
  if (trace.stop_reason !== null || trace.root_end === ExecutionEnd.Lost)
    return FlowExit.Stopped;
  if (trace.kind !== FlowKind.Steps || trace.root_end !== ExecutionEnd.Finished)
    return FlowExit.Unknown;
  if (trace.transition_to === NodeState.Available) return FlowExit.FurtherWork;
  if (trace.transition_to === NodeState.Waiting) return FlowExit.HandedOn;
  return FlowExit.Unknown;
}

function isUnobserved(trace: FlowTrace, exit: FlowExit): boolean {
  return exit === FlowExit.HandedOn && trace.stage === FlowStage.Executing;
}

function stageOf(
  trace: FlowTrace,
  exit: FlowExit,
  unobserved: boolean,
): FlowStageKey {
  if (unobserved) return FlowStage.ReleaseGate;
  if (OUTCOME_EXITS.has(exit)) return FlowStage.Outcome;
  if ((trace.kind ?? FlowKind.None) === FlowKind.None) return FlowStageKey.None;
  return validStage(trace.stage) ?? FlowStageKey.None;
}

function stopReasonOf(trace: FlowTrace, exit: FlowExit): StopReasonKey {
  if (exit !== FlowExit.Stopped) return StopReasonKey.None;
  const stop = closedValue(flowStopReasonSchema)(trace.stop_reason);
  if (stop !== null && !NOT_A_STOP.has(stop)) return stop;
  if (trace.root_end === ExecutionEnd.Lost) return FlowStopReason.Lost;
  return StopReasonKey.None;
}

function oneIf(condition: boolean): number {
  return condition ? 1 : 0;
}

function awaitingIngestion(
  trace: FlowTrace,
  isHostedWorker: (workerName: string) => boolean,
): boolean {
  const worker = trace.worker_name ?? NO_VALUE;
  return (
    trace.root_end !== null &&
    worker !== NO_VALUE &&
    !isHostedWorker(worker) &&
    trace.turn_count === NO_TURNS
  );
}

export function contributionOf(
  trace: FlowTrace,
  isHostedWorker: (workerName: string) => boolean,
): FlowContribution {
  const exit = exitOf(trace);
  const unobserved = isUnobserved(trace, exit);
  const withCause = CAUSE_EXITS.has(exit);
  const blocked = exit === FlowExit.Blocked;
  return {
    key: {
      project_id: trace.project_id ?? NO_VALUE,
      worker_name: trace.worker_name ?? NO_VALUE,
      stage: stageOf(trace, exit, unobserved),
      exit,
      stop_reason: stopReasonOf(trace, exit),
      cause_category: withCause ? trace.cause_category : NO_VALUE,
      cause_detail: withCause ? trace.cause_detail : NO_VALUE,
      cause_assigner: withCause ? trace.cause_assigner : NO_VALUE,
    },
    vector: {
      executions: 1,
      unobserved: oneIf(unobserved),
      awaiting_ingestion: oneIf(awaitingIngestion(trace, isHostedWorker)),
      cost_usd: trace.cost_usd,
      turn_count: trace.turn_count,
      tool_count: trace.tool_count,
      tool_error_count: trace.tool_error_count,
      turn_rate_limited: trace.turn_rate_limited,
      turn_quota_exhausted: trace.turn_quota_exhausted,
      turn_unavailable: trace.turn_unavailable,
      turn_error_other: trace.turn_error_other,
      gate_routed: trace.gate_routed,
      gate_affected_passed: oneIf(
        trace.gate_affected === FlowGateAffected.Passed,
      ),
      gate_affected_base_red: oneIf(
        trace.gate_affected === FlowGateAffected.BaseRed,
      ),
      gate_affected_absent: oneIf(
        trace.gate_affected === FlowGateAffected.Absent,
      ),
      affected_runs: trace.affected_runs,
      affected_failed: trace.affected_failed,
      affected_base_red: trace.affected_base_red,
      affected_flaky_runs: trace.affected_flaky_runs,
      flaky_tests: trace.flaky_tests,
      evaluation_setup: oneIf(
        trace.evaluation_stage === FlowEvaluationStage.Setup,
      ),
      evaluation_verification: oneIf(
        trace.evaluation_stage === FlowEvaluationStage.Verification,
      ),
      evaluation_affected: oneIf(
        trace.evaluation_stage === FlowEvaluationStage.Affected,
      ),
      evaluation_judgement: oneIf(
        trace.evaluation_stage === FlowEvaluationStage.Judgement,
      ),
      blocked_rework_limit: oneIf(
        blocked && trace.transition_rule === TransitionRule.ReworkLimit,
      ),
      blocked_plan_defect: oneIf(
        blocked && trace.transition_rule === TransitionRule.PlanDefect,
      ),
      late_records: trace.late_records,
    },
  };
}

export interface FlowBuckets {
  hour: number;
  day: number;
}

function startOf(
  anchorMs: number,
  bucket: typeof AnalyticsBucket.Hour | typeof AnalyticsBucket.Day,
): number {
  const start = bucketStart(anchorMs, bucket);
  assert.ok(start !== null);
  return start;
}

export function bucketsOf(anchorMs: number): FlowBuckets {
  return {
    hour: startOf(anchorMs, AnalyticsBucket.Hour),
    day: startOf(anchorMs, AnalyticsBucket.Day),
  };
}
