import assert from "node:assert/strict";
import { test } from "node:test";
import { CauseAssigner, CauseCategory } from "../kernel/cause.ts";
import { NodeState } from "../mission/contract.ts";
import { ExecutionStopReason } from "../scheduler/contract.ts";
import {
  ExecutionEnd,
  FlowEvaluationStage,
  FlowExit,
  FlowGateAffected,
  FlowKind,
  FlowStage,
  FlowStopReason,
  TransitionRule,
} from "./contract.ts";
import {
  bucketsOf,
  contributionOf,
  exitOf,
  FlowStageKey,
  type FlowTrace,
  StopReasonKey,
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
