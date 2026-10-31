import assert from "node:assert/strict";
import { test } from "node:test";
import { CauseAssigner, CauseCategory } from "../kernel/cause.ts";
import { NodeState } from "../mission/contract.ts";
import { ExecutionStopReason } from "../scheduler/contract.ts";
import {
  ExecutionEnd,
  FlowEvaluationStage,
  flowEvaluationStageSchema,
  FlowExit,
  flowExitSchema,
  FlowGateAffected,
  flowGateAffectedSchema,
  FlowGrain,
  flowGrainSchema,
  FlowKind,
  flowKindSchema,
  FlowMeasure,
  flowMeasureSchema,
  FlowStage,
  flowStageSchema,
  FlowStopReason,
  flowStopReasonSchema,
  TransitionRule,
} from "./contract.ts";
import {
  bucketsOf,
  contributionOf,
  exitOf,
  FLOW_DAY_RETENTION_DAYS,
  FLOW_HOUR_RANGE_DAYS_MAX,
  FLOW_HOUR_RETENTION_DAYS,
  FLOW_VECTOR_COLUMNS,
  FlowCauseAssigner,
  flowCauseAssignerSchema,
  FlowCauseCategory,
  flowCauseCategorySchema,
  FlowCauseDetail,
  flowCauseDetailSchema,
  FlowStageKey,
  flowStageKeySchema,
  type FlowTrace,
  LATE_RECORD_MS,
  StopReasonKey,
  stopReasonKeySchema,
  validEvaluationStage,
  validGateAffected,
  validKind,
  validRevokeCause,
  validRootEnd,
  validStage,
  validTransitionRule,
  validTransitionTo,
} from "./flow-model.ts";

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const HOSTED = "hosted_worker";
const EXTERNAL = "external_worker";

function isHosted(workerName: string): boolean {
  return workerName === HOSTED;
}

function traceOf(overrides: Partial<FlowTrace> = {}): FlowTrace {
  return {
    project_id: "project_1",
    worker_name: HOSTED,
    stop_reason: null,
    cost_usd: 0,
    turn_count: 0,
    tool_count: 0,
    kind: FlowKind.Steps,
    stage: FlowStage.Executing,
    root_end: ExecutionEnd.Finished,
    revoke_cause: null,
    transition_to: null,
    transition_rule: null,
    cause_category: "",
    cause_detail: "",
    cause_assigner: "",
    evaluation_stage: null,
    tool_error_count: 0,
    turn_rate_limited: 0,
    turn_quota_exhausted: 0,
    turn_unavailable: 0,
    turn_error_other: 0,
    gate_routed: 0,
    gate_affected: null,
    affected_runs: 0,
    affected_failed: 0,
    affected_base_red: 0,
    affected_flaky_runs: 0,
    flaky_tests: 0,
    late_records: 0,
    ...overrides,
  };
}

function evaluationOf(overrides: Partial<FlowTrace> = {}): FlowTrace {
  return traceOf({
    kind: FlowKind.Evaluation,
    stage: FlowStage.Evaluation,
    ...overrides,
  });
}

test("an execution with no root end is open", () => {
  assert.equal(exitOf(traceOf({ root_end: null })), FlowExit.Open);
});

test("a human revoke wins over a pause", () => {
  const trace = traceOf({
    root_end: ExecutionEnd.Revoked,
    revoke_cause: "human",
    transition_to: NodeState.Paused,
    stop_reason: ExecutionStopReason.BudgetEnd,
  });
  assert.equal(exitOf(trace), FlowExit.Revoked);
});

test("a transition to Paused wins over an assessed end and a stop", () => {
  const trace = evaluationOf({
    transition_to: NodeState.Paused,
    stop_reason: ExecutionStopReason.NoProgress,
  });
  assert.equal(exitOf(trace), FlowExit.Paused);
});

test("an assessed end maps its transition to an outcome exit", () => {
  const expected: [string, FlowExit][] = [
    [NodeState.Completed, FlowExit.Completed],
    [NodeState.ExternalRequested, FlowExit.External],
    [NodeState.ExternalSuccess, FlowExit.External],
    [NodeState.Available, FlowExit.Rework],
    [NodeState.Blocked, FlowExit.Blocked],
    [NodeState.ExternalFailed, FlowExit.Blocked],
  ];
  for (const [transition, exit] of expected)
    assert.equal(exitOf(evaluationOf({ transition_to: transition })), exit);
});

