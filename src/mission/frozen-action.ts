import assert from "node:assert/strict";
import { z } from "zod";
import type { Transaction } from "../kernel/store.ts";
import {
  EndState,
  ExpectedEndState,
  MissionBindingKind,
  NodeKind,
  RepositoryAction,
  Resolution,
  frozenActionSchema,
  type FrozenAction,
  type MissionBindings,
} from "./contract.ts";
import { readAttempt, readRequests, type EvidenceRow } from "./record-store.ts";
import { readNode, readRevision } from "./store.ts";

const bindingIdsSchema = z.array(z.string());
const RESOURCE_KIND_SEPARATOR = ":";

export function requiredActionsOf(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  nodeRevision: number,
): FrozenAction[] {
  const node = readNode(tx, nodeId);
  assert.ok(node && node.kind !== NodeKind.Task);
  const revision = readRevision(tx, nodeId, nodeRevision);
  assert.ok(revision);
  if (node.kind === NodeKind.Initiative) return [];
  const actions: FrozenAction[] = [];
  for (const bindingId of bindingIdsSchema.parse(
    JSON.parse(revision.bindings),
  )) {
    const binding = bindings.getBindingRevision(tx, bindingId);
    assert.ok(binding);
    if (
      binding.resource_identity.split(RESOURCE_KIND_SEPARATOR)[0] !==
      MissionBindingKind.Repository
    )
      continue;
    const policy = bindings.repositoryPolicyOf(tx, bindingId);
    assert.ok(policy && policy.binding_id === bindingId);
    if (policy.action === null) continue;
    actions.push(
      frozenActionSchema.parse({
        key: `${policy.name}.${policy.action}`,
        binding_id: bindingId,
        action: policy.action,
        expected_end_state:
          policy.action === RepositoryAction.PullRequest
            ? ExpectedEndState.PullRequestMerged
            : ExpectedEndState.BaseBranchPushed,
        follows: null,
        configuration: {
          base_branch: policy.base_branch,
          landing: policy.landing,
        },
      }),
    );
  }
  return actions.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

export type ActionState = {
  action: FrozenAction;
  request: EvidenceRow | null;
  resolution: Resolution;
};

export function actionStatesOf(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  attempt: number,
): ActionState[] {
  const row = readAttempt(tx, nodeId, attempt);
  assert.ok(row);
  const requests = readRequests(tx, nodeId, attempt);
  const byKey = new Map(
    requests.map((request) => [request.requirement_key, request]),
  );
  assert.equal(byKey.size, requests.length);
  return requiredActionsOf(tx, bindings, nodeId, row.node_revision).map(
    (action) => {
      const request = byKey.get(action.key) ?? null;
      if (!request)
        return { action, request, resolution: Resolution.Unrequested };
      if (request.end_state === null)
        return { action, request, resolution: Resolution.Unresolved };
      return {
        action,
        request,
        resolution:
          request.end_state === EndState.Expected
            ? Resolution.ExpectedEnd
            : Resolution.OtherEnd,
      };
    },
  );
}

export function eligibleUnrequested(
  states: readonly ActionState[],
): ActionState[] {
  const byKey = new Map(states.map((state) => [state.action.key, state]));
  return states.filter(
    ({ action, resolution }) =>
      resolution === Resolution.Unrequested &&
      (action.follows === null ||
        byKey.get(action.follows)?.resolution === Resolution.ExpectedEnd),
  );
}

export function unresolvedKeys(states: readonly ActionState[]): string[] {
  return states
    .filter((state) => state.resolution === Resolution.Unresolved)
    .map((state) => state.action.key)
    .sort();
}
