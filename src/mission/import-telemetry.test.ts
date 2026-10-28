import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLECTION_MAX, SpanStatus } from "../tracking/contract.ts";
import {
  IMPORT_OPERATION,
  ImportAttribute,
  type ImportFacts,
  importTrace,
} from "./import-telemetry.ts";

const APPLIED_AT = 700;
const ERROR_TYPE = "mission.import.cycle";
const EXTRA_CODES = 10;
const FACTS: ImportFacts = {
  project_id: "project_1",
  mission_id: "mission_1",
  version_from: 3,
  version_to: 4,
  creates: 2,
  updates: 1,
  retirements: 1,
  removed_edges: 5,
  actor_account: "account_1",
  reason: "Replan the work.",
  violation_codes: [],
  error_type: null,
  applied_at: APPLIED_AT,
};

test("importTrace answers the root span with the attributes of an Ok trace", () => {
  const { trace, contribution } = importTrace(FACTS);
  assert.match(trace.trace_id, /^[0-9a-f]{32}$/);
  assert.match(trace.root_span_id, /^[0-9a-f]{16}$/);
  assert.equal(trace.project_id, FACTS.project_id);
  assert.equal(trace.node_id, null);
  assert.equal(trace.attempt, null);
  assert.equal(trace.created_at, APPLIED_AT);
  assert.equal(contribution.record_id, `${trace.root_span_id}:end`);
  assert.equal(contribution.span_id, trace.root_span_id);
  assert.equal(contribution.parent_span_id, null);
  assert.equal(contribution.operation, IMPORT_OPERATION);
  assert.equal(contribution.start_time, APPLIED_AT);
  assert.equal(contribution.end_time, APPLIED_AT);
  assert.equal(contribution.status, SpanStatus.Ok);
  assert.deepEqual(contribution.attributes, {
    "kanthord.project.id": "project_1",
    "kanthord.mission.id": "mission_1",
    "kanthord.mission.version.from": 3,
    "kanthord.mission.version.to": 4,
    "kanthord.import.creates": 2,
    "kanthord.import.updates": 1,
    "kanthord.import.retirements": 1,
    "kanthord.import.removed_edges": 5,
    "kanthord.human.username": "account_1",
  });
});

test("importTrace answers an Error trace with sorted distinct violation codes", () => {
  const { contribution } = importTrace({
    ...FACTS,
    error_type: ERROR_TYPE,
    violation_codes: ["b.code", "a.code", "b.code"],
  });
  assert.equal(contribution.status, SpanStatus.Error);
  assert.equal(contribution.attributes[ImportAttribute.ErrorType], ERROR_TYPE);
  assert.deepEqual(contribution.attributes[ImportAttribute.ViolationCodes], [
    "a.code",
    "b.code",
  ]);
});

test("importTrace cuts the violation codes at 128", () => {
  const codes = Array.from(
    { length: COLLECTION_MAX + EXTRA_CODES },
    (_, index) => `code.${String(index).padStart(4, "0")}`,
  );
  const { contribution } = importTrace({
    ...FACTS,
    error_type: ERROR_TYPE,
    violation_codes: codes,
  });
  assert.deepEqual(
    contribution.attributes[ImportAttribute.ViolationCodes],
    codes.slice(0, COLLECTION_MAX),
  );
});

test("importTrace stores the reason as a text of the root span", () => {
  const { trace, contribution } = importTrace(FACTS);
  const textId = `${trace.root_span_id}:reason`;
  assert.deepEqual(contribution.text_ids, [textId]);
  assert.deepEqual(contribution.texts, [
    { text_id: textId, text: "Replan the work." },
  ]);
  assert.equal(
    JSON.stringify(contribution.attributes).includes("Replan the work."),
    false,
  );
});
