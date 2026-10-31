import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CauseAssigner,
  CauseAttribute,
  CauseCategory,
  CauseSubcategory,
} from "../kernel/cause.ts";
import {
  type Attributes,
  ExecutionEnd,
  FlowEvaluationStage,
  FlowGateAffected,
  FlowKind,
  FlowMeasure,
  FlowStage,
  RevokeCause,
  ROOT_SPAN_OPERATION,
  type Span,
  SpanOrigin,
  SpanStatus,
  TRANSITION_SPAN_OPERATION,
  TransitionRule,
} from "./contract.ts";
import { CAUSE_LABEL_OPERATION } from "./cause-label.ts";
import { flowFactsOf } from "./flow-facts.ts";
import { applyFlowFacts, type FlowColumns } from "./flow-trace.ts";

const ROOT = "1".repeat(16);
const CHILD = "2".repeat(16);
const START = 1000;
const END = 5000;

function spanOf(
  operation: string,
  attributes: Attributes,
  times: { start?: number | null; end?: number | null } = {},
  spanId = CHILD,
): Span {
  return {
    trace_id: "a".repeat(32),
    span_id: spanId,
    parent_span_id: spanId === ROOT ? null : ROOT,
    producer: "scheduler",
    origin: SpanOrigin.Observed,
    operation,
    start_time: times.start ?? null,
    end_time: times.end ?? null,
    status: SpanStatus.Ok,
    attributes,
    events: [],
    links: [],
    text_ids: [],
    created_at: START,
  };
}

function rootOf(attributes: Attributes, times = { start: START }): Span {
  return spanOf(ROOT_SPAN_OPERATION, attributes, times, ROOT);
}

const NO_FACTS = {
  set: {},
  stage: null,
  cause: null,
  counters: {},
  histogram: [],
  usage: null,
};

function emptyColumns(): FlowColumns {
  return {
    kind: FlowKind.None,
    stage: null,
    root_end: null,
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
  };
}

test("a root start with the kind steps sets the kind, the stage and the queue wait", () => {
  const after = rootOf({
    "kanthord.execution.kind": "steps",
    "kanthord.queue.wait_ms": 250,
  });
  const facts = flowFactsOf(ROOT, null, after);
  assert.deepEqual(facts.set, { kind: FlowKind.Steps });
  assert.equal(facts.stage, FlowStage.Executing);
  assert.deepEqual(facts.histogram, [
    { measure: FlowMeasure.QueueWait, value: 250 },
  ]);
});

test("a root start with the kind evaluation sets the evaluation stage and the review wait", () => {
  const after = rootOf({
    "kanthord.execution.kind": "evaluation",
    "kanthord.queue.wait_ms": 0,
  });
  const facts = flowFactsOf(ROOT, null, after);
  assert.deepEqual(facts.set, { kind: FlowKind.Evaluation });
  assert.equal(facts.stage, FlowStage.Evaluation);
  assert.deepEqual(facts.histogram, [
    { measure: FlowMeasure.ReviewWait, value: 0 },
  ]);
});

test("a second record of the same root span adds nothing", () => {
  const first = rootOf({
    "kanthord.execution.kind": "steps",
    "kanthord.queue.wait_ms": 250,
  });
  const second = { ...first, status: SpanStatus.Error };
  assert.deepEqual(flowFactsOf(ROOT, first, second), NO_FACTS);
  const ended = rootOf(
    { ...first.attributes, "kanthord.execution.end": "finished" },
    { start: START },
  );
  const endedTwice = { ...ended, end_time: END };
  const afterEnd = flowFactsOf(ROOT, endedTwice, { ...endedTwice });
  assert.deepEqual(afterEnd, NO_FACTS);
});

test("a queue wait that is not a safe integer of 0 or more gives no value", () => {
  for (const wait of [-1, 1.5, Number.NaN, "7"]) {
    const facts = flowFactsOf(
      ROOT,
      null,
      rootOf({
        "kanthord.execution.kind": "steps",
        "kanthord.queue.wait_ms": wait,
      }),
    );
    assert.deepEqual(facts.histogram, []);
  }
});

