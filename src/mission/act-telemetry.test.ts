import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExecutionTrace, SpanStatus } from "../tracking/contract.ts";
import { Act, ActAttribute, type ActFacts, actTrace } from "./act-telemetry.ts";

const REVOKED: ExecutionTrace = {
  execution_id: "execution_1",
  project_id: "project_1",
  node_id: "node_1",
  attempt: 2,
  trace_id: "a".repeat(32),
  root_span_id: "b".repeat(16),
};
const ACTED_AT = 500;
const MISSION_VERSION = 7;
const FACTS: ActFacts = {
  project_id: "project_1",
  node_id: "node_1",
  attempt: 2,
  acted_at: ACTED_AT,
  mission_version: MISSION_VERSION,
  from: "Executing",
  to: "Paused",
  reason: "Stop for review.",
  revoked: null,
  evidence_id: null,
  lead_time_ms: null,
};
const LEAD_TIME_MS = 460;

test("actTrace answers a root contribution that starts and ends at the act time", () => {
  const { trace, contribution } = actTrace(Act.Pause, FACTS);
  assert.equal(contribution.span_id, trace.root_span_id);
  assert.equal(contribution.parent_span_id, null);
  assert.equal(contribution.operation, Act.Pause);
  assert.equal(contribution.status, SpanStatus.Ok);
  assert.equal(contribution.start_time, ACTED_AT);
  assert.equal(contribution.end_time, ACTED_AT);
  assert.equal(contribution.record_id, `${trace.root_span_id}:end`);
  assert.deepEqual(contribution.attributes, {
    [ActAttribute.ProjectId]: "project_1",
    [ActAttribute.NodeId]: "node_1",
    [ActAttribute.Attempt]: 2,
    [ActAttribute.StateFrom]: "Executing",
    [ActAttribute.StateTo]: "Paused",
    [ActAttribute.MissionVersion]: MISSION_VERSION,
  });
  assert.equal(contribution.links, undefined);
});

test("actTrace stores the reason as a text of the root span", () => {
  const { trace, contribution } = actTrace(Act.Pause, FACTS);
  const textId = `${trace.root_span_id}:reason`;
  assert.deepEqual(contribution.text_ids, [textId]);
  assert.deepEqual(contribution.texts, [
    { text_id: textId, text: "Stop for review." },
  ]);
  assert.equal(
    JSON.stringify(contribution.attributes).includes("Stop for review."),
    false,
  );
});

test("actTrace links the root span of a revoked execution", () => {
  const { contribution } = actTrace(Act.Pause, { ...FACTS, revoked: REVOKED });
  assert.deepEqual(contribution.links, [
    { trace_id: REVOKED.trace_id, span_id: REVOKED.root_span_id },
  ]);
});

test("actTrace writes the lead time only when the facts hold it", () => {
  const { contribution } = actTrace(Act.Override, {
    ...FACTS,
    lead_time_ms: LEAD_TIME_MS,
  });
  assert.equal(contribution.attributes[ActAttribute.LeadTimeMs], LEAD_TIME_MS);
  assert.equal(
    ActAttribute.LeadTimeMs in
      actTrace(Act.Pause, FACTS).contribution.attributes,
    false,
  );
});

test("actTrace names no attempt before the first attempt opens", () => {
  const { trace, contribution } = actTrace(Act.Ready, {
    ...FACTS,
    attempt: 0,
  });
  assert.equal(trace.attempt, null);
  assert.equal(ActAttribute.Attempt in contribution.attributes, false);
});
