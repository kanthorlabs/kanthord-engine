import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptOrigin, PromptPart } from "../agent/contract.ts";
import type { PromptPartAnswer } from "../agent/contract.ts";
import { digest } from "../agent/prompt-composer.ts";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { SpanStatus, type ExecutionTrace } from "../tracking/contract.ts";
import {
  AgentPromptSpan,
  agentPromptContribution,
  agentPromptFacts,
  agentPromptSpanId,
} from "./prompt-telemetry.ts";

const EXECUTION_ID = "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const SPAN_ID_PATTERN = /^[a-f0-9]{16}$/;
const AT = 1_700_000_000_000;
const FIRST_AGENT = "swe@1";
const SECOND_AGENT = "re@1";

function partOf(
  part: PromptPart,
  name: string,
  partDigest: string,
): PromptPartAnswer {
  return {
    part,
    name,
    origin: PromptOrigin.File,
    path: null,
    digest: partDigest,
    text: "text",
  };
}

const TRACE: ExecutionTrace = {
  execution_id: EXECUTION_ID,
  project_id: "project_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  node_id: "node_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  attempt: 1,
  trace_id: "a".repeat(32),
  root_span_id: "b".repeat(16),
};

test("facts keep the reading order and the part name digest form", () => {
  const facts = agentPromptFacts(
    FIRST_AGENT,
    [
      partOf(PromptPart.Standard, "base.md", "d1"),
      partOf(PromptPart.Role, "swe@1.md", "d2"),
      partOf(PromptPart.Binding, "api", "d3"),
    ],
    SHIPPED_TEMPLATES,
  );
  assert.equal(facts.agent_name, FIRST_AGENT);
  assert.deepEqual(facts.parts, [
    "standard:base.md:d1",
    "role:swe@1.md:d2",
    "binding:api:d3",
  ]);
  assert.equal(
    facts.templates_digest,
    digest(canonicalJSON(SHIPPED_TEMPLATES)),
  );
});

test("span id is stable for one execution and one agent and differs for two agents", () => {
  const first = agentPromptSpanId(EXECUTION_ID, FIRST_AGENT);
  assert.match(first, SPAN_ID_PATTERN);
  assert.equal(first, agentPromptSpanId(EXECUTION_ID, FIRST_AGENT));
  assert.notEqual(first, agentPromptSpanId(EXECUTION_ID, SECOND_AGENT));
});

test("contribution sits under the root span and holds the three attributes", () => {
  const facts = agentPromptFacts(
    FIRST_AGENT,
    [partOf(PromptPart.Role, "swe@1.md", "d2")],
    SHIPPED_TEMPLATES,
  );
  const contribution = agentPromptContribution(TRACE, facts, AT);
  const spanId = agentPromptSpanId(EXECUTION_ID, FIRST_AGENT);
  assert.equal(contribution.record_id, `${spanId}:prompt`);
  assert.equal(contribution.span_id, spanId);
  assert.equal(contribution.parent_span_id, TRACE.root_span_id);
  assert.equal(contribution.operation, AgentPromptSpan.Operation);
  assert.equal(contribution.start_time, AT);
  assert.equal(contribution.end_time, AT);
  assert.equal(contribution.status, SpanStatus.Ok);
  assert.deepEqual(contribution.attributes, {
    [AgentPromptSpan.AgentName]: FIRST_AGENT,
    [AgentPromptSpan.Parts]: ["role:swe@1.md:d2"],
    [AgentPromptSpan.TemplatesDigest]: facts.templates_digest,
  });
});
