import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type PromptPartAnswer,
  type PromptReference,
  promptReferenceSchema,
  type PromptTemplates,
} from "../agent/contract.ts";
import { digest } from "../agent/prompt-composer.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { packageVersion } from "../kernel/version.ts";
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
  Sources: "kanthord.prompt.sources",
  TemplatesDigest: "kanthord.prompt.templates_digest",
  EngineVersion: "kanthord.engine.version",
} as const;

export interface AgentPromptFacts {
  agent_name: string;
  sources: readonly PromptReference[];
  templates_digest: string;
  engine_version: string;
}

export function promptReference(part: PromptPartAnswer): PromptReference {
  assert.ok(part.digest !== null);
  return promptReferenceSchema.parse({
    part: part.part,
    name: part.name,
    origin: part.origin,
    path: part.path,
    binding_id: part.binding_id,
    commit: part.commit,
    digest: part.digest,
  });
}

export function agentPromptFacts(
  agentName: string,
  parts: readonly PromptPartAnswer[],
  templates: PromptTemplates,
): AgentPromptFacts {
  return {
    agent_name: agentName,
    sources: parts.map(promptReference),
    templates_digest: digest(canonicalJSON(templates)),
    engine_version: packageVersion(),
  };
}

const storedAttributesSchema = z.looseObject({
  [AgentPromptSpan.AgentName]: z.string().min(1),
  [AgentPromptSpan.Sources]: z.array(z.string()),
  [AgentPromptSpan.TemplatesDigest]: z.string(),
  [AgentPromptSpan.EngineVersion]: z.string().min(1),
});

export function storedPromptFacts(
  attributes: Readonly<Record<string, unknown>>,
): AgentPromptFacts {
  const stored = storedAttributesSchema.parse(attributes);
  return {
    agent_name: stored[AgentPromptSpan.AgentName],
    sources: stored[AgentPromptSpan.Sources].map((source) =>
      promptReferenceSchema.parse(JSON.parse(source)),
    ),
    templates_digest: stored[AgentPromptSpan.TemplatesDigest],
    engine_version: stored[AgentPromptSpan.EngineVersion],
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
      [AgentPromptSpan.Sources]: facts.sources.map((source) =>
        canonicalJSON(source),
      ),
      [AgentPromptSpan.TemplatesDigest]: facts.templates_digest,
      [AgentPromptSpan.EngineVersion]: facts.engine_version,
    },
  };
}
