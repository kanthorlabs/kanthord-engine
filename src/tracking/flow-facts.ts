import {
  CauseAssigner,
  causeAssignerSchema,
  CauseAttribute,
  CauseCategory,
  causeCategorySchema,
  causeSubcategorySchema,
} from "../kernel/cause.ts";
import { isNumber, isString } from "../kernel/values.ts";
import { CAUSE_LABEL_OPERATION } from "./cause-label.ts";
import {
  FlowGateAffected,
  FlowKind,
  FlowMeasure,
  FlowStage,
  ROOT_SPAN_OPERATION,
  type Span,
  TRANSITION_SPAN_OPERATION,
} from "./contract.ts";
import {
  validEvaluationStage,
  validGateAffected,
  validKind,
  validRevokeCause,
  validRootEnd,
  validTransitionRule,
  validTransitionTo,
} from "./flow-model.ts";

const RELEASE_GATE_OPERATION = "worker.release_gate";
const VERIFICATION_OPERATION = "worker.verification";
const EVALUATION_OPERATION = "worker.evaluation";
const TOOL_OPERATION = "agent.tool";
const TURN_OPERATION = "agent.turn";
const KIND_ATTRIBUTE = "kanthord.execution.kind";
const QUEUE_WAIT_ATTRIBUTE = "kanthord.queue.wait_ms";
const END_ATTRIBUTE = "kanthord.execution.end";
const REVOKE_CAUSE_ATTRIBUTE = "kanthord.revoke.cause";
const STATE_TO_ATTRIBUTE = "kanthord.node.state.to";
const TRANSITION_RULE_ATTRIBUTE = "kanthord.transition.rule";
const LEAD_TIME_ATTRIBUTE = "kanthord.node.lead_time_ms";
const GATE_RESULT_ATTRIBUTE = "kanthord.release_gate.result";
const GATE_AFFECTED_ATTRIBUTE = "kanthord.release_gate.affected";
const VERIFICATION_KIND_ATTRIBUTE = "kanthord.verification.kind";
const VERIFICATION_CONTEXT_ATTRIBUTE = "kanthord.verification.context";
const AFFECTED_VERDICT_ATTRIBUTE = "kanthord.affected.verdict";
const AFFECTED_FLAKY_COUNT_ATTRIBUTE = "kanthord.affected.flaky_count";
const EVALUATION_STAGE_ATTRIBUTE = "kanthord.evaluation.stage";
const ERROR_TYPE_ATTRIBUTE = "error.type";
const REQUEST_MODEL_ATTRIBUTE = "gen_ai.request.model";
const RESPONSE_MODEL_ATTRIBUTE = "gen_ai.response.model";
const INPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.output_tokens";
const CACHE_READ_TOKENS_ATTRIBUTE = "gen_ai.usage.cache_read.input_tokens";
const COST_ATTRIBUTE = "kanthord.usage.cost_usd";
const GATE_ROUTED = "routed";
const GATE_PASSED = "passed";
const AFFECTED_KIND = "affected";
const RELEASE_CONTEXT = "release";
const VERDICT_FAILED = "failed";
const VERDICT_BASE_RED = "base_red";
const TOOL_ERROR = "tool_error";
const STOPPED_ERROR = "stopped";
const RATE_LIMITED_ERROR = "rate_limited";
const QUOTA_EXHAUSTED_ERROR = "quota_exhausted";
const UNAVAILABLE_ERROR = "unavailable";
const NO_VALUE = "";
const NO_AMOUNT = 0;
const SINGLE = 1;
const FIRST_SUSPECT = 0;
const TURN_ERROR_COLUMNS: Readonly<Record<string, FlowCounterColumn>> = {
  [RATE_LIMITED_ERROR]: "turn_rate_limited",
  [QUOTA_EXHAUSTED_ERROR]: "turn_quota_exhausted",
  [UNAVAILABLE_ERROR]: "turn_unavailable",
};
const UNCOUNTED_TURN_ERRORS: ReadonlySet<string> = new Set([
  STOPPED_ERROR,
  TOOL_ERROR,
]);

