import assert from "node:assert/strict";
import { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ClaimKind,
  NodeState,
  AssetKind,
  AssessmentResult,
  ReleaseObligation,
  Intent,
  TransitionRule,
  type ExecutionActor,
  type ClaimAdmission,
  type NodeTransition,
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
  readBranchStartPoints,
  readReleaseEvidence,
  readAssets,
} from "./record-store.ts";
import { nodeBranchOf } from "../repository/node-branch.ts";
import { nodeClaimable } from "./routing.ts";
import { requireNode } from "./node-read.ts";
import { requireMission } from "./write.ts";
import { nodeTransition, transition } from "./control.ts";
import { currentAssessmentOf } from "./currency.ts";
import { actionStatesOf, eligibleUnrequested } from "./frozen-action.ts";
import { foldExternalState, scheduleDeferredCheck } from "./node-check.ts";
import {
  repositoryBindingIdsOf,
  repositorySetMismatch,
} from "./evidence-content.ts";

const NO_ATTEMPT = 0;
const NO_ELIGIBLE_ACTIONS = 0;
const NO_CONSECUTIVE_FAILURES = 0;
const NO_FURTHER_WORK_LIMIT = 0;
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
    node.state === null ||
    !declaredStates.includes(node.state)
  )
    return null;
  if (!nodeClaimable(tx, node, dependencies.bindings)) return null;
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

export function nodeBranchesOf(
  tx: Transaction,
  keys: readonly { node_id: string; attempt: number }[],
): string[] {
  const starts = readBranchStartPoints(
    tx,
    keys.map((key) => key.node_id),
  );
  return keys.map((key) => {
    const start = (starts.get(key.node_id) ?? []).findLast(
      (attempt) => attempt <= key.attempt,
    );
    assert.ok(start !== undefined);
    return nodeBranchOf(key.node_id, start);
  });
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
  const repositoryIds = repositoryBindingIdsOf(
    tx,
    dependencies.bindings,
    node.id,
    attempt.node_revision,
  );
  return readReleaseEvidence(tx, node.id, attempt.attempt, executionId).some(
    (row) => {
      const assets = readAssets(tx, row.id);
      if (!assets.every((asset) => asset.published_at !== null)) return false;
      if (revision.intent === Intent.Examine)
        return assets.some((asset) => asset.kind === AssetKind.Produced);
      return (
        repositorySetMismatch(
          repositoryIds,
          assets
            .filter((asset) => asset.kind === AssetKind.Repository)
            .map(
              (asset) =>
                z
                  .object({ binding_id: z.string() })
                  .parse(JSON.parse(asset.content)).binding_id,
            ),
        ) === null
      );
    },
  );
}

export function release(
  tx: Transaction,
  dependencies: Dependencies,
  execution: { execution_id: string; node_id: string; attempt: number },
  furtherWork: boolean,
  stalledReleases: number,
  now: number,
): NodeTransition {
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
  const limit = dependencies.config.further_work_limit;
  const stalledOut =
    furtherWork && limit > NO_FURTHER_WORK_LIMIT && stalledReleases >= limit;
  const state =
    node.state === NodeState.Evaluating
      ? NodeState.ExternalRequested
      : stalledOut
        ? NodeState.Paused
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
  if (state === NodeState.ExternalRequested) {
    foldExternalState(
      tx,
      dependencies,
      requireNode(tx, node.id),
      execution.attempt,
      now,
    );
    scheduleDeferredCheck(dependencies, node.id, execution.attempt);
  }
  return nodeTransition(
    tx,
    node.id,
    node.state,
    state === NodeState.Paused
      ? { rule: TransitionRule.FurtherWorkLimit, count: stalledReleases, limit }
      : null,
  );
}

export function failure(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  consecutiveFailures: number,
  now: number,
): NodeTransition {
  const node = requireNode(tx, nodeId);
  assert.ok(
    node.state === NodeState.Executing || node.state === NodeState.Evaluating,
  );
  assert.ok(
    Number.isSafeInteger(consecutiveFailures) &&
      consecutiveFailures >= NO_CONSECUTIVE_FAILURES,
  );
  const limit = dependencies.config.consecutive_failure_limit;
  const state =
    consecutiveFailures >= limit
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
  return nodeTransition(
    tx,
    node.id,
    node.state,
    state === NodeState.Paused
      ? {
          rule: TransitionRule.FailureLimit,
          count: consecutiveFailures,
          limit,
        }
      : null,
  );
}
