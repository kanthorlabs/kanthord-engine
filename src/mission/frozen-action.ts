import assert from "node:assert/strict";
import { z } from "zod";
import type { Transaction } from "../kernel/store.ts";
import {
  ConversationAction,
  EndState,
  ExpectedEndState,
  type ExternalLink,
  externalLinksSchema,
  type FrozenAction,
  frozenActionSchema,
  Intent,
  MissionBindingKind,
  type MissionBindings,
  RepositoryAction,
  Resolution,
} from "./contract.ts";
import { type EvidenceRow, readAttempt, readRequests } from "./record-store.ts";
import { readRevision, type RevisionRow } from "./store.ts";

const bindingIdsSchema = z.array(z.string());
const RESOURCE_KIND_SEPARATOR = ":";
const NO_LINKS = 0;

export function requiredActionsOf(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  nodeRevision: number,
): FrozenAction[] {
  const revision = readRevision(tx, nodeId, nodeRevision);
  assert.ok(revision);
  return actionsOfRevision(tx, bindings, revision);
}

function bindingActionOf(
  tx: Transaction,
  bindings: MissionBindings,
  bindingId: string,
): FrozenAction | null {
  const binding = bindings.getBindingRevision(tx, bindingId);
  assert.ok(binding);
  if (
    binding.resource_identity.split(RESOURCE_KIND_SEPARATOR)[0] !==
    MissionBindingKind.Repository
  )
    return null;
  const policy = bindings.repositoryPolicyOf(tx, bindingId);
  assert.ok(policy && policy.binding_id === bindingId);
  if (policy.action === null) return null;
  return frozenActionSchema.parse({
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
  });
}

function replyActionsOf(
  tx: Transaction,
  bindings: MissionBindings,
  bindingId: string,
  links: readonly ExternalLink[],
): FrozenAction[] {
  const binding = bindings.getBindingRevision(tx, bindingId);
  assert.ok(binding);
  if (
    binding.resource_identity.split(RESOURCE_KIND_SEPARATOR)[0] !==
    MissionBindingKind.Conversation
  )
    return [];
  const policy = bindings.conversationPolicyOf(tx, bindingId);
  if (!policy) return [];
  assert.equal(policy.binding_id, bindingId);
  return links.flatMap((link, position) =>
    link.resource_identity === binding.resource_identity
      ? [
          frozenActionSchema.parse({
            key: `${policy.key}.${position}`,
            binding_id: bindingId,
            action: ConversationAction.Reply,
            expected_end_state: ExpectedEndState.Posted,
            follows: null,
            configuration: { external_link: link },
          }),
        ]
      : [],
  );
}

export function actionsOfRevision(
  tx: Transaction,
  bindings: MissionBindings,
  revision: RevisionRow,
  actions = new Map<string, FrozenAction | null>(),
): FrozenAction[] {
  if (revision.intent === Intent.Examine) return [];
  const found: FrozenAction[] = [];
  const links = externalLinksSchema.parse(JSON.parse(revision.external_links));
  for (const bindingId of bindingIdsSchema.parse(
    JSON.parse(revision.bindings),
  )) {
    let action = actions.get(bindingId);
    if (action === undefined) {
      action = bindingActionOf(tx, bindings, bindingId);
      actions.set(bindingId, action);
    }
    if (action !== null) found.push(action);
    if (links.length > NO_LINKS)
      found.push(...replyActionsOf(tx, bindings, bindingId, links));
  }
  return found.sort((left, right) =>
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
