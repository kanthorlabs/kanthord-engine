import assert from "node:assert/strict";
import { z } from "zod";
import type { Transaction } from "../kernel/store.ts";
import {
  ActorKind,
  actorSchema,
  type Assessment,
  AssessmentResult,
  assessmentSchema,
  AssetKind,
  type Attempt,
  attemptSchema,
  type BlockedContext,
  ClosingEvent,
  type Evidence,
  type EvidenceAsset,
  evidenceAssetSchema,
  evidenceSchema,
  type ExecutionAttribution,
  type ExternalAction,
  type MissionBindings,
  NodeState,
  type Outcome,
  outcomeSchema,
  type PausedContext,
  type PauseFacts,
  PauseRule,
  testedInputSchema,
  verificationSchema,
} from "./contract.ts";
import { actionStatesOf, requiredActionsOf } from "./frozen-action.ts";
import {
  type AssessmentRow,
  type AssetRow,
  type AttemptRow,
  type EvidenceRow,
  type OutcomeRow,
  readAssessment,
  readAssessmentRound,
  readAssets,
  readAttempt,
  readCurrentOutcome,
  readOutcome,
  readOutcomesOfAttempt,
  readRequests,
} from "./record-store.ts";
import { type NodeRow, readNode } from "./store.ts";
import { currencyOf } from "./currency.ts";
import type { MissionConfig } from "./config.ts";

const NO_REQUIRED_ACTIONS = 0;
const NO_ATTEMPT = 0;
const NO_LIMIT = 0;
const stringSet = z.array(z.string());
const assetContent = z.record(z.string(), z.unknown());

export function attemptRecord(
  tx: Transaction,
  bindings: MissionBindings,
  row: AttemptRow,
): Attempt {
  return attemptSchema.parse({
    node_id: row.node_id,
    attempt: row.attempt,
    node_revision: row.node_revision,
    start_point: row.start_point,
    required_external_actions: requiredActionsOf(
      tx,
      bindings,
      row.node_id,
      row.node_revision,
    ),
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    outcome_ids: readOutcomesOfAttempt(tx, row.node_id, row.attempt).map(
      (outcome) => outcome.id,
    ),
    opened_by: actorSchema.parse(JSON.parse(row.opened_by)),
  });
}