test("an unknown kind adds no kind and no stage", () => {
  const facts = flowFactsOf(
    ROOT,
    null,
    rootOf({ "kanthord.execution.kind": "other" }),
  );
  assert.deepEqual(facts, NO_FACTS);
});

test("a root end sets the end, the revoke cause, the cause and the duration", () => {
  const before = rootOf({ "kanthord.execution.kind": "steps" });
  const after = {
    ...before,
    end_time: END,
    attributes: {
      ...before.attributes,
      "kanthord.execution.end": ExecutionEnd.Revoked,
      "kanthord.revoke.cause": RevokeCause.Human,
      [CauseAttribute.Category]: CauseCategory.Model,
      [CauseAttribute.Subcategory]: CauseSubcategory.NoProgress,
      [CauseAttribute.Assigner]: CauseAssigner.Rule,
    },
  };
  const facts = flowFactsOf(ROOT, before, after);
  assert.deepEqual(facts.set, {
    root_end: ExecutionEnd.Revoked,
    revoke_cause: RevokeCause.Human,
  });
  assert.deepEqual(facts.cause, {
    value: {
      cause_category: CauseCategory.Model,
      cause_detail: CauseSubcategory.NoProgress,
      cause_assigner: CauseAssigner.Rule,
    },
    unlessHuman: true,
  });
  assert.deepEqual(facts.histogram, [
    { measure: FlowMeasure.ExecutionTime, value: END - START },
  ]);
});

test("an evaluation root end gives the evaluation time", () => {
  const before = rootOf({ "kanthord.execution.kind": "evaluation" });
  const after = {
    ...before,
    end_time: END,
    attributes: {
      ...before.attributes,
      "kanthord.execution.end": ExecutionEnd.Finished,
    },
  };
  assert.deepEqual(flowFactsOf(ROOT, before, after).histogram, [
    { measure: FlowMeasure.EvaluationTime, value: END - START },
  ]);
});

test("an unattributed root cause takes its first suspect as detail", () => {
  const before = rootOf({});
  const after = {
    ...before,
    end_time: END,
    attributes: {
      "kanthord.execution.end": ExecutionEnd.Finished,
      [CauseAttribute.Category]: CauseCategory.Unattributed,
      [CauseAttribute.Assigner]: CauseAssigner.Rule,
      [CauseAttribute.Suspects]: [CauseCategory.Plan, CauseCategory.Prompt],
    },
  };
  assert.deepEqual(flowFactsOf(ROOT, before, after).cause?.value, {
    cause_category: CauseCategory.Unattributed,
    cause_detail: CauseCategory.Plan,
    cause_assigner: CauseAssigner.Rule,
  });
});

test("a root end with no cause category holds an empty cause", () => {
  const before = rootOf({});
  const after = {
    ...before,
    end_time: END,
    attributes: {
      "kanthord.execution.end": ExecutionEnd.Finished,
      [CauseAttribute.Subcategory]: CauseSubcategory.NoProgress,
    },
  };
  assert.deepEqual(flowFactsOf(ROOT, before, after).cause?.value, {
    cause_category: "",
    cause_detail: "",
    cause_assigner: "",
  });
});

test("a root end with an unknown end stores null", () => {
  const before = rootOf({});
  const after = {
    ...before,
    end_time: END,
    attributes: {
      "kanthord.execution.end": "gone",
      "kanthord.revoke.cause": "gone",
    },
  };
  assert.deepEqual(flowFactsOf(ROOT, before, after).set, {
    root_end: null,
    revoke_cause: null,
  });
});

test("a cause label sets the category, the detail and the human assigner", () => {
  const after = spanOf(
    CAUSE_LABEL_OPERATION,
    {
      [CauseAttribute.Category]: CauseCategory.Plan,
      [CauseAttribute.Subcategory]: CauseSubcategory.Oversized,
    },
    { start: END, end: END },
  );
  assert.deepEqual(flowFactsOf(ROOT, null, after).cause, {
    value: {
      cause_category: CauseCategory.Plan,
      cause_detail: CauseSubcategory.Oversized,
      cause_assigner: CauseAssigner.Human,
    },
    unlessHuman: false,
  });
  assert.deepEqual(flowFactsOf(ROOT, after, { ...after }), NO_FACTS);
});

