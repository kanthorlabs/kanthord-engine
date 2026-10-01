import assert from "node:assert/strict";
import type { Store, Transaction } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  WorkerErrorCode,
  type Registration,
  type VerifiedClient,
  type WorkerBindingOf,
  type WorkerRegistrations,
} from "./contract.ts";
import {
  countLive,
  insertRegistration,
  readLiveByClient,
  readLiveOfClient,
} from "./instances.ts";
import type { HeartbeatClock } from "./heartbeat.ts";

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
  findByClient(clientId: string): Registration | undefined {
    assert.ok(clientId);
    assert.ok(this.store.database.isOpen);
    return readLiveByClient(this.store, clientId);
  }
  register(tx: Transaction, client: VerifiedClient, now: number): Registration {
    assert.ok(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    const previous = readLiveOfClient(tx, client.clientId);
    if (previous) return previous;
    const binding = this.workerBindingOf(
      tx,
      client.projectId,
      client.resourceIdentity,
    );
    if (
      !binding ||
      binding.tombstone ||
      countLive(tx, client.projectId, client.resourceIdentity) >=
        binding.instanceCount
    )
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.SlotUnavailable,
        "Worker binding has no available registration slot.",
      );
    return insertRegistration(tx, client, now);
  }
}
