import assert from "node:assert/strict";
import type { Store, Transaction } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  WorkerErrorCode,
  type Registration,
  type SchedulerClaims,
  type VerifiedClient,
  type WorkerBindingOf,
  type WorkerRegistrations,
} from "./contract.ts";
import {
  countLive,
  endRegistration,
  insertRegistration,
  readLiveByClient,
  readLiveOfClient,
  readRow,
  reopenRegistration,
} from "./instances.ts";
import type { HeartbeatClock } from "./heartbeat.ts";

export function resumeRegistration(
  tx: Transaction,
  runtimeIdentity: string,
  now: number,
  schedulerClaims: SchedulerClaims,
  workerBindingOf: WorkerBindingOf,
): boolean {
  assert.ok(tx.database.isTransaction);
  assert.ok(runtimeIdentity);
  const row = readRow(tx, runtimeIdentity);
  if (!row)
    throw new OperationError(
      HttpStatus.NotFound,
      WorkerErrorCode.InstanceNotFound,
      "Instance not found.",
    );
  if (row.endedAt === null) return false;
  if (!schedulerClaims.runningExecutionOfRuntime(tx, runtimeIdentity, now))
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.NoLiveExecution,
      "Instance has no running execution.",
    );
  if (readLiveOfClient(tx, row.clientId))
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.ClientLive,
      "Client already holds a live registration.",
    );
  const binding = workerBindingOf(tx, row.projectId, row.resourceIdentity);
  if (
    !binding ||
    binding.tombstone ||
    countLive(tx, row.projectId, row.resourceIdentity) >= binding.instanceCount
  )
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.SlotUnavailable,
      "Worker binding has no available registration slot.",
    );
  reopenRegistration(tx, runtimeIdentity);
  return true;
}

export class TableRegistrations implements WorkerRegistrations {
  private readonly store: Store;
  private readonly workerBindingOf: WorkerBindingOf;
  private readonly clock: HeartbeatClock;
  constructor(
    store: Store,
    workerBindingOf: WorkerBindingOf,
    clock: HeartbeatClock,
  ) {
    assert.ok(store.database.isOpen);
    assert.ok(workerBindingOf);
    this.store = store;
    this.workerBindingOf = workerBindingOf;
    this.clock = clock;
  }
  heartbeat(runtimeIdentity: string): void {
    assert.ok(runtimeIdentity);
    assert.ok(this.store.database.isOpen);
    this.clock.renew(runtimeIdentity);
  }
  deregister(tx: Transaction, runtimeIdentity: string, now: number): void {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    endRegistration(tx, runtimeIdentity, now);
  }
  findByClient(clientId: string): Registration | undefined {
    assert.ok(clientId);
    assert.ok(this.store.database.isOpen);
    return readLiveByClient(this.store, clientId);
  }
  liveRegistrationOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): Registration | null {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    const row = readRow(tx, runtimeIdentity);
    return row?.endedAt === null ? row : null;
  }
  clientAttributionOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): { clientId: string; name: string } | null {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    const row = readRow(tx, runtimeIdentity);
    return row ? { clientId: row.clientId, name: row.name } : null;
  }
  register(
    tx: Transaction,
    client: VerifiedClient,
    now: number,
  ): Registration & { workerName: string } {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    const previous = readLiveOfClient(tx, client.clientId);
    const binding = this.workerBindingOf(
      tx,
      client.projectId,
      client.resourceIdentity,
    );
    if (
      !binding ||
      binding.tombstone ||
      (!previous &&
        countLive(tx, client.projectId, client.resourceIdentity) >=
          binding.instanceCount)
    )
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.SlotUnavailable,
        "Worker binding has no available registration slot.",
      );
    return {
      ...(previous ?? insertRegistration(tx, client, now)),
      workerName: binding.workerName,
    };
  }
}