test("a transition span sets the target, the rule and the lead time", () => {
  const after = spanOf(
    TRANSITION_SPAN_OPERATION,
    {
      "kanthord.node.state.to": "Waiting",
      "kanthord.transition.rule": TransitionRule.None,
      "kanthord.node.lead_time_ms": 9000,
    },
    { start: END, end: END },
  );
  const facts = flowFactsOf(ROOT, null, after);
  assert.deepEqual(facts.set, {
    transition_to: "Waiting",
    transition_rule: TransitionRule.None,
  });
  assert.deepEqual(facts.histogram, [
    { measure: FlowMeasure.LeadTime, value: 9000 },
  ]);
  assert.deepEqual(flowFactsOf(ROOT, after, { ...after }), NO_FACTS);
});

test("a transition span with unknown values stores null and has no lead time", () => {
  const after = spanOf(
    TRANSITION_SPAN_OPERATION,
    { "kanthord.node.state.to": "Gone", "kanthord.transition.rule": "gone" },
    { start: END, end: END },
  );
  const facts = flowFactsOf(ROOT, null, after);
  assert.deepEqual(facts.set, { transition_to: null, transition_rule: null });
  assert.deepEqual(facts.histogram, []);
});

test("a release gate start raises the stage to verification once", () => {
  const started = spanOf("worker.release_gate", {}, { start: START });
  const facts = flowFactsOf(ROOT, null, started);
  assert.equal(facts.stage, FlowStage.Verification);
  assert.deepEqual(flowFactsOf(ROOT, started, { ...started }), NO_FACTS);
});

test("a passed release gate end sets the stage, the affected value and the duration", () => {
  const started = spanOf("worker.release_gate", {}, { start: START });
  const ended = {
    ...started,
    end_time: END,
    attributes: {
      "kanthord.release_gate.result": "passed",
      "kanthord.release_gate.affected": FlowGateAffected.BaseRed,
    },
  };
  const facts = flowFactsOf(ROOT, started, ended);
  assert.equal(facts.stage, FlowStage.ReleaseGate);
  assert.deepEqual(facts.set, { gate_affected: FlowGateAffected.BaseRed });
  assert.deepEqual(facts.histogram, [
    { measure: FlowMeasure.GateRunTime, value: END - START },
  ]);
});

test("a passed release gate with no affected attribute is absent", () => {
  const ended = spanOf(
    "worker.release_gate",
    { "kanthord.release_gate.result": "passed" },
    { start: START, end: END },
  );
  const facts = flowFactsOf(ROOT, null, ended);
  assert.deepEqual(facts.set, { gate_affected: FlowGateAffected.Absent });
  assert.equal(facts.stage, FlowStage.ReleaseGate);
});

test("a passed release gate with an unknown affected value stores null", () => {
  const ended = spanOf(
    "worker.release_gate",
    {
      "kanthord.release_gate.result": "passed",
      "kanthord.release_gate.affected": "gone",
    },
    { start: START, end: END },
  );
  assert.deepEqual(flowFactsOf(ROOT, null, ended).set, { gate_affected: null });
});

test("a routed release gate counts once and keeps the stage", () => {
  const ended = spanOf(
    "worker.release_gate",
    { "kanthord.release_gate.result": "routed" },
    { start: START, end: END },
  );
  const facts = flowFactsOf(ROOT, null, ended);
  assert.deepEqual(facts.counters, { gate_routed: 1 });
  assert.equal(facts.stage, FlowStage.Verification);
  assert.deepEqual(facts.set, {});
});

