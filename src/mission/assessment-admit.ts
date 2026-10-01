import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssessmentResult,
  MissionErrorCode,
  NodeKind,
  verificationSchema,
  type AssessmentSubmit,
  type Revision,
  type Verification,
} from "./contract.ts";
import {
  requiredVerifications,
  requireTestedInput,
  verificationPasses,
} from "./evidence-content.ts";
import { invalidExecutionInput, requireTextBound } from "./execution.ts";
import {
  readAssets,
  readCurrentOutcome,
  readEvidence,
  type AttemptRow,
} from "./record-store.ts";
import type { Dependencies } from "./service.ts";
import { readMissionNodes, type NodeRow } from "./store.ts";

const ZERO = 0;
const ONE = 1;

function requireChildren(
  tx: Transaction,
  node: NodeRow,
  childOutcomeIds: readonly string[],
): void {
  assert.notEqual(node.kind, NodeKind.Task);
  assert.ok(tx.database.isTransaction);
  const expected =
    node.kind === NodeKind.Objective
      ? []
      : readMissionNodes(tx, node.mission_id)
          .filter(
            (child) =>
              child.parent_id === node.id &&
              child.kind === NodeKind.Objective &&
              child.retired_at === null,
          )
          .flatMap((child) => {
            const outcome = readCurrentOutcome(tx, child.id);
            return outcome ? [outcome.id] : [];
          });
  if (
    childOutcomeIds.length !== expected.length ||
    new Set(childOutcomeIds).size !== expected.length ||
    !expected.every((id) => childOutcomeIds.includes(id))
  )
    invalidExecutionInput("childOutcomeIds");
}

function requireResult(
  body: AssessmentSubmit,
  verifications: Verification[],
  expected: string[],
): void {
  if (body.result === AssessmentResult.Success) {
    const verification = verifications[ZERO];
    if (
      verifications.length !== ONE ||
      !verification ||
      !verificationPasses(verification, expected)
    )
      throw new OperationError(
        HttpStatus.Conflict,
        MissionErrorCode.AssessmentVerificationFailed,
        "Assessment requires exactly one passing verification.",
      );
    if (
      canonicalJSON(verification.testedInput) !==
      canonicalJSON(body.testedInput)
    )
      invalidExecutionInput("testedInput");
    return;
  }
  if (
    body.result === AssessmentResult.Undetermined &&
    verifications.some(
      (verification) => !verificationPasses(verification, expected),
    )
  )
    invalidExecutionInput("result");
}

export function admitAssessment(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  attempt: AttemptRow,
  revision: Revision,
  body: AssessmentSubmit,
): void {
  assert.equal(attempt.node_id, node.id);
  assert.equal(attempt.node_revision, revision.revision);
  requireTextBound(
    "rationale",
    body.rationale,
    dependencies.config.textMaxBytes,
  );
  const evidence = body.evidenceIds.map((id) => readEvidence(tx, id));
  if (
    evidence.some(
      (row) =>
        !row || row.node_id !== node.id || row.attempt !== attempt.attempt,
    )
  )
    invalidExecutionInput("evidenceIds");
  const verifications: Verification[] = [];
  for (const row of evidence) {
    assert.ok(row);
    if (readAssets(tx, row.id).some((asset) => asset.published_at === null))
      throw new OperationError(
        HttpStatus.Conflict,
        MissionErrorCode.AssessmentEvidenceUnpublished,
        "Assessment evidence is not published.",
      );
    if (row.verification !== null)
      verifications.push(
        verificationSchema.parse(JSON.parse(row.verification)),
      );
  }
  requireChildren(tx, node, body.childOutcomeIds);
  requireTestedInput(
    tx,
    dependencies.bindings,
    node,
    revision,
    body.testedInput,
  );
  requireResult(body, verifications, requiredVerifications(tx, node, revision));
}
