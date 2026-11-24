import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderFailure } from "../scheduler/contract.ts";
import {
  addMessageTotals,
  BudgetLimit,
  buildTurnEnd,
  FailureClass,
  InternalFailure,
  providerFailureClass,
  RunEnd,
  zeroTotals,
} from "./run-outcome.ts";

const RESPONSE_TEXT = "done";
const UNAUTHORIZED_REASON = "401 Unauthorized";
const RATE_LIMITED_REASON = "429 Too Many Requests";
const OVERFLOW_REASON =
  "500 Internal Server Error: prompt is too long: 1000 tokens > 100 maximum";
const UNKNOWN_FAILURE_REASON = "fetch failed";
const INTERNAL_FAILURE_REASON = "unexpected error";
const CONTEXT_WINDOW = 200000;

function assistantMessage(params: {
  toolCallCount?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costTotal?: number;
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: string;
}): AssistantMessage {
  const {
    toolCallCount = 0,
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    costTotal = 0,
    stopReason = "stop",
    errorMessage,
  } = params;
  const content: AssistantMessage["content"] = Array.from(
    { length: toolCallCount },
    () => ({
      type: "toolCall" as const,
      id: "tc1",
      name: "bash",
      arguments: {},
    }),
  );
  return {
    role: "assistant",
    content,
    api: "anthropic" as AssistantMessage["api"],
    provider: "anthropic",
    model: "test",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: costTotal,
      },
    },
    stopReason,
    errorMessage,
    timestamp: 0,
  };
}

test("buildTurnEnd gives completed when no failure, no abort and no budget", () => {
  const result = buildTurnEnd({
    budgetReached: null,
    stopped: false,
    failure: null,
    text: RESPONSE_TEXT,
    totals: zeroTotals(),
    warnings: [],
  });
  assert.equal(result.end, RunEnd.Completed);
  assert.equal(result.budgetReached, null);
  assert.equal(result.failure, null);
  assert.equal(result.text, RESPONSE_TEXT);
});

test("buildTurnEnd gives budget_end with wall when budgetReached is wall", () => {
  const result = buildTurnEnd({
    budgetReached: BudgetLimit.Wall,
    stopped: false,
    failure: null,
    text: null,
    totals: zeroTotals(),
    warnings: [],
  });
  assert.equal(result.end, RunEnd.BudgetEnd);
  assert.equal(result.budgetReached, BudgetLimit.Wall);
  assert.equal(result.failure, null);
});

test("buildTurnEnd gives stopped when stopped is true", () => {
  const result = buildTurnEnd({
    budgetReached: null,
    stopped: true,
    failure: null,
    text: null,
    totals: zeroTotals(),
    warnings: [],
  });
  assert.equal(result.end, RunEnd.Stopped);
  assert.equal(result.budgetReached, null);
  assert.equal(result.failure, null);
});

test("buildTurnEnd gives failed with unauthorized provider failure kind", () => {
  const result = buildTurnEnd({
    budgetReached: null,
    stopped: false,
    failure: { internal: false, reason: UNAUTHORIZED_REASON },
    text: null,
    totals: zeroTotals(),
    warnings: [],
  });
  assert.equal(result.end, RunEnd.Failed);
  assert.equal(result.budgetReached, null);
  assert.ok(result.failure);
  assert.equal(result.failure.kind, ProviderFailure.Unauthorized);
  assert.equal(result.failure.class, FailureClass.Terminal);
  assert.equal(result.failure.reason, UNAUTHORIZED_REASON);
});

test("buildTurnEnd gives failed with unavailable for an unknown error", () => {
  const result = buildTurnEnd({
    budgetReached: null,
    stopped: false,
    failure: { internal: false, reason: UNKNOWN_FAILURE_REASON },
    text: null,
    totals: zeroTotals(),
    warnings: [],
  });
  assert.ok(result.failure);
  assert.equal(result.failure.kind, ProviderFailure.Unavailable);
  assert.equal(result.failure.class, FailureClass.Terminal);
});

