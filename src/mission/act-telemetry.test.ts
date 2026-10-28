import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExecutionTrace, SpanStatus } from "../tracking/contract.ts";
import {
  Act,
  ActAttribute,
  type ActFacts,
  actSchema,
  actTrace,
} from "./act-telemetry.ts";

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
const NINE_ACTS = 9;
const EVIDENCE_ID = "evidence_1";
const LEAD_TIME_MS = 460;

test("the acts are the closed set of nine operations", () => {
  assert.equal(Object.keys(Act).length, NINE_ACTS);
  assert.equal(new Set(Object.values(Act)).size, NINE_ACTS);
});

test("actSchema accepts each act and refuses another operation", () => {
  for (const act of Object.values(Act)) assert.equal(actSchema.parse(act), act);
  assert.equal(actSchema.safeParse("mission.node.create").success, false);
});

test("actTrace answers the trace with the project, the node, the attempt and the act time", () => {
  const { trace } = actTrace(Act.Pause, FACTS);
  assert.match(trace.trace_id, /^[0-9a-f]{32}$/);
  assert.match(trace.root_span_id, /^[0-9a-f]{16}$/);
  assert.equal(trace.project_id, FACTS.project_id);
  assert.equal(trace.node_id, FACTS.node_id);
  assert.equal(trace.attempt, FACTS.attempt);
  assert.equal(trace.created_at, ACTED_AT);
});

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

test("actTrace answers no text without a reason", () => {
  const { contribution } = actTrace(Act.Unblock, { ...FACTS, reason: null });
  assert.equal(contribution.text_ids, undefined);
  assert.equal(contribution.texts, undefined);
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

test("actTrace names no state before when the act creates the node", () => {
  const { contribution } = actTrace(Act.ApproveProposal, {
    ...FACTS,
    from: null,
  });
  assert.equal(ActAttribute.StateFrom in contribution.attributes, false);
  assert.equal(contribution.attributes[ActAttribute.StateTo], FACTS.to);
});

test("actTrace names the evidence of an evidence delete", () => {
  const { contribution } = actTrace(Act.DeleteEvidence, {
    ...FACTS,
    evidence_id: EVIDENCE_ID,
  });
  assert.equal(contribution.attributes[ActAttribute.EvidenceId], EVIDENCE_ID);
});
