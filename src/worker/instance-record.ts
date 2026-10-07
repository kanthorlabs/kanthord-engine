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
    registration.project_id,
    registration.resource_identity,
  );
  assert.ok(binding && !binding.tombstone);
  const declaration = getWorkerDeclaration(binding.worker_name);
  assert.ok(declaration);
  const activity = dependencies.schedulerClaims.activityOf(
    tx,
    registration.runtime_identity,
    now,
  );
  if (activity.activity === InstanceActivity.Executing)
    assert.ok(activity.executionId);
  return instanceRecordSchema.parse({
    runtime_identity: registration.runtime_identity,
    project_id: registration.project_id,
    resource_identity: registration.resource_identity,
    worker_name: binding.worker_name,
    host: declaration.host,
    ...(declaration.host === WorkerHost.Kanthord
      ? { placement: InstancePlacement.Worker }
      : {}),
    client_id: registration.client_id,
    name: registration.name,
    activity: activity.activity,
    ...(activity.activity === InstanceActivity.Executing
      ? { execution_id: activity.executionId }
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
  if (query.resource_identity !== undefined) {
    assert.ok(query.project_id);
    const binding = dependencies.workerBindingOf(
      tx,
      query.project_id,
      query.resource_identity,
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
        ? Buffer.from(items.at(-1)!.runtime_identity, "utf8").toString(
            "base64url",
          )
        : null,
  };
}
