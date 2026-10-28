import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PromptPartAnswer, PromptTemplates } from "../agent/contract.ts";
import { digest } from "../agent/prompt-composer.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  type ExecutionTrace,
  type SpanContribution,
  SpanStatus,
} from "../tracking/contract.ts";

const SPAN_ID_LENGTH = 16;
const PROMPT_RECORD = "prompt";
const ZERO_SPAN_ID = "0".repeat(SPAN_ID_LENGTH);

export const AgentPromptSpan = {
  Operation: "agent.prompt",
  AgentName: "kanthord.agent.name",
  Parts: "kanthord.prompt.parts",
  TemplatesDigest: "kanthord.prompt.templates_digest",
} as const;

export interface AgentPromptFacts {
  agent_name: string;
  parts: readonly string[];
  templates_digest: string;
}

export function agentPromptFacts(
  agentName: string,
  parts: readonly PromptPartAnswer[],
  templates: PromptTemplates,
): AgentPromptFacts {
  return {
    agent_name: agentName,
    parts: parts.map((entry) => `${entry.part}:${entry.name}:${entry.digest}`),
    templates_digest: digest(canonicalJSON(templates)),
  };
}

export function agentPromptSpanId(
  executionId: string,
  agentName: string,
): string {
  const spanId = createHash("sha256")
    .update(`${executionId}:${AgentPromptSpan.Operation}:${agentName}`)
    .digest("hex")
    .slice(0, SPAN_ID_LENGTH);
  assert.notEqual(spanId, ZERO_SPAN_ID);
  return spanId;
}

export function agentPromptContribution(
  trace: ExecutionTrace,
  facts: AgentPromptFacts,
  at: number,
): SpanContribution {
  const spanId = agentPromptSpanId(trace.execution_id, facts.agent_name);
  return {
    record_id: `${spanId}:${PROMPT_RECORD}`,
    span_id: spanId,
    parent_span_id: trace.root_span_id,
    operation: AgentPromptSpan.Operation,
    start_time: at,
    end_time: at,
    status: SpanStatus.Ok,
    attributes: {
      [AgentPromptSpan.AgentName]: facts.agent_name,
      [AgentPromptSpan.Parts]: [...facts.parts],
      [AgentPromptSpan.TemplatesDigest]: facts.templates_digest,
    },
  };
}
