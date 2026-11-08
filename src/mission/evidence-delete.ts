import assert from "node:assert/strict";
import type { z } from "zod";
import type { HumanActor } from "../kernel/actor.ts";
import { isHumanIdentity } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  type evidenceDeleteSchema,
  Intent,
  MissionErrorCode,
  NodeState,
  RevokeCause,
} from "./contract.ts";
import { isTerminal } from "./admission.ts";
import { Act, type ActFacts, recordAct } from "./act-telemetry.ts";
import {
  holdsStepOne,
  type PendingClose,
  type PendingCloses,
} from "./pending-close.ts";
import type { ExecutionTrace } from "../tracking/contract.ts";
import { objectContentSchema } from "./evidence-content-read.ts";
import { requireTextBound } from "./execution.ts";
import { requireNode } from "./node-read.ts";
import { recordNotFound } from "./record-list.ts";
import {
  type AssetRow,
  deleteAsset,
  deleteEvidence,
  readAssets,
  readEvidence,
  readOpenAttempt,
} from "./record-store.ts";
import {
  endLiveClaim,
  executionEnds,
  HUMAN_PAUSED_STOP,
  keptExecution,
  reportEnds,
  settleClaim,
  stateConflict,
  transition,
} from "./control.ts";
import {
  intentOf,
  type NodeRow,
  readDependencies,
  readMissionNodes,
} from "./store.ts";
import type { Dependencies } from "./service.ts";
import { requireMission } from "./write.ts";
import { authorizeStorage } from "./authorization.ts";

const NO_ATTEMPT = 0;

export type EvidenceDelete = z.infer<typeof evidenceDeleteSchema>;

function deletion(
  caller: Pick<CallerContext, "identity">,
  body: EvidenceDelete,
) {
  assert.ok(isHumanIdentity(caller.identity));
  return {
    account: caller.identity.accountId,
    force: body.force,
    reason: body.reason ?? null,
  };
}

export function admitDelete(
  tx: Transaction,
  node: NodeRow,
  body: EvidenceDelete,
) {
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expected_mission_version,
  );
  if (body.force) return mission;
  const nodes = new Map(
    readMissionNodes(tx, node.mission_id).map((row) => [row.id, row]),
  );
  const dependents = readDependencies(tx, node.mission_id)
    .filter((edge) => edge.depends_on === node.id)
    .map((edge) => nodes.get(edge.dependent))
    .filter(
      (row) => row !== undefined && intentOf(tx, row.id) === Intent.Examine,
    );
  if (![node, ...dependents].every((row) => isTerminal(row?.state ?? null)))
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.EvidenceRemoveNodeLive,
      "The evidence node or a direct examine dependent is live.",
    );
  return mission;
}

export function prepareAssetDelete(
  tx: Transaction,
  dependencies: Dependencies,
  assetId: string,
  body: EvidenceDelete,
) {
  const asset = tx.database
    .prepare("SELECT * FROM mission_evidence_asset WHERE id = ?")
    .get(assetId) as AssetRow | undefined;
  if (!asset) recordNotFound();
  const evidence = readEvidence(tx, asset.evidence_id);
  assert.ok(evidence);
  if (evidence.requirement_key !== null && asset.kind === AssetKind.Platform)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.EvidenceRequestAssetRefused,
      "A request platform asset cannot be deleted separately.",
    );
  const mission = admitDelete(tx, requireNode(tx, evidence.node_id), body);
  if (body.reason !== undefined)
    requireTextBound("reason", body.reason, dependencies.config.text_max_bytes);
  return { asset, evidence, mission };
}

export async function deleteObject(
  dependencies: Dependencies,
  caller: Pick<CallerContext, "context" | "identity">,
  asset: AssetRow,
): Promise<void> {
  assert.ok(caller.identity);
  if (asset.kind !== AssetKind.Object) return;
  const content = objectContentSchema.parse(JSON.parse(asset.content));
  dependencies.store.transaction((tx) =>
    authorizeStorage(tx, dependencies.bindings, content.storage_binding_id),
  );
  await dependencies.intakeStorage.delete(
    { context: caller.context, identity: caller.identity },
    asset.id,
  );
}

export async function deleteEvidenceAsset(
  dependencies: Dependencies,
  caller: CallerContext,
  assetId: string,
  body: EvidenceDelete,
) {
  const prepared = dependencies.store.transaction((tx) =>
    prepareAssetDelete(tx, dependencies, assetId, body),
  );
  await deleteObject(dependencies, caller, prepared.asset);
  const result = caller.commit((tx) => {
    prepareAssetDelete(tx, dependencies, assetId, body);
    deleteAsset(tx, assetId);
    return null;
  });
  dependencies.logger.info(
    { asset_id: assetId, ...deletion(caller, body) },
    "evidence asset deleted",
  );
  return result;
}

export function prepareEvidenceDelete(
  tx: Transaction,
  dependencies: Dependencies,
  evidenceId: string,
  body: EvidenceDelete,
) {
  const evidence = readEvidence(tx, evidenceId);
  if (!evidence) recordNotFound();
  if (evidence.requirement_key !== null && !body.force)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.EvidenceRequestForceRequired,
      "A request evidence requires force to delete.",
    );
  const node = requireNode(tx, evidence.node_id);
  const mission = admitDelete(tx, node, body);
  if (body.reason !== undefined)
    requireTextBound("reason", body.reason, dependencies.config.text_max_bytes);
  return { evidence, node, mission, assets: readAssets(tx, evidenceId) };
}

