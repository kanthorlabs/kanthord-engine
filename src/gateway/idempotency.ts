import { ulidSchema } from "../kernel/identity.ts";
import { HttpStatus } from "../kernel/http.ts";
import { conflict, GatewayError } from "./errors.ts";

export const IdempotencyStatus = {
  InProgress: "in_progress",
  Secret: "secret",
  Completed: "completed",
} as const;
const MILLISECONDS_PER_SECOND = 1000;
const SWEEP_INTERVAL_MS = 60000;
const NO_LIFETIME = 0;
export const DEFAULT_IDEMPOTENCY_TTL = 86400;

export interface RecordedResponse {
  status: number;
  body: unknown;
}
export interface Reservation {
  key: string;
  caller: string;
}
interface RecordEntry {
  reservation: Reservation;
  route: string;
  fingerprint: string;
  status: string;
  response?: RecordedResponse;
  expiresAt: number;
}

export class Idempotency {
  private readonly records = new Map<string, RecordEntry>();
  private readonly ttlMs: number;
  private readonly timer: NodeJS.Timeout;
  private stopped = false;

  constructor(ttl = DEFAULT_IDEMPOTENCY_TTL) {
    if (!Number.isSafeInteger(ttl) || ttl <= NO_LIFETIME)
      throw new Error("Idempotency TTL must be a positive safe integer.");
    this.ttlMs = ttl * MILLISECONDS_PER_SECOND;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.records)
        if (record.expiresAt <= now) this.records.delete(key);
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  healthcheck(): boolean {
    return !this.stopped;
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  reserve(
    key: string | undefined,
    caller: string,
    route: string,
    fingerprint: string,
  ): { reservation: Reservation; replay?: RecordedResponse } {
    if (this.stopped) throw new Error("Idempotency component is stopped.");
    if (!ulidSchema.safeParse(key).success)
      throw new GatewayError(
        HttpStatus.BadRequest,
        "gateway.idempotency.invalid_key",
        "Idempotency-Key must be a canonical ULID.",
      );
    const index = JSON.stringify([caller, key]);
    const now = Date.now();
    let record = this.records.get(index);
    if (record && record.expiresAt <= now) {
      this.records.delete(index);
      record = undefined;
    }
    if (record) {
      if (
        record.route !== route ||
        record.fingerprint !== fingerprint ||
        record.status !== IdempotencyStatus.Completed
      )
        throw conflict();
      return {
        reservation: record.reservation,
        replay: structuredClone(record.response!),
      };
    }
    const reservation = { key: key!, caller };
    this.records.set(index, {
      reservation,
      route,
      fingerprint,
      status: IdempotencyStatus.InProgress,
      expiresAt: now + this.ttlMs,
    });
    return { reservation };
  }

  complete(
    reservation: Reservation,
    response: RecordedResponse,
    secret = false,
  ): void {
    const record = this.records.get(
      JSON.stringify([reservation.caller, reservation.key]),
    );
    if (!record || record.reservation !== reservation) return;
    record.response = secret
      ? { status: HttpStatus.Conflict, body: null }
      : structuredClone(response);
    record.status = secret
      ? IdempotencyStatus.Secret
      : IdempotencyStatus.Completed;
  }
}
