import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordKind, type TelemetryRecord } from "../../tracking/contract.ts";
import { SpanOperation, SpanRecorder } from "./telemetry.ts";
import {
  VerificationContext,
  verificationObserver,
} from "./method-telemetry.ts";
import {
  CommandEnd,
  type CommandRun,
  VerificationClass,
} from "./verification.ts";

const CLAIM = {
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 1,
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
};
const WORKER = "coder@1";
const CLASS_ATTRIBUTE = "kanthord.verification.class";
const TIMED_OUT_ATTRIBUTE = "kanthord.verification.timed_out";

async function endAttributes(ran: CommandRun) {
  const records: TelemetryRecord[] = [];
  const spans = new SpanRecorder(CLAIM, WORKER, {
    write: (batch) => records.push(...batch),
    flush: async () => {},
  });
  await verificationObserver(spans, null, [], {
    context: VerificationContext.Task,
    ownerOf: () => null,
  })(
    { command: ran.result.command, index: 0, run: 1, flaky_check: false },
    async () => ran,
  );
  return records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === SpanOperation.Verification &&
    record.end_time
      ? [record.attributes]
      : [],
  )[0];
}

test("a verification span emits the class timeout for a run that ended at the command limit", async () => {
  const attributes = await endAttributes({
    result: {
      command: "sleep 1000",
      exit_code: null,
      signal: "SIGKILL",
      timed_out: true,
    },
    output: "",
    end: CommandEnd.CommandLimit,
  });
  assert.equal(attributes?.[CLASS_ATTRIBUTE], VerificationClass.Timeout);
  assert.equal(attributes?.[TIMED_OUT_ATTRIBUTE], true);
});

test("a verification span emits the class code_failure for a cancelled run", async () => {
  const attributes = await endAttributes({
    result: {
      command: "sleep 1000",
      exit_code: null,
      signal: "SIGKILL",
      timed_out: false,
    },
    output: "",
    end: CommandEnd.Cancelled,
  });
  assert.equal(attributes?.[CLASS_ATTRIBUTE], VerificationClass.CodeFailure);
});