function holdsOpenAttempt(
  tx: Transaction,
  body: EvidenceDelete,
  evidence: NonNullable<ReturnType<typeof readEvidence>>,
  node: NodeRow,
): boolean {
  return (
    body.force &&
    evidence.requirement_key !== null &&
    readOpenAttempt(tx, node.id)?.attempt === evidence.attempt &&
    node.state !== NodeState.Paused &&
    !isTerminal(node.state)
  );
}

export async function removeEvidence(
  dependencies: Dependencies,
  caller: CallerContext,
  evidenceId: string,
  body: EvidenceDelete,
  actor: HumanActor,
  closes: PendingCloses,
) {
  const prepared = dependencies.store.transaction((tx) => {
    const found = prepareEvidenceDelete(tx, dependencies, evidenceId, body);
    const held =
      holdsOpenAttempt(tx, body, found.evidence, found.node) &&
      keptExecution(tx, dependencies, found.node, Date.now()) !== null;
    return { ...found, held };
  });
  if (!prepared.held)
    for (const asset of prepared.assets)
      await deleteObject(dependencies, caller, asset);
  const ends = executionEnds();
  const kept: {
    facts: ActFacts | null;
    held: { execution_id: string; runtime_identity: string } | null;
  } = { facts: null, held: null };
  const result = caller.commit((tx) => {
    const now = Date.now();
    const { evidence, node, mission } = prepareEvidenceDelete(
      tx,
      dependencies,
      evidenceId,
      body,
    );
    const hold = holdsOpenAttempt(tx, body, evidence, node);
    let from = node.state;
    let revoked: ExecutionTrace | null = null;
    if (hold) {
      settleClaim(tx, dependencies.schedulerClaims, node.id, now, ends);
      const settled = requireNode(tx, node.id);
      from = settled.state;
      kept.held = keptExecution(tx, dependencies, settled, now);
      if (kept.held === null)
        revoked =
          endLiveClaim(
            tx,
            dependencies,
            settled,
            now,
            RevokeCause.Human,
            null,
            ends,
            HUMAN_PAUSED_STOP,
          )?.execution.trace ?? null;
      transition(tx, dependencies, mission, settled, NodeState.Paused, now);
    }
    if (kept.held === null) deleteEvidence(tx, evidenceId);
    const current = requireNode(tx, node.id);
    assert.ok(from && current.state);
    kept.facts = {
      project_id: mission.project_id,
      node_id: node.id,
      attempt: current.attempt ?? NO_ATTEMPT,
      acted_at: now,
      mission_version: requireMission(tx, mission.id).version,
      from,
      to: current.state,
      reason: body.reason ?? null,
      revoked,
      evidence_id: evidenceId,
      lead_time_ms: null,
    };
    return null;
  });
  const { facts, held } = kept;
  assert.ok(facts);
  reportEnds(dependencies, ends);
  const trace = recordAct(dependencies, Act.DeleteEvidence, facts);
  if (held === null)
    dependencies.logger.info(
      { evidence_id: evidenceId, ...deletion(caller, body) },
      "evidence deleted",
    );
  else {
    assert.ok(caller.identity);
    closes.add({
      act: Act.DeleteEvidence,
      execution_id: held.execution_id,
      node_id: facts.node_id,
      attempt: facts.attempt,
      actor,
      trace,
      body,
      evidence_id: evidenceId,
      identity: caller.identity,
    });
    dependencies.workerStopOrders.sendStopOrder(
      held.execution_id,
      held.runtime_identity,
      "human_paused",
    );
  }
  dependencies.wakeup.wake(prepared.mission.project_id);
  return result;
}

type PendingEvidenceDelete = Extract<
  PendingClose,
  { act: typeof Act.DeleteEvidence }
>;

function currentBody(
  tx: Transaction,
  pending: PendingEvidenceDelete,
): EvidenceDelete {
  const node = requireNode(tx, pending.node_id);
  return {
    ...pending.body,
    expected_mission_version: requireMission(tx, node.mission_id).version,
  };
}

export async function finishEvidenceDelete(
  dependencies: Dependencies,
  pending: PendingEvidenceDelete,
): Promise<void> {
  const caller = {
    context: dependencies.shutdown ?? background,
    identity: pending.identity,
  };
  const prepared = dependencies.store.transaction((tx) =>
    prepareEvidenceDelete(
      tx,
      dependencies,
      pending.evidence_id,
      currentBody(tx, pending),
    ),
  );
  for (const asset of prepared.assets)
    await deleteObject(dependencies, caller, asset);
  const now = Date.now();
  const facts = dependencies.store.transaction((tx) => {
    if (!holdsStepOne(tx, pending))
      stateConflict(requireNode(tx, pending.node_id));
    prepareEvidenceDelete(
      tx,
      dependencies,
      pending.evidence_id,
      currentBody(tx, pending),
    );
    deleteEvidence(tx, pending.evidence_id);
    return {
      project_id: prepared.mission.project_id,
      node_id: pending.node_id,
      attempt: pending.attempt,
      acted_at: now,
      mission_version: requireMission(tx, prepared.mission.id).version,
      from: NodeState.Paused,
      to: NodeState.Paused,
      reason: pending.body.reason ?? null,
      revoked: null,
      evidence_id: pending.evidence_id,
      lead_time_ms: null,
    };
  });
  recordAct(dependencies, Act.DeleteEvidence, facts);
  dependencies.logger.info(
    { evidence_id: pending.evidence_id, ...deletion(caller, pending.body) },
    "evidence deleted",
  );
  dependencies.wakeup.wake(prepared.mission.project_id);
}
