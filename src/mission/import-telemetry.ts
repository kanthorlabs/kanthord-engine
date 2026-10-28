import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  type Attributes,
  COLLECTION_MAX,
  type ServerTrace,
  SpanStatus,
} from "../tracking/contract.ts";
import type { ActContribution, ActTelemetry } from "./act-telemetry.ts";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const END_RECORD = "end";
const REASON_TEXT = "reason";
export const IMPORT_OPERATION = "mission.import";

export const ImportAttribute = {
  ProjectId: "kanthord.project.id",
  MissionId: "kanthord.mission.id",
  VersionFrom: "kanthord.mission.version.from",
  VersionTo: "kanthord.mission.version.to",
  Creates: "kanthord.import.creates",
  Updates: "kanthord.import.updates",
  Retirements: "kanthord.import.retirements",
  RemovedEdges: "kanthord.import.removed_edges",
  HumanUsername: "kanthord.human.username",
  ViolationCodes: "kanthord.import.violation_codes",
  ErrorType: "error.type",
} as const;

export interface ImportFacts {
  project_id: string;
  mission_id: string;
  version_from: number;
  version_to: number;
  creates: number;
  updates: number;
  retirements: number;
  removed_edges: number;
  actor_account: string;
  reason: string;
  violation_codes: string[];
  error_type: string | null;
  applied_at: number;
}

function violationCodesOf(codes: string[]): string[] {
  return [...new Set(codes)].sort().slice(0, COLLECTION_MAX);
}

function outcomeAttributes(facts: ImportFacts): Attributes {
  if (facts.error_type === null) return {};
  return {
    [ImportAttribute.ErrorType]: facts.error_type,
    [ImportAttribute.ViolationCodes]: violationCodesOf(facts.violation_codes),
  };
}

function attributesOf(facts: ImportFacts): Attributes {
  return {
    [ImportAttribute.ProjectId]: facts.project_id,
    [ImportAttribute.MissionId]: facts.mission_id,
    [ImportAttribute.VersionFrom]: facts.version_from,
    [ImportAttribute.VersionTo]: facts.version_to,
    [ImportAttribute.Creates]: facts.creates,
    [ImportAttribute.Updates]: facts.updates,
    [ImportAttribute.Retirements]: facts.retirements,
    [ImportAttribute.RemovedEdges]: facts.removed_edges,
    [ImportAttribute.HumanUsername]: facts.actor_account,
    ...outcomeAttributes(facts),
  };
}

export function importTrace(facts: ImportFacts): {
  trace: ServerTrace;
  contribution: ActContribution;
} {
  const trace: ServerTrace = {
    trace_id: randomBytes(TRACE_ID_BYTES).toString("hex"),
    root_span_id: randomBytes(SPAN_ID_BYTES).toString("hex"),
    project_id: facts.project_id,
    created_at: facts.applied_at,
    node_id: null,
    attempt: null,
  };
  const textId = `${trace.root_span_id}:${REASON_TEXT}`;
  return {
    trace,
    contribution: {
      record_id: `${trace.root_span_id}:${END_RECORD}`,
      span_id: trace.root_span_id,
      parent_span_id: null,
      operation: IMPORT_OPERATION,
      start_time: facts.applied_at,
      end_time: facts.applied_at,
      status: facts.error_type === null ? SpanStatus.Ok : SpanStatus.Error,
      attributes: attributesOf(facts),
      text_ids: [textId],
      texts: [{ text_id: textId, text: facts.reason }],
    },
  };
}

export function recordImport(
  dependencies: { acts: ActTelemetry; logger: Logger },
  facts: ImportFacts,
): void {
  try {
    const { trace, contribution } = importTrace(facts);
    dependencies.acts.act(trace, contribution);
  } catch (error) {
    dependencies.logger.warn(
      { error, mission_id: facts.mission_id },
      "Import trace failed.",
    );
  }
}
