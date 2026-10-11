import assert from "node:assert/strict";
import { ulid } from "ulid";
import { CancellationContext } from "../../kernel/context.ts";
import { CodedError } from "../../kernel/errors.ts";
import {
  OperationResultType,
  type OperationResult,
  type ServiceClient,
} from "../../kernel/operation.ts";
import type {
  Acknowledgement,
  TelemetryRecord,
  trackingOperations,
} from "../../tracking/contract.ts";
import type { TelemetrySink } from "../../worker/index.ts";
import { sleep } from "./api.ts";

export type TelemetryWrite = ServiceClient<
  typeof trackingOperations
>["telemetryWrite"];

export const TELEMETRY_QUEUE_RECORDS = 5000;
export const TELEMETRY_BATCH_RECORDS = 200;
export const TELEMETRY_BATCH_BYTES = 768 * 1024;
export const TELEMETRY_INTERVAL_MS = 1000;
const CALL_TIMEOUT_MS = 10000;
const SEND_ATTEMPTS = 3;
const FLUSH_ROUNDS = 3;
const FIRST_ATTEMPT = 0;
const RETRY_DELAY_MS = 200;
const NO_RECORDS = 0;
const NO_DROPS = 0;
const NO_BYTES = 0;
const NO_WAIT_MS = 0;
const UNKNOWN_FAILURE = "system.operation.unknown";

export class HttpTelemetrySink implements TelemetrySink {
  private readonly executionId: string;
  private readonly send: TelemetryWrite;
  private readonly log: (record: Record<string, unknown>) => void;
  private readonly lifetime = new CancellationContext();
  private queue: TelemetryRecord[] = [];
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dropped = NO_DROPS;
  private refused = NO_DROPS;
  private lastFailure: string | null = null;

  constructor(input: {
    executionId: string;
    send: TelemetryWrite;
    log: (record: Record<string, unknown>) => void;
  }) {
    assert.ok(input.executionId);
    assert.ok(input.send);
    this.executionId = input.executionId;
    this.send = input.send;
    this.log = input.log;
  }

  write(records: readonly TelemetryRecord[]): void {
    assert.ok(records.length > NO_RECORDS);
    assert.ok(this.queue.length <= TELEMETRY_QUEUE_RECORDS);
    if (
      this.lifetime.err() ||
      this.queue.length + records.length > TELEMETRY_QUEUE_RECORDS
    ) {
      this.dropped += records.length;
      return;
    }
    this.queue.push(...records);
    if (this.queue.length >= TELEMETRY_BATCH_RECORDS)
      this.kick(Date.now() + CALL_TIMEOUT_MS);
    else this.schedule();
  }

  async flush(timeoutMs: number): Promise<void> {
    assert.ok(Number.isSafeInteger(timeoutMs));
    assert.ok(timeoutMs > NO_WAIT_MS);
    this.cancelTimer();
    const deadline = Date.now() + timeoutMs;
    for (
      let round = 0;
      round < FLUSH_ROUNDS &&
      (this.queue.length > NO_RECORDS || this.inFlight !== null) &&
      Date.now() < deadline &&
      !this.lifetime.err();
      round++
    ) {
      if (this.inFlight === null) this.kick(deadline);
      await this.settled(deadline);
    }
  }

  close(): void {
    assert.ok(this.queue.length <= TELEMETRY_QUEUE_RECORDS);
    this.cancelTimer();
    this.dropped += this.queue.length;
    this.queue = [];
    this.lifetime.cancel();
    assert.equal(this.timer, null);
    if (this.dropped === NO_DROPS && this.refused === NO_DROPS) return;
    this.log({
      msg: "telemetry records dropped",
      execution_id: this.executionId,
      dropped: this.dropped,
      refused: this.refused,
      code: this.lastFailure,
    });
  }