export type FlowCounterColumn =
  | "tool_error_count"
  | "turn_rate_limited"
  | "turn_quota_exhausted"
  | "turn_unavailable"
  | "turn_error_other"
  | "gate_routed"
  | "affected_runs"
  | "affected_failed"
  | "affected_base_red"
  | "affected_flaky_runs"
  | "flaky_tests"
  | "late_records";

export interface FlowColumnSet {
  kind?: string;
  root_end?: string | null;
  revoke_cause?: string | null;
  transition_to?: string | null;
  transition_rule?: string | null;
  evaluation_stage?: string | null;
  gate_affected?: string | null;
}

type RootKind = typeof FlowKind.Steps | typeof FlowKind.Evaluation;

export interface FlowCause {
  cause_category: string;
  cause_detail: string;
  cause_assigner: string;
}

export interface FlowHistogramValue {
  measure: FlowMeasure;
  value: number;
}

export interface FlowUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface FlowFacts {
  set: FlowColumnSet;
  stage: FlowStage | null;
  cause: { value: FlowCause; unlessHuman: boolean } | null;
  counters: Partial<Record<FlowCounterColumn, number>>;
  histogram: FlowHistogramValue[];
  usage: FlowUsage | null;
}

interface SpanView {
  after: Span;
  firstAttribute(name: string): unknown;
  attribute(name: string): unknown;
  started: boolean;
  ended: boolean;
  durationMs: number | null;
}

type Handler = (facts: FlowFacts, view: SpanView) => void;

function closed<T>(
  valid: (value: unknown) => T | null,
  value: unknown,
): T | null | undefined {
  return value === undefined ? undefined : valid(value);
}

function setClosed(
  facts: FlowFacts,
  column: Exclude<keyof FlowColumnSet, "kind">,
  valid: (value: unknown) => string | null,
  value: unknown,
): void {
  const checked = closed(valid, value);
  if (checked !== undefined) facts.set[column] = checked;
}

function finiteNumber(value: unknown): number {
  return isNumber(value) && Number.isFinite(value) ? value : NO_AMOUNT;
}

function stageAtLeast(facts: FlowFacts, stage: FlowStage): void {
  const stages: readonly FlowStage[] = Object.values(FlowStage);
  const held = facts.stage === null ? -SINGLE : stages.indexOf(facts.stage);
  if (stages.indexOf(stage) > held) facts.stage = stage;
}

function count(
  facts: FlowFacts,
  column: FlowCounterColumn,
  amount: number = SINGLE,
): void {
  facts.counters[column] = (facts.counters[column] ?? NO_AMOUNT) + amount;
}

function kindOf(span: Span): RootKind | null {
  const kind = validKind(span.attributes[KIND_ATTRIBUTE]);
  if (kind === FlowKind.Steps || kind === FlowKind.Evaluation) return kind;
  return null;
}

function rootCauseOf(span: Span): FlowCause {
  const category = causeCategorySchema.safeParse(
    span.attributes[CauseAttribute.Category],
  );
  if (!category.success)
    return {
      cause_category: NO_VALUE,
      cause_detail: NO_VALUE,
      cause_assigner: NO_VALUE,
    };
  const subcategory = causeSubcategorySchema.safeParse(
    span.attributes[CauseAttribute.Subcategory],
  );
  const suspects = span.attributes[CauseAttribute.Suspects];
  const suspect =
    category.data === CauseCategory.Unattributed && Array.isArray(suspects)
      ? causeCategorySchema.safeParse(suspects[FIRST_SUSPECT])
      : null;
  const assigner = causeAssignerSchema.safeParse(
    span.attributes[CauseAttribute.Assigner],
  );
  return {
    cause_category: category.data,
    cause_detail: subcategory.success
      ? subcategory.data
      : (suspect?.data ?? NO_VALUE),
    cause_assigner: assigner.success ? assigner.data : NO_VALUE,
  };
}

