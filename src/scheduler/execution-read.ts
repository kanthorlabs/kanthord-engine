import assert from "node:assert/strict";
import { isMachineIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { Dependencies } from "./service.ts";
import {
  executionRecord,
  readExecution,
  listExecutions,
} from "./execution-store.ts";
import { schedulerOperations } from "./contract.ts";

const FIRST_ROW = 0;
const TEXT_ENCODING = "utf8";
const CURSOR_ENCODING = "base64url";

export function executionGet(
  dependencies: Dependencies,
  executionId: string,
  caller: CallerContext,
) {
  return caller.commit((tx) => {
    const now = Date.now();
    return executionRecord(
      tx,
      dependencies.registrations,
      requireExecution(tx, executionId),
      now,
    );
  });
}

export function executionList(
  dependencies: Dependencies,
  input: typeof schedulerOperations.executionList.input._output,
  caller: CallerContext,
  after: string | undefined,
) {
  const { limit, nodeId, attempt } = input.query;
  return caller.commit((tx) => {
    const now = Date.now();
    const rows = listExecutions(
      tx,
      input.params.projectId,
      { nodeId, attempt },
      after,
      limit,
    );
    const items = rows
      .slice(FIRST_ROW, limit)
      .map((row) => executionRecord(tx, dependencies.registrations, row, now));
    const nextCursor =
      rows.length > limit
        ? Buffer.from(items.at(-1)!.executionId, TEXT_ENCODING).toString(
            CURSOR_ENCODING,
          )
        : null;
    return { items, next_cursor: nextCursor };
  });
}

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
