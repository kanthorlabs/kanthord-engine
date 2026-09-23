import type { Store, Transaction } from "../store.ts";
import { ulidSchema } from "../shared/identity.ts";
import { conflict, GatewayError } from "./errors.ts";

export const IdempotencyStatus = {
  InProgress: "in_progress",
  Secret: "secret",
  Completed: "completed",
} as const;

export interface RecordedResponse {
  status: number;
  body: unknown;
}
export interface Reservation {
  key: string;
  caller: string;
}
interface Row {
  route: string;
  fingerprint: string;
  caller: string;
  status: string;
  response: string | null;
}

export class Idempotency {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  healthcheck(): boolean {
    try {
      this.store.database
        .prepare("SELECT key FROM gateway_idempotency LIMIT 1")
        .get();
      return true;
    } catch {
      return false;
    }
  }

  sweep(): void {
    this.store.transaction(({ database }) =>
      database
        .prepare("DELETE FROM gateway_idempotency WHERE status = ?")
        .run(IdempotencyStatus.InProgress),
    );
  }

  reserve(
    key: string | undefined,
    caller: string,
    route: string,
    fingerprint: string,
  ): { reservation: Reservation; replay?: RecordedResponse } {
    if (!ulidSchema.safeParse(key).success)
      throw new GatewayError(
        400,
        "gateway.idempotency.invalid_key",
        "Idempotency-Key must be a canonical ULID.",
      );
    return this.store.transaction(({ database }) => {
      const row = database
        .prepare(
          "SELECT * FROM gateway_idempotency WHERE key = ? AND caller = ?",
        )
        .get(key!, caller) as unknown as Row | undefined;
      const reservation = { key: key!, caller };
      if (row) {
        if (
          row.route !== route ||
          row.fingerprint !== fingerprint ||
          row.status === IdempotencyStatus.InProgress
        )
          throw conflict();
        if (row.status === IdempotencyStatus.Secret) throw conflict();
        return {
          reservation,
          replay: JSON.parse(row.response!) as RecordedResponse,
        };
      }
      database
        .prepare(
          "INSERT INTO gateway_idempotency VALUES (?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(
          key!,
          route,
          fingerprint,
          caller,
          IdempotencyStatus.InProgress,
          Date.now(),
        );
      return { reservation };
    });
  }

  complete(
    transaction: Transaction,
    reservation: Reservation,
    response: RecordedResponse,
    secret = false,
  ): void {
    transaction.database
      .prepare(
        "UPDATE gateway_idempotency SET status = ?, response = ? WHERE key = ? AND caller = ?",
      )
      .run(
        secret ? IdempotencyStatus.Secret : IdempotencyStatus.Completed,
        JSON.stringify(secret ? { status: 409, body: null } : response),
        reservation.key,
        reservation.caller,
      );
  }
}
