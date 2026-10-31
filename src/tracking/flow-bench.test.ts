import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { ulid } from "ulid";
import { Store } from "../kernel/store.ts";
import { temporaryDirectory } from "../kernel/test-support.ts";
import { admitRecords } from "./admission.ts";
import {
  EXECUTION_RECORD_LIMIT,
  RecordKind,
  ROOT_SPAN_OPERATION,
  SpanOrigin,
  SpanStatus,
  TELEMETRY_WRITE_RECORDS_MAX,
  type TelemetryRecord,
  TRACKING_SERVICE_NAME,
} from "./contract.ts";
import { openFlow } from "./flow-admission.ts";
import { trackingMigrations } from "./migrations.ts";
import { insertTrace, type TraceRow } from "./trace-store.ts";

const ENABLED_VALUE = "1";
const SKIP =
  process.env.KANTHORD_FLOW_BENCH === ENABLED_VALUE
    ? false
    : "KANTHORD_FLOW_BENCH is not 1; set it to run the flow benchmark";
const BENCH_TIMEOUT_MS = 900000;
const MAX_RATIO = 1.2;
const FIRST_BATCH = 0;
const ANCHOR = Date.now();
const TURNS = (EXECUTION_RECORD_LIMIT - 2) / 2;
const RUNS = [false, true, false, true, false, true];
const PRODUCER = "producer";
const WORKER = "coder@1";

const TRACE: TraceRow = {
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
  execution_id: `execution_${ulid(ANCHOR)}`,
  project_id: "project_a",
  node_id: null,
  attempt: null,
};

function spanId(prefix: string, index: number): string {
  return `${prefix}${index.toString(16).padStart(15, "0")}`;
}

function spanRecord(
  recordId: string,
  id: string,
  operation: string,
  fields: Record<string, unknown>,
): TelemetryRecord {
  return {
    record_id: recordId,
    trace_id: TRACE.trace_id,
    kind: RecordKind.Span,
    span_id: id,
    operation,
    parent_span_id: id === TRACE.root_span_id ? null : TRACE.root_span_id,
    ...fields,
  } as TelemetryRecord;
}

function turnRecord(index: number): TelemetryRecord {
  return spanRecord(`turn-${index}`, spanId("2", index), "agent.turn", {
    start_time: ANCHOR + index,
    end_time: ANCHOR + index + 1,
    status: SpanStatus.Ok,
    attributes: {
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 400,
      "gen_ai.usage.cache_creation.input_tokens": 50,
      "kanthord.usage.cost_usd": 0.01,
      "gen_ai.provider.name": "provider",
      "gen_ai.response.model": "model-a",
    },
  });
}

function toolRecord(index: number): TelemetryRecord {
  return spanRecord(`tool-${index}`, spanId("3", index), "agent.tool", {
    start_time: ANCHOR + index,
    end_time: ANCHOR + index + 1,
    status: SpanStatus.Ok,
  });
}

function executionRecords(): TelemetryRecord[] {
  const start = spanRecord(
    "root-start",
    TRACE.root_span_id,
    ROOT_SPAN_OPERATION,
    {
      start_time: ANCHOR,
      attributes: {
        "kanthord.execution.kind": "steps",
        "kanthord.worker.name": WORKER,
        "kanthord.queue.wait_ms": 250,
      },
    },
  );
  const end = spanRecord("root-end", TRACE.root_span_id, ROOT_SPAN_OPERATION, {
    end_time: ANCHOR + TURNS + 2,
    status: SpanStatus.Ok,
    attributes: { "kanthord.execution.end": "finished" },
  });
  const turns = Array.from({ length: TURNS }, (_, index) => turnRecord(index));
  const tools = Array.from({ length: TURNS }, (_, index) => toolRecord(index));
  return [start, ...turns, ...tools, end];
}

function batchesOf(records: readonly TelemetryRecord[]): TelemetryRecord[][] {
  const batches: TelemetryRecord[][] = [];
  for (
    let offset = 0;
    offset < records.length;
    offset += TELEMETRY_WRITE_RECORDS_MAX
  )
    batches.push(records.slice(offset, offset + TELEMETRY_WRITE_RECORDS_MAX));
  return batches;
}

function runOnce(batches: TelemetryRecord[][], withFlow: boolean): number {
  const directory = temporaryDirectory();
  const store = new Store(join(directory, "tracking.db"));
  try {
    store.migrate([
      { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
    ]);
    let refused = 0;
    const started = performance.now();
    batches.forEach((batch, index) => {
      const acknowledgement = store.transaction((tx) => {
        const inserted =
          index === FIRST_BATCH && insertTrace(tx, TRACE, ANCHOR);
        const flow = withFlow
          ? openFlow(tx, TRACE.trace_id, inserted, () => false)
          : null;
        return admitRecords(
          tx,
          {
            trace: TRACE,
            producer: PRODUCER,
            origin: SpanOrigin.Observed,
            now: ANCHOR + TURNS + 2,
            flow,
          },
          batch,
        );
      });
      refused += acknowledgement.refused;
    });
    const elapsed = performance.now() - started;
    assert.deepEqual([refused], [0]);
    return elapsed;
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

test(
  "one execution of 50,000 records admits at most 20 % slower with the flow writes",
  { skip: SKIP, timeout: BENCH_TIMEOUT_MS },
  (t) => {
    const records = executionRecords();
    assert.ok(records.length <= EXECUTION_RECORD_LIMIT);
    const batches = batchesOf(records);
    const plain: number[] = [];
    const flowing: number[] = [];
    for (const withFlow of RUNS)
      (withFlow ? flowing : plain).push(runOnce(batches, withFlow));
    const plainMedian = medianOf(plain);
    const flowMedian = medianOf(flowing);
    t.diagnostic(`median with no flow writes: ${plainMedian.toFixed(1)} ms`);
    t.diagnostic(`median with flow writes: ${flowMedian.toFixed(1)} ms`);
    assert.ok(flowMedian <= plainMedian * MAX_RATIO);
  },
);
