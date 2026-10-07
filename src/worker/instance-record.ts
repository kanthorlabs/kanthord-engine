import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import {
  InstanceActivity,
  InstancePlacement,
  WorkerHost,
  WorkerErrorCode,
  instanceRecordSchema,
  workerOperations,
  type Registration,
  type WorkerBindingOf,
  type SchedulerClaims,
} from "./contract.ts";
import { listLive, WORKER_INSTANCE_PREFIX } from "./instances.ts";

interface Dependencies {
  workerBindingOf: WorkerBindingOf;
  schedulerClaims: SchedulerClaims;
}

export function instanceRecord(
  tx: Transaction,
  dependencies: Dependencies,
  registration: Registration,
  now: number,
): typeof instanceRecordSchema._output {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  const binding = dependencies.workerBindingOf(
    tx,
    registration.projectId,
    registration.resourceIdentity,
  );
  assert.ok(binding && !binding.tombstone);
  const declaration = getWorkerDeclaration(binding.workerName);
  assert.ok(declaration);
  const activity = dependencies.schedulerClaims.activityOf(
    tx,
    registration.runtimeIdentity,
    now,
  );
  if (activity.activity === InstanceActivity.Executing)
    assert.ok(activity.executionId);
  return instanceRecordSchema.parse({
    runtimeIdentity: registration.runtimeIdentity,
    projectId: registration.projectId,
    resourceIdentity: registration.resourceIdentity,
    workerName: binding.workerName,
    host: declaration.host,
    ...(declaration.host === WorkerHost.Kanthord
      ? { placement: InstancePlacement.Worker }
      : {}),
    clientId: registration.clientId,
    name: registration.name,
    activity: activity.activity,
    ...(activity.activity === InstanceActivity.Executing
      ? { executionId: activity.executionId }
      : {}),
    draining: false,
    registered: true,
  });
}

function decodeCursor(cursor: string): string {
  const stringType = "string";
  assert.equal(typeof cursor, stringType);
  assert.ok(WORKER_INSTANCE_PREFIX);
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (
    Buffer.from(decoded, "utf8").toString("base64url") !== cursor ||
    !identitySchema(WORKER_INSTANCE_PREFIX).safeParse(decoded).success
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      "system.pagination.cursor_invalid",
      "Cursor is invalid.",
    );
  return decoded;
}

export function listInstanceRecords(
  tx: Transaction,
  dependencies: Dependencies,
  query: (typeof workerOperations)["instance.list"]["input"]["_output"]["query"],
  now: number,
): (typeof workerOperations)["instance.list"]["output"]["_output"] {
  assert.ok(tx.database.isTransaction);
  assert.ok(Number.isSafeInteger(now));
  if (query.resourceIdentity !== undefined) {
    assert.ok(query.projectId);
    const binding = dependencies.workerBindingOf(
      tx,
      query.projectId,
      query.resourceIdentity,
    );
    if (!binding || binding.tombstone)
      throw new OperationError(
        HttpStatus.BadRequest,
        WorkerErrorCode.BindingUnknown,
        "Worker binding is unknown in this project.",
      );
  }
  const rows = listLive(tx, {
    ...query,
    cursor: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
  });
  const first = 0;
  const items = rows
    .slice(first, query.limit)
    .map((row) => instanceRecord(tx, dependencies, row, now));
  return {
    items,
    next_cursor:
      rows.length > query.limit
        ? Buffer.from(items.at(-1)!.runtimeIdentity, "utf8").toString(
            "base64url",
          )
        : null,
  };
}
