import assert from "node:assert/strict";
import { z } from "zod";
import type { Transaction } from "../kernel/store.ts";
import {
  ActorKind,
  AssessmentResult,
  AssetKind,
  ClosingEvent,
  NodeState,
  actorSchema,
  attemptSchema,
  evidenceAssetSchema,
  evidenceSchema,
  outcomeSchema,
  verificationSchema,
  assessmentSchema,
  testedInputSchema,
  type Assessment,
  type ExecutionAttribution,
  type Attempt,
  type Evidence,
  type EvidenceAsset,
  type Outcome,
  type ExternalAction,
  type BlockedContext,
  type MissionBindings,
} from "./contract.ts";
import { actionStatesOf, requiredActionsOf } from "./frozen-action.ts";
import {
  readAssets,
  readAssessment,
  readAttempt,
  readCurrentOutcome,
  readOutcomesOfAttempt,
  readRequests,
  readOutcome,
  type AssetRow,
  type AttemptRow,
  type EvidenceRow,
  type OutcomeRow,
  type AssessmentRow,
} from "./record-store.ts";
import { readNode, type NodeRow } from "./store.ts";
import { currencyOf } from "./currency.ts";

const ZERO = 0;
const stringSet = z.array(z.string());
const assetContent = z.record(z.string(), z.unknown());

export function attemptRecord(
  tx: Transaction,
  bindings: MissionBindings,
  row: AttemptRow,
): Attempt {
  return attemptSchema.parse({
    nodeId: row.node_id,
    attempt: row.attempt,
    nodeRevision: row.node_revision,
    requiredExternalActions: requiredActionsOf(
      tx,
      bindings,
      row.node_id,
      row.node_revision,
    ),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    outcomeIds: readOutcomesOfAttempt(tx, row.node_id, row.attempt).map(
      (outcome) => outcome.id,
    ),
    openedBy: actorSchema.parse(JSON.parse(row.opened_by)),
  });
}

function assetRecord(row: AssetRow): EvidenceAsset {
  const content = assetContent.parse(JSON.parse(row.content));
  const base = {
    id: row.id,
    kind: row.kind,
    publishedAt: row.published_at,
    expiredAt: row.expired_at,
  };
  if (row.kind === AssetKind.Platform)
    return evidenceAssetSchema.parse({ ...base, address: content });
  if (row.kind === AssetKind.Repository)
    return evidenceAssetSchema.parse({
      ...base,
      address: {
        kind: row.kind,
        bindingId: content.bindingId,
        commit: content.commit,
      },
    });
  if (row.kind === AssetKind.Produced)
    return evidenceAssetSchema.parse({
      ...base,
      address: { kind: row.kind, sha256: content.sha256 },
    });
  assert.equal(row.kind, AssetKind.Object);
  return evidenceAssetSchema.parse({
    ...base,
    storageBindingId: content.storageBindingId,
    size: content.size,
    mediaType: content.mediaType,
    address: {
      kind: row.kind,
      location: content.location,
      ...(content.objectVersion === undefined
        ? {}
        : { version: content.objectVersion }),
      ...(content.sha256 === undefined ? {} : { sha256: content.sha256 }),
    },
  });
}

export function evidenceRecord(tx: Transaction, row: EvidenceRow): Evidence {
  return evidenceSchema.parse({
    id: row.id,
    nodeId: row.node_id,
    attempt: row.attempt,
    subject: row.subject,
    assets: readAssets(tx, row.id).map(assetRecord),
    provenance: actorSchema.parse(JSON.parse(row.provenance)),
    createdAt: row.created_at,
    ...(row.requirement_key === null
      ? {}
      : { requirementKey: row.requirement_key }),
    ...(row.end_state === null ? {} : { endState: row.end_state }),
    ...(row.verification === null
      ? {}
      : {
          verification: verificationSchema.parse(JSON.parse(row.verification)),
        }),
  });
}

