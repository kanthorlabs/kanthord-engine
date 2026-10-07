import assert from "node:assert/strict";
import { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ClaimKind,
  NodeKind,
  NodeState,
  AssetKind,
  AssessmentResult,
  ReleaseObligation,
  MissionBindingKind,
  type ExecutionActor,
  type ClaimAdmission,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import {
  readNode,
  readCurrentRevision,
  readRevision,
  setNodeState,
  type NodeRow,
} from "./store.ts";
import {
  readOpenAttempt,
  openAttempt,
  readReleaseEvidence,
  readAssets,
} from "./record-store.ts";
import { claimableMap } from "./routing.ts";
import { requireNode } from "./node-read.ts";
import { requireMission } from "./write.ts";
import { transition } from "./control.ts";
import { currentAssessmentOf } from "./currency.ts";
import { actionStatesOf, eligibleUnrequested } from "./frozen-action.ts";

const NO_ATTEMPT = 0;
const RESOURCE_KIND_SEGMENT = 0;
const NO_ELIGIBLE_ACTIONS = 0;
const NO_CONSECUTIVE_LOSSES = 0;
const RELEASE_UNMET = "mission.release.obligation_unmet";

export function claim(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  declaredStates: readonly NodeState[],
  opener: ExecutionActor,
  now: number,
): ClaimAdmission | null {
  const node = readNode(tx, nodeId);
  if (
    node === null ||
    node.retired_at !== null ||
    node.kind === NodeKind.Task ||
    node.state === null ||
    !declaredStates.includes(node.state)
  )
    return null;
  if (!claimableMap(tx, node.mission_id, dependencies.bindings).get(nodeId))
    return null;
  assert.ok(node.attempt !== null);
  const revision = readCurrentRevision(tx, nodeId);
  assert.ok(revision);
  const attempt =
    node.attempt === NO_ATTEMPT
      ? openAttempt(tx, nodeId, revision.revision, opener, now)
      : readOpenAttempt(tx, nodeId);
  assert.ok(attempt);
  const kind =
    node.state === NodeState.Available ? ClaimKind.Steps : ClaimKind.Evaluation;
  setNodeState(
    tx,
    nodeId,
    kind === ClaimKind.Steps ? NodeState.Executing : NodeState.Evaluating,
  );
  dependencies.workQueue.delete(tx, nodeId);
  return {
    kind,
    project_id: requireMission(tx, node.mission_id).project_id,
    attempt: attempt.attempt,
    node_revision: attempt.node_revision,
  };
}

function refuse(obligation: ReleaseObligation): never {
  throw new OperationError(
    HttpStatus.Conflict,
    RELEASE_UNMET,
    "Release obligation is unmet.",
    { obligation },
  );
}

function hasEvidence(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  executionId: string,
): boolean {
  const attempt = readOpenAttempt(tx, node.id);
  assert.ok(attempt);
  const revision = readRevision(tx, node.id, attempt.node_revision);
  assert.ok(revision);
  const repositoryIds = z
    .array(z.string())
    .parse(JSON.parse(revision.bindings))
    .filter(
      (id) =>
        dependencies.bindings
          .getBindingRevision(tx, id)
          ?.resource_identity.split(":")[RESOURCE_KIND_SEGMENT] ===
        MissionBindingKind.Repository,
    );
  return readReleaseEvidence(tx, node.id, attempt.attempt, executionId).some(
    (row) => {
      const assets = readAssets(tx, row.id);
      if (!assets.every((asset) => asset.published_at !== null)) return false;
      return assets.some((asset) =>
        node.kind === NodeKind.Initiative
          ? asset.kind === AssetKind.Produced
          : asset.kind === AssetKind.Repository &&
            repositoryIds.includes(
              z
                .object({ binding_id: z.string() })
                .parse(JSON.parse(asset.content)).binding_id,
            ),
      );
    },
  );
}

export function release(
  tx: Transaction,
  dependencies: Dependencies,
  execution: { execution_id: string; node_id: string; attempt: number },
  furtherWork: boolean,
  now: number,
): void {
  const node = requireNode(tx, execution.node_id);
  assert.ok(
    node.state === NodeState.Executing || node.state === NodeState.Evaluating,
  );
  assert.equal(node.attempt, execution.attempt);
  assert.equal(readOpenAttempt(tx, node.id)?.attempt, execution.attempt);
  if (
    node.state === NodeState.Executing &&
    !furtherWork &&
    !hasEvidence(tx, dependencies, node, execution.execution_id)
  )
    refuse(ReleaseObligation.Evidence);
  if (node.state === NodeState.Evaluating) {
    if (
      currentAssessmentOf(tx, node.id, execution.attempt)?.result !==
      AssessmentResult.Success
    )
      refuse(ReleaseObligation.Assessment);
    if (
      eligibleUnrequested(
        actionStatesOf(tx, dependencies.bindings, node.id, execution.attempt),
      ).length > NO_ELIGIBLE_ACTIONS
    )
      refuse(ReleaseObligation.Request);
  }
  const state =
    node.state === NodeState.Evaluating
      ? NodeState.ExternalRequested
      : furtherWork
        ? NodeState.Available
        : NodeState.Waiting;
  transition(
    tx,
    dependencies,
    requireMission(tx, node.mission_id),
    node,
    state,
    now,
  );
}

export function loss(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  consecutiveLosses: number,
  now: number,
): void {
  const node = requireNode(tx, nodeId);
  assert.ok(
    node.state === NodeState.Executing || node.state === NodeState.Evaluating,
  );
  assert.ok(
    Number.isSafeInteger(consecutiveLosses) &&
      consecutiveLosses > NO_CONSECUTIVE_LOSSES,
  );
  const state =
    consecutiveLosses >= dependencies.config.consecutive_loss_limit
      ? NodeState.Paused
      : node.state === NodeState.Executing
        ? NodeState.Available
        : NodeState.Waiting;
  transition(
    tx,
    dependencies,
    requireMission(tx, node.mission_id),
    node,
    state,
    now,
  );
}
