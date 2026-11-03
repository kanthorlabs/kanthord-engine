import type { Transaction } from "../kernel/store.ts";
import {
  AssessmentResult,
  type AssessmentSubmit,
  FINDING_TEXT_MAX_BYTES,
  FindingAction,
  FindingKind,
  type FindingSubmit,
  type Revision,
} from "./contract.ts";
import { invalidExecutionInput, requireTextBound } from "./execution.ts";
import { type PlacedFindingRow, readOpenFixFindings } from "./finding-store.ts";

const FINDINGS_FIELD = "findings";
const FIXED_FINDING_IDS_FIELD = "fixed_finding_ids";
const BLOCKER_LABEL_PREFIX = "B";

export function kindOfLabel(label: string): FindingKind {
  return label.startsWith(BLOCKER_LABEL_PREFIX)
    ? FindingKind.Blocker
    : FindingKind.Suggestion;
}

export function requireFindingTexts(
  field: (key: "name" | "description" | "fix" | "why") => string,
  texts: Partial<Pick<FindingSubmit, "name" | "description" | "fix" | "why">>,
): void {
  for (const key of ["name", "description", "fix", "why"] as const) {
    const text = texts[key];
    if (text !== undefined)
      requireTextBound(field(key), text, FINDING_TEXT_MAX_BYTES);
  }
}

export function requireRevisionTask(
  field: string,
  revision: Revision,
  taskId: string | null | undefined,
): void {
  if (
    taskId !== null &&
    taskId !== undefined &&
    !revision.tasks.some((task) => task.id === taskId)
  )
    invalidExecutionInput(field);
}

function requireFinding(revision: Revision, finding: FindingSubmit): void {
  const blocker = kindOfLabel(finding.label) === FindingKind.Blocker;
  if (
    blocker
      ? finding.action !== FindingAction.Yes || finding.ground === null
      : finding.ground !== null
  )
    invalidExecutionInput(FINDINGS_FIELD);
  requireRevisionTask(FINDINGS_FIELD, revision, finding.task_id);
  requireFindingTexts(() => FINDINGS_FIELD, finding);
}

export function admitFindings(
  tx: Transaction,
  nodeId: string,
  attempt: number,
  revision: Revision,
  body: AssessmentSubmit,
): PlacedFindingRow[] {
  const labels = body.findings.map((finding) => finding.label);
  if (new Set(labels).size !== labels.length)
    invalidExecutionInput(FINDINGS_FIELD);
  for (const finding of body.findings) requireFinding(revision, finding);
  const success = body.result === AssessmentResult.Success;
  if (
    success &&
    labels.some((label) => kindOfLabel(label) === FindingKind.Blocker)
  )
    invalidExecutionInput(FINDINGS_FIELD);
  const open = readOpenFixFindings(tx, nodeId, attempt);
  const openIds = new Set(open.map((row) => row.id));
  if (body.fixed_finding_ids.some((id) => !openIds.has(id)))
    invalidExecutionInput(FIXED_FINDING_IDS_FIELD);
  const listed = new Set(body.fixed_finding_ids);
  if (
    success &&
    open.some((row) => row.kind === FindingKind.Blocker && !listed.has(row.id))
  )
    invalidExecutionInput(FIXED_FINDING_IDS_FIELD);
  return open;
}
