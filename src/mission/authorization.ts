import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  IdentityKind,
  isServiceIdentity,
  type CallerIdentity,
  type MachineIdentity,
} from "../kernel/caller.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssessmentResult,
  AssetKind,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
  platformAddressSchema,
  testedInputSchema,
  type ActionFacts,
  type Authorized,
  type FrozenAction,
  type MissionBindings,
  type PlatformAddress,
  type PullRequestAddress,
  type RepositoryFacts,
  type RequestFacts,
} from "./contract.ts";
import { currentAssessmentOf } from "./currency.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import {
  readOpenAttempt,
  readAttempt,
  readEvidence,
  readAssets,
} from "./record-store.ts";
import { readNode } from "./store.ts";
import type { Dependencies } from "./service.ts";

export const AuthorizationRefusal = {
  ClaimNotLive: "claim_not_live",
  NodeMismatch: "node_mismatch",
  AttemptClosed: "attempt_closed",
  BindingDisabled: "binding_disabled",
  BindingRemoved: "binding_removed",
  ServiceMismatch: "service_mismatch",
} as const;
type Refusal = (typeof AuthorizationRefusal)[keyof typeof AuthorizationRefusal];

export function authorizationRefused(reason: Refusal): never {
  throw new OperationError(
    HttpStatus.Forbidden,
    MissionErrorCode.AuthorizationRefused,
    "The facility refuses the operation.",
    { reason },
  );
}

export function authorizeBinding(
  tx: Transaction,
  bindings: MissionBindings,
  bindingId: string,
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(bindingId);
  const binding = bindings.getBindingRevision(tx, bindingId);
  if (!binding || binding.tombstone)
    authorizationRefused(AuthorizationRefusal.BindingRemoved);
  if (binding.disabled)
    authorizationRefused(AuthorizationRefusal.BindingDisabled);
  return binding;
}

export function authorizeClaim(
  tx: Transaction,
  dependencies: Pick<Dependencies, "schedulerClaims">,
  claim: ExecutionClaim,
  nodeId: string,
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(claim.executionId);
  const live = dependencies.schedulerClaims.liveExecutionOf(
    tx,
    claim.nodeId,
    Date.now(),
  );
  if (
    !live ||
    live.execution_id !== claim.executionId ||
    live.runtime_identity !== claim.runtimeIdentity
  )
    authorizationRefused(AuthorizationRefusal.ClaimNotLive);
  if (claim.nodeId !== nodeId || live.pinned_revision !== claim.pinnedRevision)
    authorizationRefused(AuthorizationRefusal.NodeMismatch);
  const attempt = readOpenAttempt(tx, nodeId);
  if (
    !attempt ||
    attempt.attempt !== claim.attempt ||
    live.attempt !== claim.attempt
  )
    authorizationRefused(AuthorizationRefusal.AttemptClosed);
  return attempt;
}

export function authorizeAction(
  tx: Transaction,
  dependencies: Pick<Dependencies, "schedulerClaims" | "bindings">,
  claim: ExecutionClaim,
  key: string,
) {
  const attempt = authorizeClaim(tx, dependencies, claim, claim.nodeId);
  const node = readNode(tx, claim.nodeId);
  assert.ok(node);
  if (node.state !== NodeState.Evaluating)
    authorizationRefused(AuthorizationRefusal.ClaimNotLive);
  const action = requiredActionsOf(
    tx,
    dependencies.bindings,
    node.id,
    attempt.node_revision,
  ).find((item) => item.key === key);
  if (!action) authorizationRefused(AuthorizationRefusal.NodeMismatch);
  authorizeBinding(tx, dependencies.bindings, action.binding_id);
  return action;
}

export function authorizeStorage(
  tx: Transaction,
  bindings: MissionBindings,
  bindingId: string,
) {
  const revision = authorizeBinding(tx, bindings, bindingId);
  const binding = bindings.storageBindingOf(tx, revision.binding_id);
  assert.ok(binding);
  assert.equal(binding.project_id, revision.project_id);
  return binding;
}

export function authorizeRequest(
  tx: Transaction,
  dependencies: Pick<Dependencies, "schedulerClaims" | "bindings">,
  evidenceId: string,
  claim?: ExecutionClaim,
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(evidenceId);
  const evidence = readEvidence(tx, evidenceId);
  if (!evidence || !evidence.requirement_key)
    authorizationRefused(AuthorizationRefusal.NodeMismatch);
  if (claim) authorizeClaim(tx, dependencies, claim, evidence.node_id);
  const attempt = readAttempt(tx, evidence.node_id, evidence.attempt);
  assert.ok(attempt);
  const action = requiredActionsOf(
    tx,
    dependencies.bindings,
    evidence.node_id,
    attempt.node_revision,
  ).find((item) => item.key === evidence.requirement_key);
  assert.ok(action);
  authorizeBinding(tx, dependencies.bindings, action.binding_id);
  return action;
}

type AuthorizationDependencies = Pick<
  Dependencies,
  "schedulerClaims" | "bindings"
>;
const SINGLE_PLATFORM_ASSET = 1;

