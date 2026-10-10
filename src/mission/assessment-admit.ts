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
  verificationCovers,
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

const FIRST_COVERING_INDEX = 0;
const NO_REQUIRED_VERIFICATIONS = 0;
const SINGLE_COVERING_VERIFICATION = 1;
const NO_PROPOSALS = 0;
const PROPOSALS_FIELD = "proposals";

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
    invalidExecutionInput("child_outcome_ids");
}

function requireProposals(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  body: AssessmentSubmit,
): void {
  if (body.proposals.length === NO_PROPOSALS) return;
  if (
    node.kind !== NodeKind.Initiative ||
    body.result !== AssessmentResult.Undetermined
  )
    invalidExecutionInput(PROPOSALS_FIELD);
  const objectives = new Set(
    readMissionNodes(tx, node.mission_id)
      .filter(
        (child) =>
          child.parent_id === node.id &&
          child.kind === NodeKind.Objective &&
          child.retired_at === null,
      )
      .map((child) => child.id),
  );
  for (const proposal of body.proposals) {
    if (!objectives.has(proposal.objective_id))
      invalidExecutionInput(PROPOSALS_FIELD);
    for (const text of [
      proposal.name,
      proposal.requirement,
      proposal.criterion,
      proposal.task.name,
      proposal.task.requirement,
      proposal.task.criterion,
      ...proposal.task.verifications,
    ])
      requireTextBound(
        PROPOSALS_FIELD,
        text,
        dependencies.config.text_max_bytes,
      );
  }
}

function requireResult(
  body: AssessmentSubmit,
  verifications: Verification[],
  expected: string[],
): void {
  if (body.result === AssessmentResult.Success) {
    const covering = verifications.filter((candidate) =>
      verificationCovers(candidate, expected),
    );
    const verification = covering[FIRST_COVERING_INDEX];
    if (
      covering.length !== SINGLE_COVERING_VERIFICATION ||
      !verification ||
      !verificationPasses(verification, expected)
    )
      throw new OperationError(
        HttpStatus.Conflict,
        MissionErrorCode.AssessmentVerificationFailed,
        "Assessment requires exactly one passing verification.",
      );
    if (
      canonicalJSON(verification.tested_input) !==
      canonicalJSON(body.tested_input)
    )
      invalidExecutionInput("tested_input");
    return;
  }
  if (
    body.result === AssessmentResult.Undetermined &&
    (verifications.length === NO_REQUIRED_VERIFICATIONS ||
      verifications.some(
        (verification) => !verificationPasses(verification, expected),
      ))
  )
    invalidExecutionInput("result");
  if (
    verifications.some(
      (verification) =>
        canonicalJSON(verification.tested_input) !==
        canonicalJSON(body.tested_input),
    )
  )
    invalidExecutionInput("tested_input");
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
    dependencies.config.text_max_bytes,
  );
  const evidence = body.evidence_ids.map((id) => readEvidence(tx, id));
  if (
    evidence.some(
      (row) =>
        !row || row.node_id !== node.id || row.attempt !== attempt.attempt,
    )
  )
    invalidExecutionInput("evidence_ids");
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
  requireChildren(tx, node, body.child_outcome_ids);
  requireProposals(tx, dependencies, node, body);
  requireTestedInput(
    tx,
    dependencies.bindings,
    node,
    revision,
    body.tested_input,
  );
  requireResult(body, verifications, requiredVerifications(tx, node, revision));
}