function labelCauseOf(span: Span): FlowCause | null {
  const category = causeCategorySchema.safeParse(
    span.attributes[CauseAttribute.Category],
  );
  if (!category.success) return null;
  const subcategory = causeSubcategorySchema.safeParse(
    span.attributes[CauseAttribute.Subcategory],
  );
  return {
    cause_category: category.data,
    cause_detail: subcategory.success ? subcategory.data : NO_VALUE,
    cause_assigner: CauseAssigner.Human,
  };
}

function measureOf(
  kind: RootKind | null,
  steps: FlowMeasure,
  evaluation: FlowMeasure,
): FlowMeasure | null {
  if (kind === FlowKind.Steps) return steps;
  if (kind === FlowKind.Evaluation) return evaluation;
  return null;
}

function addHistogram(
  facts: FlowFacts,
  measure: FlowMeasure | null,
  value: number | null,
): void {
  if (measure === null || value === null) return;
  facts.histogram.push({ measure, value });
}

function rootStart(facts: FlowFacts, view: SpanView): void {
  const kind = kindOf(view.after);
  if (view.firstAttribute(KIND_ATTRIBUTE) !== undefined && kind !== null) {
    facts.set.kind = kind;
    stageAtLeast(
      facts,
      kind === FlowKind.Steps ? FlowStage.Executing : FlowStage.Evaluation,
    );
  }
  const wait = view.firstAttribute(QUEUE_WAIT_ATTRIBUTE);
  if (!isNumber(wait) || !Number.isSafeInteger(wait) || wait < NO_AMOUNT)
    return;
  addHistogram(
    facts,
    measureOf(kind, FlowMeasure.QueueWait, FlowMeasure.ReviewWait),
    wait,
  );
}

function rootEnd(facts: FlowFacts, view: SpanView): void {
  setClosed(facts, "root_end", validRootEnd, view.attribute(END_ATTRIBUTE));
  setClosed(
    facts,
    "revoke_cause",
    validRevokeCause,
    view.attribute(REVOKE_CAUSE_ATTRIBUTE),
  );
  facts.cause = { value: rootCauseOf(view.after), unlessHuman: true };
  addHistogram(
    facts,
    measureOf(
      kindOf(view.after),
      FlowMeasure.ExecutionTime,
      FlowMeasure.EvaluationTime,
    ),
    view.durationMs,
  );
}

function root(facts: FlowFacts, view: SpanView): void {
  rootStart(facts, view);
  if (view.ended) rootEnd(facts, view);
}

function causeLabel(facts: FlowFacts, view: SpanView): void {
  if (view.firstAttribute(CauseAttribute.Category) === undefined) return;
  const value = labelCauseOf(view.after);
  if (value !== null) facts.cause = { value, unlessHuman: false };
}

function transition(facts: FlowFacts, view: SpanView): void {
  setClosed(
    facts,
    "transition_to",
    validTransitionTo,
    view.firstAttribute(STATE_TO_ATTRIBUTE),
  );
  setClosed(
    facts,
    "transition_rule",
    validTransitionRule,
    view.firstAttribute(TRANSITION_RULE_ATTRIBUTE),
  );
  const leadTime = view.firstAttribute(LEAD_TIME_ATTRIBUTE);
  if (isNumber(leadTime) && Number.isFinite(leadTime))
    addHistogram(facts, FlowMeasure.LeadTime, leadTime);
}

function gateEnd(facts: FlowFacts, view: SpanView): void {
  const result = view.attribute(GATE_RESULT_ATTRIBUTE);
  if (result === GATE_ROUTED) count(facts, "gate_routed");
  if (result === GATE_PASSED) {
    stageAtLeast(facts, FlowStage.ReleaseGate);
    const affected = view.attribute(GATE_AFFECTED_ATTRIBUTE);
    facts.set.gate_affected =
      affected === undefined
        ? FlowGateAffected.Absent
        : validGateAffected(affected);
  }
  addHistogram(facts, FlowMeasure.GateRunTime, view.durationMs);
}

function releaseGate(facts: FlowFacts, view: SpanView): void {
  if (view.started) stageAtLeast(facts, FlowStage.Verification);
  if (view.ended) gateEnd(facts, view);
}

