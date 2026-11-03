import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import type { Acted } from "./act-telemetry.ts";
import {
  type Finding,
  FINDING_IDENTITY_PREFIX,
  FindingAction,
  type FindingCreate,
  FindingRoute,
  type FindingUpdate,
  type HumanActor,
  MissionErrorCode,
} from "./contract.ts";
import { invalidExecutionInput } from "./execution.ts";
import { requireFindingTexts, requireRevisionTask } from "./finding-admit.ts";
import { findingActed, findingDecided } from "./finding-decide.ts";
import { requireFinding } from "./finding-read.ts";
import {
  countHumanFindings,
  insertFinding,
  updateFindingReport,
} from "./finding-store.ts";
import { getRevision, requireNode } from "./node-read.ts";
import { type AssessmentRow, readAssessment } from "./record-store.ts";
import { requireMission } from "./write.ts";

const HUMAN_LABEL_PREFIX = "H";
const NEXT_LABEL = 1;
const ASSESSMENT_ID_FIELD = "assessment_id";
const TASK_ID_FIELD = "task_id";

function requireNodeAssessment(
  tx: Transaction,
  nodeId: string,
  assessmentId: string,
): AssessmentRow {
  const assessment = readAssessment(tx, assessmentId);
  if (assessment === null || assessment.node_id !== nodeId)
    invalidExecutionInput(ASSESSMENT_ID_FIELD);
  return assessment;
}

function requireAssessmentTask(
  tx: Transaction,
  assessment: AssessmentRow,
  taskId: string | null | undefined,
): void {
  requireRevisionTask(
    TASK_ID_FIELD,
    getRevision(tx, assessment.node_id, assessment.node_revision),
    taskId,
  );
}

export function createFinding(
  tx: Transaction,
  nodeId: string,
  body: FindingCreate,
  actor: HumanActor,
  now: number,
): Acted<Finding> {
  const node = requireNode(tx, nodeId);
  requireMission(tx, node.mission_id, body.expected_mission_version);
  const assessment = requireNodeAssessment(tx, node.id, body.assessment_id);
  requireAssessmentTask(tx, assessment, body.task_id);
  requireFindingTexts((key) => key, body);
  const id = createIdentity(FINDING_IDENTITY_PREFIX);
  insertFinding(tx, {
    id,
    node_id: node.id,
    assessment_id: assessment.id,
    label: `${HUMAN_LABEL_PREFIX}${countHumanFindings(tx, node.id) + NEXT_LABEL}`,
    kind: body.kind,
    action: FindingAction.Yes,
    task_id: body.task_id,
    ground: null,
    name: body.name,
    description: body.description,
    fix: body.fix,
    why: body.why,
    route: FindingRoute.Report,
    fixed_assessment_id: null,
    cause_owner: body.cause_owner,
    created_by: canonicalJSON(actor),
    decision: null,
    decision_reason: null,
    decided_by: null,
    decided_at: null,
  });
  return findingActed(tx, id, null, now);
}

export function updateFinding(
  tx: Transaction,
  findingId: string,
  body: FindingUpdate,
  now: number,
): Acted<Finding> {
  const finding = requireFinding(tx, findingId);
  if (finding.created_by === null)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.FindingNotHuman,
      "Finding is a reviewer finding.",
      { finding_id: finding.id },
    );
  if (finding.decision !== null) findingDecided(finding.id);
  const node = requireNode(tx, finding.node_id);
  requireMission(tx, node.mission_id, body.expected_mission_version);
  const assessment = readAssessment(tx, finding.assessment_id);
  assert.ok(assessment);
  requireAssessmentTask(tx, assessment, body.task_id);
  requireFindingTexts((key) => key, body);
  updateFindingReport(tx, finding.id, {
    kind: body.kind ?? finding.kind,
    task_id: body.task_id === undefined ? finding.task_id : body.task_id,
    name: body.name ?? finding.name,
    description: body.description ?? finding.description,
    fix: body.fix ?? finding.fix,
    why: body.why ?? finding.why,
    cause_owner: body.cause_owner ?? finding.cause_owner,
  });
  return findingActed(tx, finding.id, null, now);
}