  private async settled(deadline: number): Promise<void> {
    assert.ok(Number.isSafeInteger(deadline));
    const running = this.inFlight;
    if (running === null) return;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(NO_WAIT_MS, deadline - Date.now()));
    });
    try {
      await Promise.race([running, expired]);
    } finally {
      clearTimeout(timer);
    }
    assert.ok(timer);
  }

  private schedule(): void {
    assert.ok(this.queue.length > NO_RECORDS);
    assert.ok(!this.lifetime.err());
    if (this.timer !== null || this.inFlight !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick(Date.now() + CALL_TIMEOUT_MS);
    }, TELEMETRY_INTERVAL_MS);
    this.timer.unref();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private kick(deadline: number): void {
    assert.ok(Number.isSafeInteger(deadline));
    this.cancelTimer();
    if (this.inFlight !== null) return;
    this.inFlight = this.drain(deadline)
      .catch((error: unknown) => {
        this.lastFailure =
          error instanceof CodedError ? error.code : UNKNOWN_FAILURE;
      })
      .finally(() => {
        this.inFlight = null;
        if (this.queue.length > NO_RECORDS && !this.lifetime.err())
          this.schedule();
      });
    assert.ok(this.inFlight);
  }

  private async drain(deadline: number): Promise<void> {
    assert.ok(Number.isSafeInteger(deadline));
    assert.ok(this.queue.length <= TELEMETRY_QUEUE_RECORDS);
    for (
      let round = 0;
      round < TELEMETRY_QUEUE_RECORDS &&
      this.queue.length > NO_RECORDS &&
      Date.now() < deadline &&
      !this.lifetime.err();
      round++
    )
      await this.guarded(deadline);
  }

  private async guarded(deadline: number): Promise<void> {
    assert.ok(Number.isSafeInteger(deadline));
    const batch = this.takeBatch();
    assert.ok(batch.length <= TELEMETRY_BATCH_RECORDS);
    if (batch.length === NO_RECORDS) return;
    let failure: string | null;
    try {
      failure = await this.deliver(batch, deadline);
    } catch (error) {
      failure = error instanceof CodedError ? error.code : UNKNOWN_FAILURE;
    }
    if (failure === null) return;
    this.dropped += batch.length;
    this.lastFailure = failure;
    this.log({
      msg: "telemetry write failed",
      execution_id: this.executionId,
      code: failure,
    });
  }

  private takeBatch(): TelemetryRecord[] {
    assert.ok(this.queue.length <= TELEMETRY_QUEUE_RECORDS);
    let bytes = NO_BYTES;
    let count = NO_RECORDS;
    for (
      ;
      count < this.queue.length && count < TELEMETRY_BATCH_RECORDS;
      count++
    ) {
      const size = Buffer.byteLength(JSON.stringify(this.queue[count]));
      if (count > NO_RECORDS && bytes + size > TELEMETRY_BATCH_BYTES) break;
      bytes += size;
    }
    const batch = this.queue.slice(0, count);
    this.queue = this.queue.slice(count);
    assert.ok(batch.length <= TELEMETRY_BATCH_RECORDS);
    return batch;
  }

  private async deliver(
    records: TelemetryRecord[],
    deadline: number,
  ): Promise<string | null> {
    assert.ok(records.length > NO_RECORDS);
    assert.ok(Number.isSafeInteger(deadline));
    let result: OperationResult<Acknowledgement> = {
      type: OperationResultType.Indeterminate,
    };
    for (
      let attempt = 0;
      attempt < SEND_ATTEMPTS &&
      result.type === OperationResultType.Indeterminate &&
      Date.now() < deadline;
      attempt++
    ) {
      if (attempt > FIRST_ATTEMPT) await sleep(RETRY_DELAY_MS, this.lifetime);
      result = await this.sendOnce(records, deadline);
    }
    if (result.type === OperationResultType.Completed) {
      this.refused += result.data.refused;
      return null;
    }
    return result.type === OperationResultType.Failure
      ? result.error.error.code
      : result.type;
  }

  private async sendOnce(
    records: TelemetryRecord[],
    deadline: number,
  ): Promise<OperationResult<Acknowledgement>> {
    assert.ok(records.length > NO_RECORDS);
    assert.ok(Number.isSafeInteger(deadline));
    const context = new CancellationContext(
      this.lifetime,
      Math.min(deadline, Date.now() + CALL_TIMEOUT_MS),
    );
    try {
      return await this.send(
        {
          params: { execution_id: this.executionId },
          query: {},
          body: { records },
        },
        { context, idempotencyKey: ulid() },
      );
    } finally {
      context.cancel();
    }
  }
}
