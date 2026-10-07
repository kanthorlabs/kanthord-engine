import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MissionErrorCode,
  NodeState,
  type MissionBindings,
} from "./contract.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import { readOpenAttempt, readAttempt, readEvidence } from "./record-store.ts";
import { readNode } from "./store.ts";
import type { Dependencies } from "./service.ts";

export const AuthorizationRefusal = {
  ClaimNotLive: "claim_not_live",
  NodeMismatch: "node_mismatch",
  AttemptClosed: "attempt_closed",
  BindingDisabled: "binding_disabled",
  BindingRemoved: "binding_removed",
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