function assetRecord(row: AssetRow): EvidenceAsset {
  const content = assetContent.parse(JSON.parse(row.content));
  const base = {
    id: row.id,
    kind: row.kind,
    published_at: row.published_at,
    expired_at: row.expired_at,
  };
  if (row.kind === AssetKind.Platform)
    return evidenceAssetSchema.parse({ ...base, address: content });
  if (row.kind === AssetKind.Repository)
    return evidenceAssetSchema.parse({
      ...base,
      address: {
        kind: row.kind,
        binding_id: content.binding_id,
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
    storage_binding_id: content.storage_binding_id,
    size: content.size,
    media_type: content.media_type,
    address: {
      kind: row.kind,
      location: content.location,
      ...(content.object_version === undefined
        ? {}
        : { version: content.object_version }),
      ...(content.sha256 === undefined ? {} : { sha256: content.sha256 }),
    },
  });
}

export function evidenceRecord(tx: Transaction, row: EvidenceRow): Evidence {
  return evidenceSchema.parse({
    id: row.id,
    node_id: row.node_id,
    attempt: row.attempt,
    subject: row.subject,
    assets: readAssets(tx, row.id).map(assetRecord),
    provenance: actorSchema.parse(JSON.parse(row.provenance)),
    created_at: row.created_at,
    ...(row.requirement_key === null
      ? {}
      : { requirement_key: row.requirement_key }),
    ...(row.end_state === null ? {} : { end_state: row.end_state }),
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
    .length === NO_REQUIRED_ACTIONS
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
    node_id: row.node_id,
    attempt: assessment.attempt,
    node_revision: assessment.node_revision,
    closing_event: closingEvent(tx, bindings, row, assessment),
    result: row.result,
    assessment_id: row.assessment_id,
    evidence_ids: [
      ...new Set([
        ...stringSet.parse(JSON.parse(row.evidence_ids)),
        ...stringSet.parse(JSON.parse(assessment.evidence_ids)),
      ]),
    ].sort(),
    created_at: row.created_at,
  });
}

export function externalActionRecords(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  attempt: number,
): ExternalAction[] {
  if (attempt === NO_ATTEMPT) return [];
  return actionStatesOf(tx, bindings, nodeId, attempt).map(
    ({ action, request, resolution }) => ({
      node_id: nodeId,
      attempt,
      action,
      requested: request !== null,
      request_evidence_id: request?.id ?? null,
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
      outcome.attempt === NO_ATTEMPT
        ? []
        : readRequests(tx, node.id, outcome.attempt).map((row) =>
            evidenceRecord(tx, row),
          ),
  };
}

export interface PausedDependencies {
  pauseFacts: PauseFacts;
  config: Pick<
    MissionConfig,
    "consecutive_failure_limit" | "further_work_limit"
  >;
}

export function pausedContextOf(
  tx: Transaction,
  dependencies: PausedDependencies,
  node: NodeRow,
): PausedContext {
  assert.equal(node.state, NodeState.Paused);
  const facts = dependencies.pauseFacts.of(tx, node.id, node.attempt);
  const { consecutive_failure_limit: failureLimit, further_work_limit } =
    dependencies.config;
  if (facts.consecutive_failures >= failureLimit)
    return {
      rule: PauseRule.FailureLimit,
      count: facts.consecutive_failures,
      limit: failureLimit,
      last_stop: facts.last_stop,
    };
  if (
    further_work_limit > NO_LIMIT &&
    facts.consecutive_stalls >= further_work_limit
  )
    return {
      rule: PauseRule.FurtherWorkLimit,
      count: facts.consecutive_stalls,
      limit: further_work_limit,
      last_stop: facts.last_stop,
    };
  return {
    rule: PauseRule.Human,
    count: null,
    limit: null,
    last_stop: facts.last_stop,
  };
}

export function assessmentRecord(
  tx: Transaction,
  dependencies: { executionAttribution: ExecutionAttribution },
  row: AssessmentRow,
): Assessment {
  const dependencyOutcomeIds = stringSet.parse(
    JSON.parse(row.dependency_outcome_ids),
  );
  const dependencyNodeIds = [
    ...new Set(
      dependencyOutcomeIds.map((id) => {
        const child = readOutcome(tx, id);
        assert.ok(child);
        return child.node_id;
      }),
    ),
  ].sort();
  const base = {
    id: row.id,
    node_id: row.node_id,
    execution_id: row.execution_id,
    attempt: row.attempt,
    node_revision: row.node_revision,
    evidence_ids: stringSet.parse(JSON.parse(row.evidence_ids)),
    dependency_outcome_ids: dependencyOutcomeIds,
    dependency_node_ids: dependencyNodeIds,
    result: row.result,
    rationale: row.rationale,
    created_at: row.created_at,
    round: readAssessmentRound(tx, row),
  };
  if (row.execution_id === null) {
    assert.ok(row.actor !== null);
    const actor = actorSchema.parse(JSON.parse(row.actor));
    assert.equal(actor.kind, ActorKind.Human);
    return assessmentSchema.parse({
      ...base,
      actor,
      tested_input: null,
      currency: null,
      worker_version: null,
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
      execution_id: row.execution_id,
      client_id: attribution.client_id,
      name: attribution.name,
    },
    tested_input:
      row.tested_input === null
        ? null
        : testedInputSchema.parse(JSON.parse(row.tested_input)),
    currency: currencyOf(tx, row),
    worker_version: attribution.worker_name,
  });
}
