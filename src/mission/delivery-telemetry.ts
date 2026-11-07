import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  type Attributes,
  type ServerTrace,
  SpanStatus,
} from "../tracking/contract.ts";
import type { ActTelemetry } from "./act-telemetry.ts";
import type { AdmissionRefusal } from "./contract.ts";

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const END_RECORD = "end";
export const DELIVERY_ADMIT_OPERATION = "mission.delivery.admit";

export const DeliveryAttribute = {
  ProjectId: "kanthord.project.id",
  ActorId: "kanthord.actor.id",
  Refusal: "kanthord.delivery.refusal",
} as const;

export interface RefusedLinkUpdate {
  project_id: string;
  actor_id: string | null;
  reason: AdmissionRefusal;
  refused_at: number;
}

function attributesOf(facts: RefusedLinkUpdate): Attributes {
  return {
    [DeliveryAttribute.ProjectId]: facts.project_id,
    [DeliveryAttribute.Refusal]: facts.reason,
    ...(facts.actor_id === null
      ? {}
      : { [DeliveryAttribute.ActorId]: facts.actor_id }),
  };
}

export function recordRefusedLinkUpdate(
  dependencies: { acts: ActTelemetry; logger: Logger },
  facts: RefusedLinkUpdate,
): void {
  try {
    const trace: ServerTrace = {
      trace_id: randomBytes(TRACE_ID_BYTES).toString("hex"),
      root_span_id: randomBytes(SPAN_ID_BYTES).toString("hex"),
      project_id: facts.project_id,
      created_at: facts.refused_at,
      node_id: null,
      attempt: null,
    };
    dependencies.acts.act(trace, {
      record_id: `${trace.root_span_id}:${END_RECORD}`,
      span_id: trace.root_span_id,
      parent_span_id: null,
      operation: DELIVERY_ADMIT_OPERATION,
      start_time: facts.refused_at,
      end_time: facts.refused_at,
      status: SpanStatus.Ok,
      attributes: attributesOf(facts),
    });
  } catch (error) {
    dependencies.logger.warn(
      { error, project_id: facts.project_id },
      "Refused link update trace failed.",
    );
  }
}
