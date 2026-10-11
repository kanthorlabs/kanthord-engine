import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OperationResultType } from "../../kernel/operation.ts";
import { RecordKind, type TelemetryRecord } from "../../tracking/contract.ts";
import {
  HttpTelemetrySink,
  TELEMETRY_BATCH_RECORDS,
  TELEMETRY_QUEUE_RECORDS,
  type TelemetryWrite,
} from "./telemetry-sink.ts";

const EXECUTION = "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const SPAN = "2".repeat(16);
const FLUSH_MS = 5000;
const SEND_ATTEMPTS = 3;
const ONE_CALL = 1;
const TWO_RECORDS = 2;
const SHORT_FLUSH_MS = 300;
const FLUSH_SLACK_MS = 1000;
const TIMER_JITTER_MS = 10;
const SLOW_SEND_MS = 200;
const NO_DELIVERY = 0;
const PROOF_FAILED = "gateway.invocation.execution_proof_failed";

function text(index: number): TelemetryRecord {
  return {
    record_id: `${SPAN}:output_${index}`,
    trace_id: "a".repeat(32),
    kind: RecordKind.Text,
    text_id: `${SPAN}:output_${index}`,
    text: "Tests: 1 passed",
  };
}

function texts(count: number): TelemetryRecord[] {
  return Array.from({ length: count }, (_, index) => text(index));
}

function acknowledged(calls: TelemetryRecord[][]): TelemetryWrite {
  return (async (request: { body: { records: TelemetryRecord[] } }) => {
    calls.push(request.body.records);
    return {
      type: OperationResultType.Completed,
      status: 200,
      data: {
        dispositions: [],
        submitted: request.body.records.length,
        stored: request.body.records.length,
        refused: 0,
      },
    };
  }) as unknown as TelemetryWrite;
}

test("a flush delivers the queued records of the execution", async () => {
  const calls: TelemetryRecord[][] = [];
  const logs: Record<string, unknown>[] = [];
  const sink = new HttpTelemetrySink({
    executionId: EXECUTION,
    send: acknowledged(calls),
    log: (record) => logs.push(record),
  });
  sink.write(texts(TWO_RECORDS));
  await sink.flush(FLUSH_MS);
  sink.close();
  assert.equal(calls.length, ONE_CALL);
  assert.equal(calls[0]?.length, TWO_RECORDS);
  assert.deepEqual(logs, []);
});

test("a full batch is sent before the interval", async () => {
  const calls: TelemetryRecord[][] = [];
  const sink = new HttpTelemetrySink({
    executionId: EXECUTION,
    send: acknowledged(calls),
    log: () => {},
  });
  sink.write(texts(TELEMETRY_BATCH_RECORDS + TWO_RECORDS));
  await sink.flush(FLUSH_MS);
  sink.close();
  assert.equal(calls[0]?.length, TELEMETRY_BATCH_RECORDS);
  assert.equal(calls[1]?.length, TWO_RECORDS);
});

test("an indeterminate write is retried a bounded number of times", async () => {
  let calls = 0;
  const logs: Record<string, unknown>[] = [];
  const sink = new HttpTelemetrySink({
    executionId: EXECUTION,
    send: (async () => {
      calls++;
      return { type: OperationResultType.Indeterminate };
    }) as unknown as TelemetryWrite,
    log: (record) => logs.push(record),
  });
  sink.write(texts(TWO_RECORDS));
  await sink.flush(FLUSH_MS);
  sink.close();
  assert.equal(calls, SEND_ATTEMPTS);
  assert.equal(logs.at(-1)?.dropped, TWO_RECORDS);
});

test("a refused proof drops the batch and logs its code", async () => {
  const logs: Record<string, unknown>[] = [];
  const sink = new HttpTelemetrySink({
    executionId: EXECUTION,
    send: (async () => ({
      type: OperationResultType.Failure,
      status: 403,
      error: { error: { code: PROOF_FAILED, message: "ended" } },
    })) as unknown as TelemetryWrite,
    log: (record) => logs.push(record),
  });
  sink.write(texts(TWO_RECORDS));
  await sink.flush(FLUSH_MS);
  sink.close();
  assert.equal(logs[0]?.code, PROOF_FAILED);
  assert.equal(logs.at(-1)?.dropped, TWO_RECORDS);
});

test("a write beyond the queue bound is dropped and counted at close", () => {
  const logs: Record<string, unknown>[] = [];
  const sink = new HttpTelemetrySink({
    executionId: EXECUTION,
    send: (async () => new Promise(() => {})) as unknown as TelemetryWrite,
    log: (record) => logs.push(record),
  });
  sink.write(texts(TELEMETRY_QUEUE_RECORDS + ONE_CALL));
  sink.close();
  assert.equal(logs.length, ONE_CALL);
  assert.equal(logs[0]?.dropped, TELEMETRY_QUEUE_RECORDS + ONE_CALL);
});

test("a flush returns at its deadline while a send hangs", async () => {
  const sink = new HttpTelemetrySink({
    executionId: EXECUTION,
    send: (async () => new Promise(() => {})) as unknown as TelemetryWrite,
    log: () => {},
  });
  sink.write(texts(TELEMETRY_BATCH_RECORDS));
  const started = Date.now();
  await sink.flush(SHORT_FLUSH_MS);
  sink.close();
  assert.ok(Date.now() - started < SHORT_FLUSH_MS + FLUSH_SLACK_MS);
  assert.ok(Date.now() - started >= SHORT_FLUSH_MS - TIMER_JITTER_MS);
});

test("a flush waits for the send that is in flight", async () => {
  let delivered = 0;
  const sink = new HttpTelemetrySink({
    executionId: EXECUTION,
    send: (async (request: { body: { records: TelemetryRecord[] } }) => {
      await delay(SLOW_SEND_MS);
      delivered += request.body.records.length;
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { dispositions: [], submitted: 0, stored: 0, refused: 0 },
      };
    }) as unknown as TelemetryWrite,
    log: () => {},
  });
  sink.write(texts(TELEMETRY_BATCH_RECORDS));
  await sink.flush(FLUSH_MS);
  sink.close();
  assert.equal(delivered, TELEMETRY_BATCH_RECORDS);
  assert.ok(delivered > NO_DELIVERY);
});
