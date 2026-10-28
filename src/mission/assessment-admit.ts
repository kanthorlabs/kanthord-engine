import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssessmentResult,
  type AssessmentSubmit,
  Intent,
  MissionErrorCode,
  type Revision,
  type Verification,
  verificationSchema,
} from "./contract.ts";
import {
  requiredVerifications,
  requireTestedInput,
  verificationCovers,
  verificationPasses,
} from "./evidence-content.ts";
import { invalidExecutionInput, requireTextBound } from "./execution.ts";
import {
  type AttemptRow,
  readAssets,
  readCurrentOutcome,
  readEvidence,
} from "./record-store.ts";
import type { Dependencies } from "./service.ts";
import { directDependenciesOf } from "./graph.ts";
import {
  intentOf,
  type NodeRow,
  readDependencies,
  readMissionNodes,
} from "./store.ts";

const FIRST_COVERING_INDEX = 0;
const NO_REQUIRED_VERIFICATIONS = 0;
const SINGLE_COVERING_VERIFICATION = 1;
const NO_PROPOSALS = 0;
const PROPOSALS_FIELD = "proposals";

function requireDependencyOutcomes(
  tx: Transaction,
  node: NodeRow,
  intent: Intent,
  dependencyOutcomeIds: readonly string[],
): void {
  assert.ok(tx.database.isTransaction);
  const expected =
    intent === Intent.Implement
      ? []
      : directDependenciesOf(
          node.id,
          readDependencies(tx, node.mission_id),
        ).flatMap((id) => {
          const outcome = readCurrentOutcome(tx, id);
          return outcome ? [outcome.id] : [];
        });
  if (
    dependencyOutcomeIds.length !== expected.length ||
    new Set(dependencyOutcomeIds).size !== expected.length ||
    !expected.every((id) => dependencyOutcomeIds.includes(id))
  )
    invalidExecutionInput("dependency_outcome_ids");
}

function requireProposals(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  intent: Intent,
  body: AssessmentSubmit,
): void {
  if (body.proposals.length === NO_PROPOSALS) return;
  if (
    intent !== Intent.Examine ||
    body.result !== AssessmentResult.Undetermined
  )
    invalidExecutionInput(PROPOSALS_FIELD);
  const direct = new Set(
    directDependenciesOf(node.id, readDependencies(tx, node.mission_id)),
  );
  const implementDependencies = new Set(
    readMissionNodes(tx, node.mission_id)
      .filter(
        (dependency) =>
          direct.has(dependency.id) &&
          intentOf(tx, dependency.id) === Intent.Implement,
      )
      .map((dependency) => dependency.id),
  );
  for (const proposal of body.proposals) {
    if (!implementDependencies.has(proposal.dependency_id))
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
  requireDependencyOutcomes(
    tx,
    node,
    revision.content.intent,
    body.dependency_outcome_ids,
  );
  requireProposals(tx, dependencies, node, revision.content.intent, body);
  requireTestedInput(
    tx,
    dependencies.bindings,
    node,
    revision,
    body.tested_input,
  );
  requireResult(body, verifications, requiredVerifications(tx, node, revision));
}
