import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { MissionErrorCode } from "./contract.ts";
import { admitExecution } from "./execution.ts";
import { getRevision, revisionCursor, revisionPage } from "./node-read.ts";
import type { Dependencies } from "./service.ts";

export function executionRead(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(claim.executionId);
  return admitExecution(
    tx,
    dependencies,
    claim,
    claim.nodeId,
    {
      executionId: claim.executionId,
      attempt: claim.attempt,
      nodeRevision: claim.pinnedRevision,
    },
    Date.now(),
  );
}

function requireRevisionBound(revision: number, claim: ExecutionClaim): void {
  if (revision > claim.pinnedRevision)
    throw new OperationError(
      HttpStatus.NotFound,
      MissionErrorCode.ExecutionRevisionAbovePin,
      "The revision is above the execution pin.",
    );
}

export function executionRevision(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  revision = claim.pinnedRevision,
) {
  executionRead(tx, dependencies, claim);
  requireRevisionBound(revision, claim);
  return getRevision(tx, claim.nodeId, revision);
}

export function executionRevisionPage(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  query: { cursor?: string; limit?: number },
) {
  executionRead(tx, dependencies, claim);
  const after =
    query.cursor === undefined ? undefined : revisionCursor(query.cursor);
  if (after !== undefined) requireRevisionBound(after, claim);
  return revisionPage(
    tx,
    claim.nodeId,
    after,
    query.limit,
    claim.pinnedRevision,
  );
}
