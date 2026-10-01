import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  MissionErrorCode,
  PlatformAddressKind,
  RepositoryAction,
  type EvidenceRequest,
} from "./contract.ts";
import {
  admitExecution,
  requireEvaluationClaim,
  requireTextBound,
} from "./execution.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import { evidenceRecord } from "./record-read.ts";
import { insertEvidence, readEvidence, readRequests } from "./record-store.ts";
import type { Dependencies } from "./service.ts";

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
  requireTextBound("subject", body.subject, dependencies.config.textMaxBytes);
  const action = requiredActionsOf(
    tx,
    dependencies.bindings,
    nodeId,
    claim.pinnedRevision,
  ).find((item) => item.key === body.requirementKey);
  if (!action)
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.RequestRequirementUnknown,
      "Required external action not found.",
    );
  const binding = dependencies.bindings.getBindingRevision(
    tx,
    action.bindingId,
  );
  assert.ok(binding);
  const kind =
    action.action === RepositoryAction.PullRequest
      ? PlatformAddressKind.PullRequest
      : PlatformAddressKind.BranchPush;
  if (
    body.address.kind !== kind ||
    body.address.resourceIdentity !== binding.resourceIdentity
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.RequestAddressMismatch,
      "Request address does not match the required action.",
      { requirementKey: body.requirementKey },
    );
  if (
    readRequests(tx, nodeId, claim.attempt).some(
      (request) => request.requirement_key === body.requirementKey,
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
      requirement_key: body.requirementKey,
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
