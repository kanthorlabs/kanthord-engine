import assert from "node:assert/strict";
import type { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  NodeState,
  MissionErrorCode,
  type evidenceDeleteSchema,
} from "./contract.ts";
import { isTerminal } from "./admission.ts";
import { keyOfLocation } from "./evidence-content.ts";
import { objectContentSchema } from "./evidence-content-read.ts";
import { requireTextBound } from "./execution.ts";
import { requireNode } from "./node-read.ts";
import { recordNotFound } from "./record-list.ts";
import {
  deleteAsset,
  deleteEvidence,
  readAssets,
  readEvidence,
  readOpenAttempt,
  type AssetRow,
} from "./record-store.ts";
import { endLiveClaim, transition } from "./control.ts";
import { readMissionNodes, type NodeRow } from "./store.ts";
import type { Dependencies } from "./service.ts";
import { requireMission } from "./write.ts";
import { authorizeStorage } from "./authorization.ts";

export type EvidenceDelete = z.infer<typeof evidenceDeleteSchema>;

export function admitDelete(
  tx: Transaction,
  node: NodeRow,
  body: EvidenceDelete,
) {
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expectedMissionVersion,
  );
  if (body.force) return mission;
  const remaining = new Map(
    readMissionNodes(tx, node.mission_id).map((row) => [row.id, row]),
  );
  let current: NodeRow = node;
  const bound = remaining.size;
  for (let index = 0; index < bound; index++) {
    assert.ok(remaining.delete(current.id));
    if (!isTerminal(current.state))
      throw new OperationError(
        HttpStatus.Conflict,
        MissionErrorCode.EvidenceRemoveNodeLive,
        "The evidence node or an ancestor is live.",
      );
    if (current.parent_id === null) return mission;
    const parent = remaining.get(current.parent_id);
    assert.ok(parent);
    current = parent;
  }
  assert.fail("Containment must reach its root.");
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
    requireTextBound("reason", body.reason, dependencies.config.textMaxBytes);
  return { asset, evidence, mission };
}

export async function deleteObject(
  dependencies: Dependencies,
  caller: CallerContext,
  asset: AssetRow,
): Promise<void> {
  assert.ok(caller.identity);
  if (asset.kind !== AssetKind.Object) return;
  const content = objectContentSchema.parse(JSON.parse(asset.content));
  const binding = dependencies.store.transaction((tx) =>
    authorizeStorage(tx, dependencies.bindings, content.storageBindingId),
  );
  assert.ok(binding);
  await dependencies.intakeStorage.delete(
    { context: caller.context, identity: caller.identity },
    binding,
    keyOfLocation(binding, content.location),
    content.objectVersion ?? null,
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
  return caller.commit((tx) => {
    prepareAssetDelete(tx, dependencies, assetId, body);
    deleteAsset(tx, assetId);
    return null;
  });
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
    requireTextBound("reason", body.reason, dependencies.config.textMaxBytes);
  return { evidence, node, mission, assets: readAssets(tx, evidenceId) };
}

export async function removeEvidence(
  dependencies: Dependencies,
  caller: CallerContext,
  evidenceId: string,
  body: EvidenceDelete,
) {
  const prepared = dependencies.store.transaction((tx) =>
    prepareEvidenceDelete(tx, dependencies, evidenceId, body),
  );
  for (const asset of prepared.assets)
    await deleteObject(dependencies, caller, asset);
  const result = caller.commit((tx) => {
    const now = Date.now();
    const { evidence, node, mission } = prepareEvidenceDelete(
      tx,
      dependencies,
      evidenceId,
      body,
    );
    const hold =
      body.force &&
      evidence.requirement_key !== null &&
      readOpenAttempt(tx, node.id)?.attempt === evidence.attempt &&
      node.state !== NodeState.Paused &&
      !isTerminal(node.state);
    deleteEvidence(tx, evidenceId);
    if (hold) {
      dependencies.schedulerClaims.settle(tx, node.id, now);
      const settled = requireNode(tx, node.id);
      endLiveClaim(tx, dependencies, settled, now);
      transition(tx, dependencies, mission, settled, NodeState.Paused, now);
    }
    return null;
  });
  dependencies.wakeup.wake(prepared.mission.projectId);
  return result;
}
