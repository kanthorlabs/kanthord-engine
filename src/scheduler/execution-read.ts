import assert from "node:assert/strict";
import { isMachineIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { Dependencies } from "./service.ts";
import { executionRecord, readExecution } from "./execution-store.ts";

export function requireExecution(tx: Transaction, executionId: string) {
  const row = readExecution(tx, executionId);
  if (!row)
    throw new OperationError(
      HttpStatus.NotFound,
      "scheduler.execution.not_found",
      "Execution not found.",
    );
  assert.equal(row.executionId, executionId);
  assert.ok(row.projectId);
  return row;
}

export function claimGet(
  dependencies: Dependencies,
  executionId: string,
  caller: CallerContext,
) {
  const identity = caller.identity;
  assert.ok(
    isMachineIdentity(identity),
    "claim get requires a verified machine",
  );
  assert.ok(identity.runtimeIdentity);
  return caller.commit((tx) => {
    const now = Date.now();
    const row = requireExecution(tx, executionId);
    if (
      row.runtimeIdentity !== identity.runtimeIdentity ||
      row.projectId !== identity.projectId ||
      row.resourceIdentity !== identity.resourceIdentity
    )
      throw new OperationError(
        HttpStatus.Forbidden,
        "scheduler.execution.not_owner",
        "The execution belongs to another claimant.",
      );
    return executionRecord(tx, dependencies.registrations, row, now);
  });
}