function repositoryOf(
  tx: Transaction,
  bindings: MissionBindings,
  action: FrozenAction,
) {
  const policy = bindings.repositoryPolicyOf(tx, action.binding_id);
  const revision = bindings.getBindingRevision(tx, action.binding_id);
  assert.ok(policy && revision);
  assert.equal(policy.binding_id, action.binding_id);
  assert.equal(policy.base_branch, action.configuration.base_branch);
  const repository: RepositoryFacts = {
    binding_id: action.binding_id,
    address: policy.address,
    resource_identity: revision.resource_identity,
    base_branch: policy.base_branch,
  };
  return { policy, repository };
}

function platformAddressOf(
  tx: Transaction,
  evidenceId: string,
): PlatformAddress {
  const assets = readAssets(tx, evidenceId).filter(
    (asset) => asset.kind === AssetKind.Platform,
  );
  assert.equal(assets.length, SINGLE_PLATFORM_ASSET);
  return platformAddressSchema.parse(JSON.parse(assets[0]!.content));
}

function assessedCommitOf(
  tx: Transaction,
  claim: ExecutionClaim,
  bindingId: string,
): string | null {
  assert.ok(Number.isSafeInteger(claim.attempt));
  assert.ok(bindingId);
  const assessment = currentAssessmentOf(tx, claim.nodeId, claim.attempt);
  if (!assessment || assessment.result !== AssessmentResult.Success)
    authorizationRefused(AuthorizationRefusal.ClaimNotLive);
  assert.ok(assessment.tested_input !== null);
  const input = testedInputSchema.parse(JSON.parse(assessment.tested_input));
  const addresses = Array.isArray(input) ? input : [input];
  const tested = addresses.find(
    (address) =>
      address.kind === AssetKind.Repository && address.binding_id === bindingId,
  );
  return tested?.kind === AssetKind.Repository ? tested.commit : null;
}

function reusedAddressOf(
  tx: Transaction,
  nodeId: string,
  evidenceId: string,
  resourceIdentity: string,
): PullRequestAddress {
  assert.ok(nodeId);
  assert.ok(resourceIdentity);
  const evidence = readEvidence(tx, evidenceId);
  if (!evidence || evidence.node_id !== nodeId || !evidence.requirement_key)
    authorizationRefused(AuthorizationRefusal.NodeMismatch);
  const address = platformAddressOf(tx, evidenceId);
  if (
    address.kind !== PlatformAddressKind.PullRequest ||
    address.resource_identity !== resourceIdentity
  )
    authorizationRefused(AuthorizationRefusal.NodeMismatch);
  return address;
}

export function authorizeFrozenAction(
  tx: Transaction,
  dependencies: AuthorizationDependencies,
  identity: MachineIdentity,
  claim: ExecutionClaim,
  input: { key: string; commit: string; reusedEvidenceId: string | null },
): Authorized<ActionFacts> {
  assert.equal(identity.kind, IdentityKind.Client);
  assert.equal(identity.projectId, claim.projectId);
  const action = authorizeAction(tx, dependencies, claim, input.key);
  const commit = assessedCommitOf(tx, claim, action.binding_id);
  if (commit === null || commit !== input.commit)
    authorizationRefused(AuthorizationRefusal.NodeMismatch);
  const { policy, repository } = repositoryOf(
    tx,
    dependencies.bindings,
    action,
  );
  const reused =
    input.reusedEvidenceId === null
      ? null
      : reusedAddressOf(
          tx,
          claim.nodeId,
          input.reusedEvidenceId,
          repository.resource_identity,
        );
  return {
    credential:
      action.action === RepositoryAction.PullRequest ? policy.credential : null,
    platform: policy.platform,
    project_id: policy.project_id,
    facts: {
      frozen_action: action,
      repository,
      snapshot_commit: commit,
      reused_address: reused,
    },
  };
}

function authorizeRequestOf(
  tx: Transaction,
  dependencies: AuthorizationDependencies,
  identity: CallerIdentity,
  evidenceId: string,
  claim: ExecutionClaim | null,
): FrozenAction {
  if (identity.kind === IdentityKind.Service) {
    assert.ok(isServiceIdentity(identity));
    assert.equal(claim, null);
    if (identity.service !== MISSION_SERVICE_NAME)
      authorizationRefused(AuthorizationRefusal.ServiceMismatch);
    return authorizeRequest(tx, dependencies, evidenceId);
  }
  assert.equal(identity.kind, IdentityKind.Client);
  if (!claim) authorizationRefused(AuthorizationRefusal.ClaimNotLive);
  assert.equal(identity.projectId, claim.projectId);
  return authorizeRequest(tx, dependencies, evidenceId, claim);
}

export function authorizeRequestEvidence(
  tx: Transaction,
  dependencies: AuthorizationDependencies,
  identity: CallerIdentity,
  evidenceId: string,
  claim: ExecutionClaim | null,
): Authorized<RequestFacts> {
  assert.ok(tx.database.isTransaction);
  assert.ok(evidenceId);
  const action = authorizeRequestOf(
    tx,
    dependencies,
    identity,
    evidenceId,
    claim,
  );
  const { policy, repository } = repositoryOf(
    tx,
    dependencies.bindings,
    action,
  );
  const address = platformAddressOf(tx, evidenceId);
  assert.equal(address.resource_identity, repository.resource_identity);
  return {
    credential:
      address.kind === PlatformAddressKind.PullRequest
        ? policy.credential
        : null,
    platform: policy.platform,
    project_id: policy.project_id,
    facts: { frozen_action: action, address, repository },
  };
}
