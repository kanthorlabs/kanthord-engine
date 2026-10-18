import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { MissionErrorCode, type UnmatchedClaim } from "./contract.ts";
import type { Dependencies } from "./service.ts";

const NO_PAIRS = 0;
export const UNMATCHED_MESSAGE =
  "The node write adds a node and claimable state pair that no worker binding covers.";

function pairKey(pair: UnmatchedClaim): string {
  return JSON.stringify([pair.node_id, pair.claim]);
}

export function addedPairs(
  tx: Transaction,
  dependencies: Pick<Dependencies, "schedulerMatch">,
  projectId: string,
  write: (tx: Transaction) => unknown,
): UnmatchedClaim[] {
  assert.ok(tx.database.isTransaction);
  const before = new Set(
    dependencies.schedulerMatch.unmatchedClaims(tx, projectId).map(pairKey),
  );
  write(tx);
  return dependencies.schedulerMatch
    .unmatchedClaims(tx, projectId)
    .filter((pair) => !before.has(pairKey(pair)))
    .map(({ node_id, revision, claim }) => ({ node_id, revision, claim }));
}

export function guardCoverage<T>(
  tx: Transaction,
  dependencies: Pick<Dependencies, "schedulerMatch">,
  projectId: string,
  write: (tx: Transaction) => T,
): T {
  let result: T | undefined;
  const added = addedPairs(tx, dependencies, projectId, (tx) => {
    result = write(tx);
  });
  if (added.length > NO_PAIRS)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.TagsUnmatched,
      UNMATCHED_MESSAGE,
      { claims: added },
    );
  return result as T;
}
