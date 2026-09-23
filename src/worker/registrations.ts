import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type {
  Registration,
  VerifiedClient,
  WorkerRegistrations,
} from "./contract.ts";
export class InMemoryRegistrations implements WorkerRegistrations {
  readonly registrations = new Map<string, Registration>();
  findByClient(clientId: string): Registration | undefined {
    return this.registrations.get(clientId);
  }
  register(transaction: Transaction, client: VerifiedClient): Registration {
    assert.ok(transaction.database.isTransaction);
    assert.ok(client.clientId);
    if (this.registrations.has(client.clientId))
      throw new OperationError(
        HttpStatus.Conflict,
        "gateway.registration.conflict",
        "Client identity already holds a live registration.",
      );
    const registration = {
      ...client,
      runtimeIdentity: createIdentity("runtime_identity"),
    };
    this.registrations.set(client.clientId, registration);
    return registration;
  }
  deregister(runtimeIdentity: string): void {
    for (const [clientId, registration] of this.registrations)
      if (registration.runtimeIdentity === runtimeIdentity)
        this.registrations.delete(clientId);
  }
}
