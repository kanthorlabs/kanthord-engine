import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ActorKind,
  MissionErrorCode,
  NodeKind,
  NodeState,
  type ExecutionActor,
  type ExecutionContext,
} from "./contract.ts";
import { requireNode, getRevision } from "./node-read.ts";
import { readOpenAttempt } from "./record-store.ts";
import type { Dependencies } from "./service.ts";
import type { NodeRow } from "./store.ts";

const NOT_RUNNING = "scheduler.execution.not_running";
const VALIDATION_FAILED = "gateway.request.validation_failed";
const POSITIVE_BOUND = 0;

export function executionMismatch(field: string): never {
  throw new OperationError(
    HttpStatus.Conflict,
    MissionErrorCode.ExecutionContextMismatch,
    "Execution context does not match the claim.",
    { field },
  );
}

export function invalidExecutionInput(field: string, code = "custom"): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    VALIDATION_FAILED,
    "Request validation failed.",
    [{ path: [field], code }],
  );
}

export function admitExecution(
  tx: Transaction,
  dependencies: Pick<Dependencies, "schedulerClaims" | "executionAttribution">,
  claim: ExecutionClaim,
  routeNodeId: string,
  context: ExecutionContext,
  now: number,
) {
  assert.ok(tx.database.isTransaction);
  const live = dependencies.schedulerClaims.liveExecutionOf(
    tx,
    claim.nodeId,
    now,
  );
  if (
    !live ||
    live.executionId !== claim.executionId ||
    live.runtimeIdentity !== claim.runtimeIdentity
  )
    throw new OperationError(
      HttpStatus.Conflict,
      NOT_RUNNING,
      "Execution is not running.",
    );
  if (routeNodeId !== claim.nodeId) executionMismatch("nodeId");
  if (context.executionId !== claim.executionId)
    executionMismatch("executionId");
  if (context.attempt !== claim.attempt) executionMismatch("attempt");
  if (context.nodeRevision !== claim.pinnedRevision)
    executionMismatch("nodeRevision");
  assert.equal(live.attempt, claim.attempt);
  assert.equal(live.pinnedRevision, claim.pinnedRevision);
  const node = requireNode(tx, claim.nodeId);
  assert.notEqual(node.kind, NodeKind.Task);
  const attempt = readOpenAttempt(tx, node.id);
  assert.ok(attempt);
  assert.equal(attempt.attempt, claim.attempt);
  assert.equal(attempt.node_revision, claim.pinnedRevision);
  const revision = getRevision(tx, node.id, claim.pinnedRevision);
  const attribution = dependencies.executionAttribution.of(
    tx,
    claim.executionId,
  );
  assert.ok(attribution);
  const actor: ExecutionActor = {
    kind: ActorKind.Execution,
    executionId: claim.executionId,
    clientId: attribution.clientId,
    name: attribution.name,
  };
  return { node, attempt, revision, actor };
}

export function requireEvaluationClaim(node: NodeRow): void {
  assert.notEqual(node.kind, NodeKind.Task);
  assert.ok(node.state);
  if (node.state !== NodeState.Evaluating)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.ExecutionClaimNotEvaluation,
      "An evaluation claim is required.",
    );
}

export function requireTextBound(
  field: string,
  value: string,
  textMaxBytes: number,
): void {
  assert.ok(field);
  assert.ok(
    Number.isSafeInteger(textMaxBytes) && textMaxBytes > POSITIVE_BOUND,
  );
  if (Buffer.byteLength(value) > textMaxBytes)
    invalidExecutionInput(field, "too_big");
}