function verification(facts: FlowFacts, view: SpanView): void {
  if (!view.ended) return;
  if (
    view.attribute(VERIFICATION_KIND_ATTRIBUTE) !== AFFECTED_KIND ||
    view.attribute(VERIFICATION_CONTEXT_ATTRIBUTE) !== RELEASE_CONTEXT
  )
    return;
  count(facts, "affected_runs");
  addHistogram(facts, FlowMeasure.VerificationRunTime, view.durationMs);
  const verdict = view.attribute(AFFECTED_VERDICT_ATTRIBUTE);
  if (verdict === VERDICT_FAILED) count(facts, "affected_failed");
  if (verdict === VERDICT_BASE_RED) count(facts, "affected_base_red");
  const flaky = view.attribute(AFFECTED_FLAKY_COUNT_ATTRIBUTE);
  if (!isNumber(flaky) || !(flaky > NO_AMOUNT)) return;
  count(facts, "affected_flaky_runs");
  count(facts, "flaky_tests", flaky);
}

function evaluation(facts: FlowFacts, view: SpanView): void {
  if (!view.ended) return;
  setClosed(
    facts,
    "evaluation_stage",
    validEvaluationStage,
    view.attribute(EVALUATION_STAGE_ATTRIBUTE),
  );
}

function tool(facts: FlowFacts, view: SpanView): void {
  if (view.ended && view.attribute(ERROR_TYPE_ATTRIBUTE) === TOOL_ERROR)
    count(facts, "tool_error_count");
}

function usageOf(span: Span): FlowUsage {
  const model =
    [
      span.attributes[RESPONSE_MODEL_ATTRIBUTE],
      span.attributes[REQUEST_MODEL_ATTRIBUTE],
    ].find(isString) ?? NO_VALUE;
  return {
    model,
    input_tokens: finiteNumber(span.attributes[INPUT_TOKENS_ATTRIBUTE]),
    output_tokens: finiteNumber(span.attributes[OUTPUT_TOKENS_ATTRIBUTE]),
    cache_read_tokens: finiteNumber(
      span.attributes[CACHE_READ_TOKENS_ATTRIBUTE],
    ),
    cost_usd: finiteNumber(span.attributes[COST_ATTRIBUTE]),
  };
}

function turn(facts: FlowFacts, view: SpanView): void {
  if (!view.ended) return;
  facts.usage = usageOf(view.after);
  const errorType = view.attribute(ERROR_TYPE_ATTRIBUTE);
  if (!isString(errorType)) return;
  const column = TURN_ERROR_COLUMNS[errorType];
  if (column !== undefined) return count(facts, column);
  if (!UNCOUNTED_TURN_ERRORS.has(errorType)) count(facts, "turn_error_other");
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  [TRANSITION_SPAN_OPERATION]: transition,
  [CAUSE_LABEL_OPERATION]: causeLabel,
  [RELEASE_GATE_OPERATION]: releaseGate,
  [VERIFICATION_OPERATION]: verification,
  [EVALUATION_OPERATION]: evaluation,
  [TOOL_OPERATION]: tool,
  [TURN_OPERATION]: turn,
};

function viewOf(before: Span | null, after: Span): SpanView {
  const held = (name: string) => before?.attributes[name] !== undefined;
  return {
    after,
    firstAttribute: (name) => (held(name) ? undefined : after.attributes[name]),
    attribute: (name) => after.attributes[name],
    started: (before?.start_time ?? null) === null && after.start_time !== null,
    ended: (before?.end_time ?? null) === null && after.end_time !== null,
    durationMs:
      after.start_time === null || after.end_time === null
        ? null
        : after.end_time - after.start_time,
  };
}

export function flowFactsOf(
  rootSpanId: string,
  before: Span | null,
  after: Span,
): FlowFacts {
  const facts: FlowFacts = {
    set: {},
    stage: null,
    cause: null,
    counters: {},
    histogram: [],
    usage: null,
  };
  const view = viewOf(before, after);
  const isRoot =
    after.span_id === rootSpanId && after.operation === ROOT_SPAN_OPERATION;
  const handler = isRoot ? root : HANDLERS[after.operation];
  handler?.(facts, view);
  return facts;
}
