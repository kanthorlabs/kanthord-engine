import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import {
  RegistrationActivity,
  type InstancePlacement,
  WorkerHost,
  WorkerErrorCode,
  registrationRecordSchema,
  workerOperations,
  type Registration,
  type WorkerBindingOf,
  type SchedulerClaims,
} from "./contract.ts";
import { listLive, WORKER_REGISTRATION_PREFIX } from "./registration-rows.ts";

interface Dependencies {
  workerBindingOf: WorkerBindingOf;
  schedulerClaims: SchedulerClaims;
  draining?: (clientId: string) => boolean;
}

function hostedPlacement(placement: InstancePlacement | null) {
  assert.ok(placement);
  return placement;
}

export function registrationRecord(
  tx: Transaction,
  dependencies: Dependencies,
  registration: Registration,
  now: number,
): typeof registrationRecordSchema._output {
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
  if (activity.activity === RegistrationActivity.Executing)
    assert.ok(activity.execution_id);
  return registrationRecordSchema.parse({
    runtime_identity: registration.runtime_identity,
    project_id: registration.project_id,
    resource_identity: registration.resource_identity,
    worker_name: binding.worker_name,
    host: declaration.host,
    ...(declaration.host === WorkerHost.Kanthord
      ? { placement: hostedPlacement(binding.placement) }
      : {}),
    client_id: registration.client_id,
    name: registration.name,
    activity: activity.activity,
    ...(activity.activity === RegistrationActivity.Executing
      ? { execution_id: activity.execution_id }
      : {}),
    draining: dependencies.draining?.(registration.client_id) ?? false,
    registered: true,
  });
}

function decodeCursor(cursor: string): string {
  const stringType = "string";
  assert.equal(typeof cursor, stringType);
  assert.ok(WORKER_REGISTRATION_PREFIX);
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (
    Buffer.from(decoded, "utf8").toString("base64url") !== cursor ||
    !identitySchema(WORKER_REGISTRATION_PREFIX).safeParse(decoded).success
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      "system.pagination.cursor_invalid",
      "Cursor is invalid.",
    );
  return decoded;
}

export function listRegistrationRecords(
  tx: Transaction,
  dependencies: Dependencies,
  query: (typeof workerOperations)["registration.list"]["input"]["_output"]["query"],
  now: number,
): (typeof workerOperations)["registration.list"]["output"]["_output"] {
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
    .map((row) => registrationRecord(tx, dependencies, row, now));
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