test("each form of an assessed end reads as assessed", () => {
  const revoked = evaluationOf({
    root_end: ExecutionEnd.Revoked,
    revoke_cause: "assessment",
    transition_to: NodeState.Completed,
  });
  const finished = evaluationOf({ transition_to: NodeState.Completed });
  assert.equal(exitOf(revoked), FlowExit.Completed);
  assert.equal(exitOf(finished), FlowExit.Completed);
});

test("an evaluation with a stop or another end never reads as assessed", () => {
  const stopped = evaluationOf({
    transition_to: NodeState.Completed,
    stop_reason: ExecutionStopReason.ReportAbsent,
  });
  const lost = evaluationOf({
    root_end: ExecutionEnd.Lost,
    transition_to: NodeState.Completed,
  });
  assert.equal(exitOf(stopped), FlowExit.Stopped);
  assert.equal(exitOf(lost), FlowExit.Stopped);
});

test("a steps execution never reads as assessed", () => {
  const trace = traceOf({
    transition_to: NodeState.Completed,
    stop_reason: ExecutionStopReason.ReportAbsent,
  });
  assert.equal(exitOf(trace), FlowExit.Stopped);
  assert.equal(
    exitOf(traceOf({ transition_to: NodeState.Completed })),
    FlowExit.Unknown,
  );
});

test("an assessed end wins over a budget stop", () => {
  const trace = evaluationOf({
    root_end: ExecutionEnd.Revoked,
    revoke_cause: "assessment",
    transition_to: NodeState.Blocked,
    stop_reason: ExecutionStopReason.BudgetEnd,
  });
  assert.equal(exitOf(trace), FlowExit.Blocked);
});

test("a budget stop is budget and wins over stopped", () => {
  const trace = traceOf({ stop_reason: ExecutionStopReason.BudgetEnd });
  assert.equal(exitOf(trace), FlowExit.Budget);
});

test("a stop reason or a lost end is stopped and wins over further work", () => {
  assert.equal(
    exitOf(
      traceOf({
        stop_reason: ExecutionStopReason.NoProgress,
        transition_to: NodeState.Available,
      }),
    ),
    FlowExit.Stopped,
  );
  assert.equal(
    exitOf(
      traceOf({
        root_end: ExecutionEnd.Lost,
        transition_to: NodeState.Waiting,
      }),
    ),
    FlowExit.Stopped,
  );
});

test("a finished steps execution is further work or handed on", () => {
  assert.equal(
    exitOf(traceOf({ transition_to: NodeState.Available })),
    FlowExit.FurtherWork,
  );
  assert.equal(
    exitOf(traceOf({ transition_to: NodeState.Waiting })),
    FlowExit.HandedOn,
  );
});

test("an end that no row matches is unknown", () => {
  assert.equal(exitOf(traceOf()), FlowExit.Unknown);
  assert.equal(
    exitOf(
      traceOf({
        root_end: ExecutionEnd.Revoked,
        revoke_cause: "assessment",
        transition_to: NodeState.Available,
      }),
    ),
    FlowExit.Unknown,
  );
  assert.equal(
    exitOf(
      evaluationOf({
        root_end: ExecutionEnd.Revoked,
        revoke_cause: "assessment",
        transition_to: NodeState.Waiting,
      }),
    ),
    FlowExit.Unknown,
  );
  assert.equal(
    exitOf(
      evaluationOf({
        root_end: ExecutionEnd.Finished,
        transition_to: NodeState.Waiting,
      }),
    ),
    FlowExit.Unknown,
  );
});

test("an unobserved execution holds the stage release_gate", () => {
  const trace = traceOf({ transition_to: NodeState.Waiting });
  const { key, vector } = contributionOf(trace, isHosted);
  assert.equal(key.exit, FlowExit.HandedOn);
  assert.equal(key.stage, FlowStage.ReleaseGate);
  assert.deepEqual([vector.unobserved], [1]);
});

test("a handed on execution that passed a gate is observed", () => {
  const trace = traceOf({
    transition_to: NodeState.Waiting,
    stage: FlowStage.ReleaseGate,
  });
  const { key, vector } = contributionOf(trace, isHosted);
  assert.equal(key.stage, FlowStage.ReleaseGate);
  assert.deepEqual([vector.unobserved], [0]);
});

test("an outcome exit holds the stage outcome", () => {
  for (const transition of [
    NodeState.Completed,
    NodeState.ExternalSuccess,
    NodeState.Available,
    NodeState.Blocked,
  ])
    assert.equal(
      contributionOf(evaluationOf({ transition_to: transition }), isHosted).key
        .stage,
      FlowStage.Outcome,
    );
});