test("buildTurnEnd gives failed with internal failure for a runtime error", () => {
  const result = buildTurnEnd({
    budgetReached: null,
    stopped: false,
    failure: { internal: true, reason: INTERNAL_FAILURE_REASON },
    text: null,
    totals: zeroTotals(),
    warnings: [],
  });
  assert.equal(result.end, RunEnd.Failed);
  assert.ok(result.failure);
  assert.equal(result.failure.kind, InternalFailure.Internal);
  assert.equal(result.failure.class, FailureClass.Terminal);
  assert.equal(result.failure.reason, INTERNAL_FAILURE_REASON);
});

test("budgetReached priority over stopped", () => {
  const result = buildTurnEnd({
    budgetReached: BudgetLimit.Wall,
    stopped: true,
    failure: null,
    text: null,
    totals: zeroTotals(),
    warnings: [],
  });
  assert.equal(result.end, RunEnd.BudgetEnd);
});

test("addMessageTotals accumulates model calls and token usage", () => {
  const inputTokens = 100;
  const outputTokens = 50;
  const cacheReadTokens = 20;
  const cacheWriteTokens = 10;
  const costPerCall = 0.005;
  const msg = assistantMessage({
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    costTotal: costPerCall,
  });
  const before = zeroTotals();
  const totals = addMessageTotals(before, msg);
  assert.equal(totals.modelCalls, before.modelCalls + 1);
  assert.equal(totals.toolCalls, before.toolCalls);
  assert.equal(totals.usage.input, before.usage.input + inputTokens);
  assert.equal(totals.usage.output, before.usage.output + outputTokens);
  assert.equal(
    totals.usage.cacheRead,
    before.usage.cacheRead + cacheReadTokens,
  );
  assert.equal(
    totals.usage.cacheWrite,
    before.usage.cacheWrite + cacheWriteTokens,
  );
  assert.equal(totals.listPriceUsd, before.listPriceUsd + costPerCall);
});

test("addMessageTotals counts tool call blocks", () => {
  const toolCallCount = 3;
  const msg = assistantMessage({ toolCallCount });
  const before = zeroTotals();
  const totals = addMessageTotals(before, msg);
  assert.equal(totals.modelCalls, before.modelCalls + 1);
  assert.equal(totals.toolCalls, before.toolCalls + toolCallCount);
});

test("addMessageTotals accumulates across multiple messages", () => {
  const msg1Cost = 0.001;
  const msg2Cost = 0.002;
  const msg1Input = 10;
  const msg1Output = 5;
  const msg2Input = 20;
  const msg2Output = 10;
  const msg2ToolCalls = 2;
  const msg1 = assistantMessage({
    input: msg1Input,
    output: msg1Output,
    costTotal: msg1Cost,
  });
  const msg2 = assistantMessage({
    input: msg2Input,
    output: msg2Output,
    toolCallCount: msg2ToolCalls,
    costTotal: msg2Cost,
  });
  const base = zeroTotals();
  const totals = addMessageTotals(addMessageTotals(base, msg1), msg2);
  assert.equal(totals.modelCalls, base.modelCalls + 2);
  assert.equal(totals.toolCalls, base.toolCalls + msg2ToolCalls);
  assert.equal(totals.usage.input, base.usage.input + msg1Input + msg2Input);
  assert.equal(
    totals.usage.output,
    base.usage.output + msg1Output + msg2Output,
  );
  assert.equal(totals.listPriceUsd, base.listPriceUsd + msg1Cost + msg2Cost);
});

test("L3-U5: providerFailureClass returns retryable for a rate-limited error", () => {
  const msg = assistantMessage({
    stopReason: "error",
    errorMessage: RATE_LIMITED_REASON,
  });
  assert.equal(
    providerFailureClass(msg, CONTEXT_WINDOW),
    FailureClass.Retryable,
  );
});

test("L3-U5: providerFailureClass returns terminal for an unauthorized error", () => {
  const msg = assistantMessage({
    stopReason: "error",
    errorMessage: UNAUTHORIZED_REASON,
  });
  assert.equal(
    providerFailureClass(msg, CONTEXT_WINDOW),
    FailureClass.Terminal,
  );
});

test("L3-U5: providerFailureClass returns terminal for a context overflow", () => {
  const msg = assistantMessage({
    stopReason: "error",
    errorMessage: OVERFLOW_REASON,
  });
  assert.equal(
    providerFailureClass(msg, CONTEXT_WINDOW),
    FailureClass.Terminal,
  );
});