test("an affected release verification adds its run, its verdict, its flaky count and its duration", () => {
  const started = spanOf(
    "worker.verification",
    {
      "kanthord.verification.kind": "affected",
      "kanthord.verification.context": "release",
    },
    { start: START },
  );
  const ended = {
    ...started,
    end_time: END,
    attributes: {
      ...started.attributes,
      "kanthord.affected.verdict": "failed",
      "kanthord.affected.flaky_count": 3,
    },
  };
  const facts = flowFactsOf(ROOT, started, ended);
  assert.deepEqual(facts.counters, {
    affected_runs: 1,
    affected_failed: 1,
    affected_flaky_runs: 1,
    flaky_tests: 3,
  });
  assert.deepEqual(facts.histogram, [
    { measure: FlowMeasure.VerificationRunTime, value: END - START },
  ]);
  assert.deepEqual(flowFactsOf(ROOT, ended, { ...ended }), NO_FACTS);
});

test("a base red verdict counts and a zero flaky count does not", () => {
  const ended = spanOf(
    "worker.verification",
    {
      "kanthord.verification.kind": "affected",
      "kanthord.verification.context": "release",
      "kanthord.affected.verdict": "base_red",
      "kanthord.affected.flaky_count": 0,
    },
    { start: START, end: END },
  );
  assert.deepEqual(flowFactsOf(ROOT, null, ended).counters, {
    affected_runs: 1,
    affected_base_red: 1,
  });
});

test("a verification of another kind or context adds nothing", () => {
  for (const attributes of [
    {
      "kanthord.verification.kind": "command",
      "kanthord.verification.context": "release",
    },
    {
      "kanthord.verification.kind": "affected",
      "kanthord.verification.context": "step",
    },
  ])
    assert.deepEqual(
      flowFactsOf(
        ROOT,
        null,
        spanOf("worker.verification", attributes, { start: START, end: END }),
      ),
      NO_FACTS,
    );
});

test("an evaluation span end sets the evaluation stage and an unknown value stores null", () => {
  const known = spanOf(
    "worker.evaluation",
    { "kanthord.evaluation.stage": FlowEvaluationStage.Affected },
    { start: START, end: END },
  );
  assert.deepEqual(flowFactsOf(ROOT, null, known).set, {
    evaluation_stage: FlowEvaluationStage.Affected,
  });
  const unknown = spanOf(
    "worker.evaluation",
    { "kanthord.evaluation.stage": "gone" },
    { start: START, end: END },
  );
  assert.deepEqual(flowFactsOf(ROOT, null, unknown).set, {
    evaluation_stage: null,
  });
  const absent = spanOf("worker.evaluation", {}, { start: START, end: END });
  assert.deepEqual(flowFactsOf(ROOT, null, absent), NO_FACTS);
});

test("a tool span end with a tool error counts once", () => {
  const started = spanOf("agent.tool", {}, { start: START });
  const ended = {
    ...started,
    end_time: END,
    attributes: { "error.type": "tool_error" },
  };
  assert.deepEqual(flowFactsOf(ROOT, started, ended).counters, {
    tool_error_count: 1,
  });
  assert.deepEqual(flowFactsOf(ROOT, ended, { ...ended }), NO_FACTS);
  const clean = spanOf("agent.tool", {}, { start: START, end: END });
  assert.deepEqual(flowFactsOf(ROOT, null, clean), NO_FACTS);
});

test("a turn span end counts its error type", () => {
  const counted = (errorType: string) =>
    flowFactsOf(
      ROOT,
      null,
      spanOf(
        "agent.turn",
        { "error.type": errorType },
        { start: START, end: END },
      ),
    ).counters;
  assert.deepEqual(counted("rate_limited"), { turn_rate_limited: 1 });
  assert.deepEqual(counted("quota_exhausted"), { turn_quota_exhausted: 1 });
  assert.deepEqual(counted("unavailable"), { turn_unavailable: 1 });
  assert.deepEqual(counted("overloaded"), { turn_error_other: 1 });
  assert.deepEqual(counted("stopped"), {});
  assert.deepEqual(counted("tool_error"), {});
});

