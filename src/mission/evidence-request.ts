import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  ConversationAction,
  type EvidenceRequest,
  type FrozenAction,
  MissionErrorCode,
  PlatformAddressKind,
  RepositoryAction,
} from "./contract.ts";
import { assessedCommitOf, landsByHuman } from "./authorization.ts";
import { currentAssessmentOf } from "./currency.ts";
import {
  admitExecution,
  requireEvaluationClaim,
  requireTextBound,
} from "./execution.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import { gateFilesOf } from "./gate-files.ts";
import { evidenceRecord } from "./record-read.ts";
import { insertEvidence, readEvidence, readRequests } from "./record-store.ts";
import type { Dependencies } from "./service.ts";

function addressKindOf(action: FrozenAction) {
  if (action.action === ConversationAction.Reply)
    return PlatformAddressKind.Comment;
  return action.action === RepositoryAction.PullRequest
    ? PlatformAddressKind.PullRequest
    : PlatformAddressKind.BranchPush;
}

interface AddressCheck {
  nodeId: string;
  attempt: number;
  action: FrozenAction;
  body: EvidenceRequest;
  resourceIdentity: string;
}

function baseBranchOf(action: FrozenAction): string | null {
  return action.action === ConversationAction.Reply
    ? null
    : action.configuration.base_branch;
}

function isContainedLanding(
  check: AddressCheck,
  baseBranch: string | null,
): boolean {
  const { action, body } = check;
  return (
    action.action === RepositoryAction.PullRequest &&
    body.address.kind === PlatformAddressKind.BranchPush &&
    body.address.branch === baseBranch
  );
}

function isHumanLandingMismatch(
  tx: Transaction,
  check: AddressCheck,
  baseBranch: string | null,
): boolean {
  const { nodeId, attempt, action, body } = check;
  const humanLanding = landsByHuman(
    action,
    gateFilesOf(currentAssessmentOf(tx, nodeId, attempt), action.binding_id),
  );
  return (
    humanLanding &&
    body.address.kind === PlatformAddressKind.BranchPush &&
    (body.address.branch !== baseBranch ||
      body.address.commit !==
        assessedCommitOf(tx, nodeId, attempt, action.binding_id))
  );
}

function requireRequestAddress(tx: Transaction, check: AddressCheck): void {
  const { action, body } = check;
  const kind = addressKindOf(action);
  const baseBranch = baseBranchOf(action);
  const containedLanding = isContainedLanding(check, baseBranch);
  const humanLandingMismatch = isHumanLandingMismatch(tx, check, baseBranch);
  if (
    (body.address.kind !== kind && !containedLanding) ||
    body.address.resource_identity !== check.resourceIdentity ||
    humanLandingMismatch
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.RequestAddressMismatch,
      "Request address does not match the required action.",
      { requirement_key: body.requirement_key },
    );
}

export function requestEvidence(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  nodeId: string,
  body: EvidenceRequest,
  now: number,
) {
  const admitted = admitExecution(tx, dependencies, claim, nodeId, body, now);
  requireEvaluationClaim(admitted.node);
  requireTextBound("subject", body.subject, dependencies.config.text_max_bytes);
  const action = requiredActionsOf(
    tx,
    dependencies.bindings,
    nodeId,
    claim.pinnedRevision,
  ).find((item) => item.key === body.requirement_key);
  if (!action)
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.RequestRequirementUnknown,
      "Required external action not found.",
    );
  const binding = dependencies.bindings.getBindingRevision(
    tx,
    action.binding_id,
  );
  assert.ok(binding);
  requireRequestAddress(tx, {
    nodeId,
    attempt: claim.attempt,
    action,
    body,
    resourceIdentity: binding.resource_identity,
  });
  if (
    readRequests(tx, nodeId, claim.attempt).some(
      (request) => request.requirement_key === body.requirement_key,
    )
  )
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RequestAlreadyRequested,
      "The external action has already been requested.",
    );
  const evidenceId = createIdentity("evidence");
  insertEvidence(
    tx,
    {
      id: evidenceId,
      node_id: nodeId,
      attempt: claim.attempt,
      subject: body.subject,
      requirement_key: body.requirement_key,
      end_state: null,
      verification: null,
      provenance: canonicalJSON(admitted.actor),
      created_at: now,
    },
    [
      {
        id: createIdentity("evidence_asset"),
        evidence_id: evidenceId,
        kind: AssetKind.Platform,
        content: canonicalJSON(body.address),
        published_at: now,
        expired_at: null,
      },
    ],
  );
  const row = readEvidence(tx, evidenceId);
  assert.ok(row);
  return evidenceRecord(tx, row);
}
