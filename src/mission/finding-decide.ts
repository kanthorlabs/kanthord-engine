import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import type { Acted } from "./act-telemetry.ts";
import {
  type Finding,
  type FindingDecide,
  FindingRoute,
  type HumanActor,
  MissionErrorCode,
} from "./contract.ts";
import { requireTextBound } from "./execution.ts";
import { writeFindingDecision } from "./finding-store.ts";
import { getFinding, requireFinding } from "./finding-read.ts";
import { requireNode } from "./node-read.ts";
import { requireMission } from "./write.ts";

const NO_ATTEMPT = 0;

export function findingDecided(findingId: string): never {
  throw new OperationError(
    HttpStatus.Conflict,
    MissionErrorCode.FindingDecided,
    "Finding already holds a decision.",
    { finding_id: findingId },
  );
}

export function findingActed(
  tx: Transaction,
  findingId: string,
  reason: string | null,
  now: number,
): Acted<Finding> {
  const result = getFinding(tx, findingId);
  const node = requireNode(tx, result.node_id);
  assert.ok(node.state);
  const mission = requireMission(tx, node.mission_id);
  return {
    result,
    act: {
      project_id: mission.project_id,
      node_id: node.id,
      attempt: node.attempt ?? NO_ATTEMPT,
      acted_at: now,
      mission_version: mission.version,
      from: node.state,
      to: node.state,
      reason,
      revoked: null,
      evidence_id: null,
      lead_time_ms: null,
    },
  };
}

export function decideFinding(
  tx: Transaction,
  findingId: string,
  body: FindingDecide,
  actor: HumanActor,
  textMaxBytes: number,
  now: number,
): Acted<Finding> {
  const finding = requireFinding(tx, findingId);
  if (finding.decision !== null) findingDecided(finding.id);
  if (finding.route !== FindingRoute.Report)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.FindingNotReported,
      "Finding does not wait for a human.",
      { finding_id: finding.id, route: finding.route },
    );
  requireTextBound("decision_reason", body.decision_reason, textMaxBytes);
  writeFindingDecision(
    tx,
    finding.id,
    body.decision,
    body.decision_reason,
    canonicalJSON(actor),
    now,
  );
  return findingActed(tx, finding.id, body.decision_reason, now);
}