test("the kind empty holds the stage empty and another exit holds the trace stage", () => {
  const none = traceOf({ kind: FlowKind.None, stage: null, root_end: null });
  assert.equal(contributionOf(none, isHosted).key.stage, FlowStageKey.None);
  const open = traceOf({ root_end: null, stage: FlowStage.Verification });
  assert.equal(
    contributionOf(open, isHosted).key.stage,
    FlowStage.Verification,
  );
});

test("the stop reason follows each ExecutionStopReason value", () => {
  for (const reason of Object.values(ExecutionStopReason)) {
    const { key } = contributionOf(traceOf({ stop_reason: reason }), isHosted);
    const expected =
      reason === ExecutionStopReason.BudgetEnd ? StopReasonKey.None : reason;
    assert.equal(key.stop_reason, expected);
    assert.equal(
      key.exit,
      reason === ExecutionStopReason.BudgetEnd
        ? FlowExit.Budget
        : FlowExit.Stopped,
    );
  }
});

test("the stop reason is lost for a lost end and empty with no stop", () => {
  const lost = contributionOf(
    traceOf({ root_end: ExecutionEnd.Lost }),
    isHosted,
  );
  assert.equal(lost.key.stop_reason, FlowStopReason.Lost);
  const lostWithReason = contributionOf(
    traceOf({ root_end: ExecutionEnd.Lost, stop_reason: "unknown_reason" }),
    isHosted,
  );
  assert.equal(lostWithReason.key.stop_reason, FlowStopReason.Lost);
  const unknownStop = contributionOf(
    traceOf({ stop_reason: "unknown_reason" }),
    isHosted,
  );
  assert.equal(unknownStop.key.stop_reason, StopReasonKey.None);
  const finished = contributionOf(
    traceOf({ transition_to: NodeState.Waiting }),
    isHosted,
  );
  assert.equal(finished.key.stop_reason, StopReasonKey.None);
});

test("the cause stays only for the exits that carry a cause", () => {
  const cause = {
    cause_category: CauseCategory.Model,
    cause_detail: "no_progress",
    cause_assigner: CauseAssigner.Rule,
  };
  const carrying = [
    traceOf({ stop_reason: ExecutionStopReason.NoProgress, ...cause }),
    traceOf({ stop_reason: ExecutionStopReason.BudgetEnd, ...cause }),
    traceOf({ transition_to: NodeState.Paused, ...cause }),
    traceOf({
      root_end: ExecutionEnd.Revoked,
      revoke_cause: "human",
      ...cause,
    }),
    evaluationOf({ transition_to: NodeState.Available, ...cause }),
    evaluationOf({ transition_to: NodeState.Blocked, ...cause }),
  ];
  for (const trace of carrying) {
    const { key } = contributionOf(trace, isHosted);
    assert.equal(key.cause_category, CauseCategory.Model);
    assert.deepEqual([key.cause_detail], ["no_progress"]);
    assert.equal(key.cause_assigner, CauseAssigner.Rule);
  }
  const dropping = [
    traceOf({ root_end: null, ...cause }),
    traceOf({ transition_to: NodeState.Waiting, ...cause }),
    traceOf({ transition_to: NodeState.Available, ...cause }),
    evaluationOf({ transition_to: NodeState.Completed, ...cause }),
    evaluationOf({ transition_to: NodeState.ExternalSuccess, ...cause }),
  ];
  for (const trace of dropping) {
    const { key } = contributionOf(trace, isHosted);
    assert.deepEqual(
      [key.cause_category, key.cause_detail, key.cause_assigner],
      ["", "", ""],
    );
  }
});

test("the key holds the empty string for a null project and a null worker", () => {
  const { key } = contributionOf(
    traceOf({ project_id: null, worker_name: null }),
    isHosted,
  );
  assert.deepEqual([key.project_id], [""]);
  assert.deepEqual([key.worker_name], [""]);
});

test("an external worker with no turns after its end awaits ingestion", () => {
  const external = traceOf({ worker_name: EXTERNAL });
  assert.deepEqual(
    [contributionOf(external, isHosted).vector.awaiting_ingestion],
    [1],
  );
  const hosted = traceOf({ worker_name: HOSTED });
  assert.deepEqual(
    [contributionOf(hosted, isHosted).vector.awaiting_ingestion],
    [0],
  );
  const withTurns = traceOf({ worker_name: EXTERNAL, turn_count: 1 });
  assert.deepEqual(
    [contributionOf(withTurns, isHosted).vector.awaiting_ingestion],
    [0],
  );
  const open = traceOf({ worker_name: EXTERNAL, root_end: null });
  assert.deepEqual(
    [contributionOf(open, isHosted).vector.awaiting_ingestion],
    [0],
  );
  const unnamed = traceOf({ worker_name: null });
  assert.deepEqual(
    [contributionOf(unnamed, isHosted).vector.awaiting_ingestion],
    [0],
  );
});

