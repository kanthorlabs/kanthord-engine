import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  SpanStatus,
  type Attributes,
  type ExecutionTrace,
  type ServerTrace,
  type SpanLink,
} from "../tracking/contract.ts";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const END_RECORD = "end";
const REASON_TEXT = "reason";
const NO_ATTEMPT = 0;

export const Act = {
  Pause: "mission.node.pause",
  Resume: "mission.node.resume",
  Ready: "mission.node.ready",
  Unblock: "mission.node.unblock",
  Override: "mission.node.override",
  Block: "mission.node.block",
  Discard: "mission.node.discard",
  ApproveProposal: "mission.proposal.approve",
  DeleteEvidence: "mission.evidence.delete",
} as const;
export type Act = (typeof Act)[keyof typeof Act];

export const ActAttribute = {
  ProjectId: "kanthord.project.id",
  NodeId: "kanthord.node.id",
  Attempt: "kanthord.attempt",
  StateFrom: "kanthord.node.state.from",
  StateTo: "kanthord.node.state.to",
  EvidenceId: "kanthord.evidence.id",
} as const;

export interface ActFacts {
  project_id: string;
  node_id: string;
  attempt: number;
  acted_at: number;
  from: string | null;
  to: string;
  reason: string | null;
  revoked: ExecutionTrace | null;
  evidence_id: string | null;
}

export interface ActContribution {
  record_id: string;
  span_id: string;
  parent_span_id: string | null;
  operation: string;
  start_time: number;
  end_time: number;
  status: SpanStatus;
  attributes: Attributes;
  links?: SpanLink[];
  text_ids?: string[];
  texts?: { text_id: string; text: string }[];
}

export interface ActTelemetry {
  act(trace: ServerTrace, contribution: ActContribution): void;
}

export interface Acted<T> {
  result: T;
  act: ActFacts;
}

function attemptOf(facts: ActFacts): number | null {
  return facts.attempt === NO_ATTEMPT ? null : facts.attempt;
}

function attributesOf(facts: ActFacts): Attributes {
  const attempt = attemptOf(facts);
  return {
    [ActAttribute.ProjectId]: facts.project_id,
    [ActAttribute.NodeId]: facts.node_id,
    ...(attempt === null ? {} : { [ActAttribute.Attempt]: attempt }),
    ...(facts.from === null ? {} : { [ActAttribute.StateFrom]: facts.from }),
    [ActAttribute.StateTo]: facts.to,
    ...(facts.evidence_id === null
      ? {}
      : { [ActAttribute.EvidenceId]: facts.evidence_id }),
  };
}

function reasonOf(rootSpanId: string, reason: string | null) {
  if (reason === null) return {};
  const textId = `${rootSpanId}:${REASON_TEXT}`;
  return { text_ids: [textId], texts: [{ text_id: textId, text: reason }] };
}

function linksOf(revoked: ExecutionTrace | null) {
  if (revoked === null) return {};
  return {
    links: [{ trace_id: revoked.trace_id, span_id: revoked.root_span_id }],
  };
}

export function actTrace(
  act: Act,
  facts: ActFacts,
): { trace: ServerTrace; contribution: ActContribution } {
  const trace: ServerTrace = {
    trace_id: randomBytes(TRACE_ID_BYTES).toString("hex"),
    root_span_id: randomBytes(SPAN_ID_BYTES).toString("hex"),
    project_id: facts.project_id,
    created_at: facts.acted_at,
    node_id: facts.node_id,
    attempt: attemptOf(facts),
  };
  return {
    trace,
    contribution: {
      record_id: `${trace.root_span_id}:${END_RECORD}`,
      span_id: trace.root_span_id,
      parent_span_id: null,
      operation: act,
      start_time: facts.acted_at,
      end_time: facts.acted_at,
      status: SpanStatus.Ok,
      attributes: attributesOf(facts),
      ...linksOf(facts.revoked),
      ...reasonOf(trace.root_span_id, facts.reason),
    },
  };
}

export function recordAct(
  dependencies: { acts: ActTelemetry; logger: Logger },
  act: Act,
  facts: ActFacts,
): void {
  try {
    const { trace, contribution } = actTrace(act, facts);
    dependencies.acts.act(trace, contribution);
  } catch (error) {
    dependencies.logger.warn(
      { error, act, node_id: facts.node_id },
      "Act trace failed.",
    );
  }
}