function closingEvent(
  tx: Transaction,
  bindings: MissionBindings,
  row: OutcomeRow,
  assessment: AssessmentRow,
): ClosingEvent {
  if (assessment.actor !== null) {
    assert.equal(
      actorSchema.parse(JSON.parse(assessment.actor)).kind,
      ActorKind.Human,
    );
    if (assessment.result === AssessmentResult.Success)
      return ClosingEvent.SuccessOverride;
    if (
      assessment.result === AssessmentResult.Undetermined &&
      readNode(tx, row.node_id)?.state === NodeState.Discarded &&
      readCurrentOutcome(tx, row.node_id)?.id === row.id
    )
      return ClosingEvent.HumanDiscard;
    return ClosingEvent.HumanBlock;
  }
  assert.ok(assessment.execution_id);
  if (assessment.result !== AssessmentResult.Success)
    return ClosingEvent.AssessmentNotPassed;
  if (row.result === AssessmentResult.Undetermined)
    return ClosingEvent.ExternalFailed;
  const attempt = readAttempt(tx, row.node_id, assessment.attempt);
  assert.ok(attempt);
  return requiredActionsOf(tx, bindings, row.node_id, attempt.node_revision)
    .length === ZERO
    ? ClosingEvent.AssessmentPassed
    : ClosingEvent.ExternalSuccess;
}

export function outcomeRecord(
  tx: Transaction,
  bindings: MissionBindings,
  row: OutcomeRow,
): Outcome {
  const assessment = readAssessment(tx, row.assessment_id);
  assert.ok(assessment);
  assert.equal(assessment.node_id, row.node_id);
  return outcomeSchema.parse({
    id: row.id,
    nodeId: row.node_id,
    attempt: assessment.attempt,
    nodeRevision: assessment.node_revision,
    closingEvent: closingEvent(tx, bindings, row, assessment),
    result: row.result,
    assessmentId: row.assessment_id,
    evidenceIds: [
      ...new Set([
        ...stringSet.parse(JSON.parse(row.evidence_ids)),
        ...stringSet.parse(JSON.parse(assessment.evidence_ids)),
      ]),
    ].sort(),
    createdAt: row.created_at,
  });
}

export function externalActionRecords(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  attempt: number,
): ExternalAction[] {
  if (attempt === ZERO) return [];
  return actionStatesOf(tx, bindings, nodeId, attempt).map(
    ({ action, request, resolution }) => ({
      nodeId,
      attempt,
      action,
      requested: request !== null,
      requestEvidenceId: request?.id ?? null,
      resolution,
    }),
  );
}

export function blockedContextOf(
  tx: Transaction,
  bindings: MissionBindings,
  node: NodeRow,
): BlockedContext {
  assert.equal(node.state, NodeState.Blocked);
  const current = readCurrentOutcome(tx, node.id);
  assert.ok(current, "A blocked node requires its closing outcome.");
  const outcome = outcomeRecord(tx, bindings, current);
  return {
    outcome,
    requests:
      outcome.attempt === ZERO
        ? []
        : readRequests(tx, node.id, outcome.attempt).map((row) =>
            evidenceRecord(tx, row),
          ),
  };
}

export function assessmentRecord(
  tx: Transaction,
  dependencies: { executionAttribution: ExecutionAttribution },
  row: AssessmentRow,
): Assessment {
  const childOutcomeIds = stringSet.parse(JSON.parse(row.child_outcome_ids));
  const childNodeIds = [
    ...new Set(
      childOutcomeIds.map((id) => {
        const child = readOutcome(tx, id);
        assert.ok(child);
        return child.node_id;
      }),
    ),
  ].sort();
  const base = {
    id: row.id,
    nodeId: row.node_id,
    executionId: row.execution_id,
    attempt: row.attempt,
    nodeRevision: row.node_revision,
    evidenceIds: stringSet.parse(JSON.parse(row.evidence_ids)),
    childOutcomeIds,
    childNodeIds,
    result: row.result,
    rationale: row.rationale,
    createdAt: row.created_at,
  };
  if (row.execution_id === null) {
    assert.ok(row.actor !== null);
    const actor = actorSchema.parse(JSON.parse(row.actor));
    assert.equal(actor.kind, ActorKind.Human);
    return assessmentSchema.parse({
      ...base,
      actor,
      testedInput: null,
      currency: null,
      workerVersion: null,
    });
  }
  const attribution = dependencies.executionAttribution.of(
    tx,
    row.execution_id,
  );
  assert.ok(attribution);
  assert.equal(row.actor, null);
  return assessmentSchema.parse({
    ...base,
    actor: {
      kind: ActorKind.Execution,
      executionId: row.execution_id,
      clientId: attribution.clientId,
      name: attribution.name,
    },
    testedInput:
      row.tested_input === null
        ? null
        : testedInputSchema.parse(JSON.parse(row.tested_input)),
    currency: currencyOf(tx, row),
    workerVersion: attribution.workerName,
  });
}