test("the vector copies the summary and the flow counters", () => {
  const { vector } = contributionOf(
    traceOf({
      cost_usd: 1.5,
      turn_count: 2,
      tool_count: 3,
      tool_error_count: 4,
      turn_rate_limited: 5,
      turn_quota_exhausted: 6,
      turn_unavailable: 7,
      turn_error_other: 8,
      gate_routed: 9,
      affected_runs: 10,
      affected_failed: 11,
      affected_base_red: 12,
      affected_flaky_runs: 13,
      flaky_tests: 14,
      late_records: 15,
    }),
    isHosted,
  );
  assert.deepEqual(vector, {
    executions: 1,
    unobserved: 0,
    awaiting_ingestion: 0,
    cost_usd: 1.5,
    turn_count: 2,
    tool_count: 3,
    tool_error_count: 4,
    turn_rate_limited: 5,
    turn_quota_exhausted: 6,
    turn_unavailable: 7,
    turn_error_other: 8,
    gate_routed: 9,
    gate_affected_passed: 0,
    gate_affected_base_red: 0,
    gate_affected_absent: 0,
    affected_runs: 10,
    affected_failed: 11,
    affected_base_red: 12,
    affected_flaky_runs: 13,
    flaky_tests: 14,
    evaluation_setup: 0,
    evaluation_verification: 0,
    evaluation_affected: 0,
    evaluation_judgement: 0,
    blocked_rework_limit: 0,
    blocked_plan_defect: 0,
    late_records: 15,
  });
  assert.deepEqual(Object.keys(vector), [...FLOW_VECTOR_COLUMNS]);
});

test("each gate_affected value is one hot", () => {
  const names = {
    [FlowGateAffected.Passed]: "gate_affected_passed",
    [FlowGateAffected.BaseRed]: "gate_affected_base_red",
    [FlowGateAffected.Absent]: "gate_affected_absent",
  } as const;
  for (const [value, name] of Object.entries(names)) {
    const { vector } = contributionOf(
      traceOf({ gate_affected: value }),
      isHosted,
    );
    const hot = Object.values(names).filter((column) =>
      Boolean(vector[column]),
    );
    assert.deepEqual(hot, [name]);
  }
  const none = contributionOf(traceOf(), isHosted).vector;
  assert.deepEqual(
    [none.gate_affected_passed + none.gate_affected_base_red],
    [0],
  );
  assert.deepEqual([none.gate_affected_absent], [0]);
});

test("each evaluation_stage value is one hot", () => {
  const names = {
    [FlowEvaluationStage.Setup]: "evaluation_setup",
    [FlowEvaluationStage.Verification]: "evaluation_verification",
    [FlowEvaluationStage.Affected]: "evaluation_affected",
    [FlowEvaluationStage.Judgement]: "evaluation_judgement",
  } as const;
  for (const [value, name] of Object.entries(names)) {
    const { vector } = contributionOf(
      evaluationOf({ evaluation_stage: value }),
      isHosted,
    );
    const hot = Object.values(names).filter((column) =>
      Boolean(vector[column]),
    );
    assert.deepEqual(hot, [name]);
  }
});

test("the blocked rule is one hot for the exit blocked only", () => {
  const blocked = (rule: string, transition: string) =>
    contributionOf(
      evaluationOf({ transition_to: transition, transition_rule: rule }),
      isHosted,
    ).vector;
  const reworkLimit = blocked(TransitionRule.ReworkLimit, NodeState.Blocked);
  assert.deepEqual(
    [reworkLimit.blocked_rework_limit, reworkLimit.blocked_plan_defect],
    [1, 0],
  );
  const planDefect = blocked(
    TransitionRule.PlanDefect,
    NodeState.ExternalFailed,
  );
  assert.deepEqual(
    [planDefect.blocked_rework_limit, planDefect.blocked_plan_defect],
    [0, 1],
  );
  const other = blocked(TransitionRule.FailureLimit, NodeState.Blocked);
  assert.deepEqual(
    [other.blocked_rework_limit, other.blocked_plan_defect],
    [0, 0],
  );
  const notBlocked = blocked(TransitionRule.ReworkLimit, NodeState.Available);
  assert.deepEqual(
    [notBlocked.blocked_rework_limit, notBlocked.blocked_plan_defect],
    [0, 0],
  );
});

test("the bucket of each grain starts at the UTC hour and the UTC day of an anchor", () => {
  const day = 20000 * DAY_MS;
  const anchor = day + 5 * HOUR_MS + 1234567;
  assert.deepEqual(bucketsOf(anchor), {
    hour: day + 5 * HOUR_MS,
    day,
  });
});