test("a turn span end answers its usage and a started turn answers none", () => {
  const started = spanOf("agent.turn", {}, { start: START });
  assert.equal(flowFactsOf(ROOT, null, started).usage, null);
  const ended = {
    ...started,
    end_time: END,
    attributes: {
      "gen_ai.request.model": "request-model",
      "gen_ai.response.model": "response-model",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 60,
      "kanthord.usage.cost_usd": 0.5,
    },
  };
  assert.deepEqual(flowFactsOf(ROOT, started, ended).usage, {
    model: "response-model",
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 60,
    cost_usd: 0.5,
  });
  assert.equal(flowFactsOf(ROOT, ended, { ...ended }).usage, null);
});

test("a turn usage uses the request model, then an empty model, and counts a non finite value as 0", () => {
  const ended = spanOf(
    "agent.turn",
    {
      "gen_ai.request.model": "request-model",
      "gen_ai.usage.input_tokens": Number.POSITIVE_INFINITY,
      "gen_ai.usage.output_tokens": "7",
    },
    { start: START, end: END },
  );
  assert.deepEqual(flowFactsOf(ROOT, null, ended).usage, {
    model: "request-model",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
  });
  const bare = spanOf("agent.turn", {}, { start: START, end: END });
  assert.deepEqual([flowFactsOf(ROOT, null, bare).usage?.model], [""]);
});

test("a span of another operation adds nothing", () => {
  const other = spanOf("other.operation", {}, { start: START, end: END });
  assert.deepEqual(flowFactsOf(ROOT, null, other), NO_FACTS);
});

test("a scheduler execution span that is not the root adds nothing", () => {
  const other = spanOf(
    ROOT_SPAN_OPERATION,
    { "kanthord.execution.kind": "steps" },
    { start: START },
  );
  assert.deepEqual(flowFactsOf(ROOT, null, other), NO_FACTS);
});

test("a stage never moves back", () => {
  const gate = spanOf("worker.release_gate", {}, { start: START });
  const atGate = applyFlowFacts(
    { ...emptyColumns(), stage: FlowStage.Outcome },
    flowFactsOf(ROOT, null, gate),
  );
  assert.equal(atGate.stage, FlowStage.Outcome);
  const rising = applyFlowFacts(
    { ...emptyColumns(), stage: FlowStage.Executing },
    flowFactsOf(ROOT, null, gate),
  );
  assert.equal(rising.stage, FlowStage.Verification);
  const first = applyFlowFacts(emptyColumns(), flowFactsOf(ROOT, null, gate));
  assert.equal(first.stage, FlowStage.Verification);
});

test("a root cause never replaces a human cause and a label does", () => {
  const rootEnded = {
    ...rootOf({}),
    end_time: END,
    attributes: {
      "kanthord.execution.end": ExecutionEnd.Finished,
      [CauseAttribute.Category]: CauseCategory.Model,
      [CauseAttribute.Subcategory]: CauseSubcategory.NoProgress,
      [CauseAttribute.Assigner]: CauseAssigner.Rule,
    },
  };
  const human = {
    ...emptyColumns(),
    cause_category: CauseCategory.Plan,
    cause_detail: CauseSubcategory.Oversized,
    cause_assigner: CauseAssigner.Human,
  };
  const kept = applyFlowFacts(human, flowFactsOf(ROOT, rootOf({}), rootEnded));
  assert.equal(kept.cause_category, CauseCategory.Plan);
  const taken = applyFlowFacts(
    emptyColumns(),
    flowFactsOf(ROOT, rootOf({}), rootEnded),
  );
  assert.equal(taken.cause_category, CauseCategory.Model);
  const label = spanOf(
    CAUSE_LABEL_OPERATION,
    {
      [CauseAttribute.Category]: CauseCategory.Environment,
      [CauseAttribute.Subcategory]: CauseSubcategory.SetupFailed,
    },
    { start: END, end: END },
  );
  const labelled = applyFlowFacts(taken, flowFactsOf(ROOT, null, label));
  assert.deepEqual(
    [labelled.cause_category, labelled.cause_detail, labelled.cause_assigner],
    [CauseCategory.Environment, CauseSubcategory.SetupFailed, "human"],
  );
});
