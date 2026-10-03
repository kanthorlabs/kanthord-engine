import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { ExecutionRun } from "./execution-run.ts";
import { disposeAgent } from "./native-method.ts";
import { noTranscript, type TranscriptSink } from "./transcript.ts";
import type { NativeAgent } from "./native-agent.ts";
import type { MethodClients } from "./method-clients.ts";

test("transcript records the execution identity and session messages before disposal", (t) => {
  const claim = {
    executionId: "execution",
    nodeId: "node",
    attempt: 2,
    pinnedRevision: 1,
    createdAt: Date.now(),
    expiredAt: Date.now() + 60000,
    traceId: "trace",
  };
  const run = new ExecutionRun({
    claim,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const events: unknown[] = [];
  const messages = [
    { role: "user", content: "work" },
    { role: "assistant", content: "done" },
  ];
  const sink: TranscriptSink = {
    record: (entry) => {
      events.push(entry);
    },
  };
  const agent = {
    transcript: () => messages,
    dispose: () => {
      events.push("disposed");
    },
  } as unknown as NativeAgent;
  disposeAgent(run, null, sink);
  disposeAgent(run, agent, sink);
  assert.deepEqual(events, [
    {
      executionId: claim.executionId,
      attempt: claim.attempt,
      traceId: claim.traceId,
      messages,
    },
    "disposed",
  ]);
  assert.deepEqual(Object.keys(noTranscript), ["record"]);
  noTranscript.record({
    executionId: claim.executionId,
    attempt: claim.attempt,
    traceId: claim.traceId,
    messages,
  });
});