test("each schema refuses a value outside its set", () => {
  const schemas = [
    flowGrainSchema,
    flowKindSchema,
    flowStageSchema,
    flowExitSchema,
    flowMeasureSchema,
    flowStopReasonSchema,
    flowEvaluationStageSchema,
    flowGateAffectedSchema,
    flowStageKeySchema,
    stopReasonKeySchema,
    flowCauseCategorySchema,
    flowCauseDetailSchema,
    flowCauseAssignerSchema,
  ];
  for (const schema of schemas)
    assert.equal(schema.safeParse("outside_the_set").success, false);
});

test("the sets hold their values", () => {
  assert.deepEqual(Object.values(FlowGrain), ["hour", "day"]);
  assert.deepEqual(Object.values(FlowKind), ["steps", "evaluation", ""]);
  assert.deepEqual(Object.values(FlowStage), [
    "queued",
    "executing",
    "verification",
    "release_gate",
    "evaluation",
    "outcome",
  ]);
  assert.deepEqual(Object.values(FlowMeasure), [
    "queue_wait",
    "execution_time",
    "verification_run_time",
    "gate_run_time",
    "review_wait",
    "evaluation_time",
    "lead_time",
  ]);
  assert.deepEqual(Object.values(FlowEvaluationStage), [
    "setup",
    "verification",
    "affected",
    "judgement",
  ]);
  assert.deepEqual(Object.values(FlowGateAffected), [
    "passed",
    "base_red",
    "absent",
  ]);
  assert.deepEqual([Object.values(FlowExit).length], [12]);
});

test("the key sets add the empty value", () => {
  assert.ok(flowStageKeySchema.safeParse("").success);
  assert.ok(flowStageKeySchema.safeParse("outcome").success);
  assert.ok(stopReasonKeySchema.safeParse("").success);
  assert.ok(stopReasonKeySchema.safeParse("lost").success);
  assert.ok(flowCauseCategorySchema.safeParse("").success);
  assert.ok(flowCauseCategorySchema.safeParse("unattributed").success);
  assert.ok(flowCauseAssignerSchema.safeParse("").success);
  assert.ok(flowCauseAssignerSchema.safeParse("human").success);
  assert.ok(flowCauseDetailSchema.safeParse("").success);
  assert.ok(flowCauseDetailSchema.safeParse("network").success);
  assert.ok(flowCauseDetailSchema.safeParse("unattributed").success);
  assert.deepEqual([Object.values(FlowCauseCategory).length], [10]);
  assert.deepEqual([Object.values(FlowCauseAssigner).length], [4]);
  assert.equal(
    new Set(Object.values(FlowCauseDetail)).size,
    Object.values(FlowCauseDetail).length,
  );
});

test("each validator answers its value or null for an unknown value", () => {
  assert.deepEqual([validRootEnd("lost")], ["lost"]);
  assert.equal(validRootEnd("gone"), null);
  assert.deepEqual([validRevokeCause("human")], ["human"]);
  assert.equal(validRevokeCause("gone"), null);
  assert.deepEqual([validTransitionTo("External.Failed")], ["External.Failed"]);
  assert.equal(validTransitionTo("Gone"), null);
  assert.deepEqual([validTransitionRule("plan_defect")], ["plan_defect"]);
  assert.equal(validTransitionRule("gone"), null);
  assert.deepEqual([validEvaluationStage("judgement")], ["judgement"]);
  assert.equal(validEvaluationStage("gone"), null);
  assert.deepEqual([validGateAffected("base_red")], ["base_red"]);
  assert.equal(validGateAffected("gone"), null);
  assert.deepEqual([validKind("steps")], ["steps"]);
  assert.deepEqual([validKind("")], [""]);
  assert.equal(validKind("gone"), null);
  assert.deepEqual([validStage("outcome")], ["outcome"]);
  assert.equal(validStage(""), null);
  assert.equal(validStage(7), null);
});

test("FlowStopReason holds the values of ExecutionStopReason plus lost", () => {
  assert.deepEqual(
    new Set(Object.values(FlowStopReason)),
    new Set([...Object.values(ExecutionStopReason), "lost"]),
  );
});

test("the retention and late constants hold their values", () => {
  assert.deepEqual([FLOW_HOUR_RETENTION_DAYS], [8]);
  assert.deepEqual([FLOW_DAY_RETENTION_DAYS], [64]);
  assert.deepEqual([FLOW_HOUR_RANGE_DAYS_MAX], [2]);
  assert.equal(LATE_RECORD_MS, HOUR_MS);
});
