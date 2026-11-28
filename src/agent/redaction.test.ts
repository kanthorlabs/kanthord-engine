import assert from "node:assert/strict";
import { test } from "node:test";
import { inputRedaction } from "./hooks/input-redaction.ts";
import { markerRestore } from "./hooks/marker-restore.ts";
import { outputFinding } from "./hooks/output-finding.ts";
import {
  createRedaction,
  type RedactionCounts,
  redactionObserved,
  redactionSummary,
} from "./redaction.ts";
import {
  an,
  installed,
  j,
  markers,
  PASS,
  providerKey,
  redactionOf,
  SESSION_ID,
  toolResult,
} from "./redaction-test-support.ts";
import { SensitiveRule } from "./sensitive-text.ts";

const TOTAL_REDACTED = 3;
const PATTERN_COUNT = 2;
const KNOWN_COUNT = 1;
const UNKEPT_COUNT = 3;
const NO_FINDING = 0;
const SINGLE_FINDING = 1;

function zeroCounts(): RedactionCounts {
  return {
    redacted: {},
    scan_failed: 0,
    unkept: 0,
    restore_blocked: 0,
    output_found: {},
    thinking_kept: 0,
    compaction_residual: 0,
  };
}

test("redactionSummary keeps the fields of the open paths of today", () => {
  const summary = redactionSummary({
    ...zeroCounts(),
    redacted: {
      [SensitiveRule.QuotedAssignment]: PATTERN_COUNT,
      [SensitiveRule.LlmCredential]: KNOWN_COUNT,
    },
    scan_failed: KNOWN_COUNT,
    unkept: UNKEPT_COUNT,
    restore_blocked: KNOWN_COUNT,
    output_found: { [SensitiveRule.LlmCredential]: PATTERN_COUNT },
    thinking_kept: KNOWN_COUNT,
    compaction_residual: KNOWN_COUNT,
  });
  assert.deepEqual(summary, {
    redaction_count: TOTAL_REDACTED,
    redaction_rules: [
      SensitiveRule.LlmCredential,
      SensitiveRule.QuotedAssignment,
    ],
    redaction_failed: KNOWN_COUNT,
    unkept: UNKEPT_COUNT,
    restore_blocked: KNOWN_COUNT,
    compaction_residual: KNOWN_COUNT,
    thinking_kept: KNOWN_COUNT,
  });
  assert.equal(redactionObserved(summary), true);
  assert.equal(redactionObserved(redactionSummary(zeroCounts())), false);
});

test("with no assistantRedaction the output stays, thinking_kept and compaction_residual stay 0, and output_found counts each finding", async () => {
  const secret = providerKey();
  const state = createRedaction(async () => [secret], SESSION_ID);
  const { end, context, compact } = installed([
    markerRestore(state),
    inputRedaction(state),
    outputFinding(state),
  ]);
  const line = j("key ", secret);
  assert.equal(
    await end({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: line,
          thinkingSignature: "signature-bytes",
        },
        { type: "text", text: line },
      ],
      api: "anthropic-messages",
      timestamp: 1,
    }),
    undefined,
  );
  assert.equal(
    await context([
      {
        role: "compactionSummary",
        summary: line,
        tokensBefore: 1,
        timestamp: 1,
      },
    ]),
    undefined,
  );
  const entry = { summary: line };
  await compact(entry);
  assert.equal(entry.summary, line);
  assert.deepEqual(state.counts(), {
    ...zeroCounts(),
    output_found: { [SensitiveRule.LlmCredential]: PATTERN_COUNT },
  });
});

test("exitText gives the session marker of a pattern value and of a known secret, and modelOutput gives the same text", async () => {
  const secret = providerKey();
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.text("warm up");
  const value = an(16);
  const line = j(PASS, ' = "', value, '" key ', secret);
  const output = state.exitText(line);
  assert.ok(!output.includes(value));
  assert.ok(!output.includes(secret));
  const found = markers(output);
  assert.ok(
    found.some((marker) =>
      marker.startsWith(j("<redacted:", SensitiveRule.LlmCredential, ":")),
    ),
  );
  assert.ok(
    found.some((marker) =>
      marker.startsWith(j("<redacted:", SensitiveRule.QuotedAssignment, ":")),
    ),
  );
  assert.equal(state.modelOutput(line), output);
});

test("modelOutput masks every rule and adds no value to the known set", async () => {
  const { end, redaction } = redactionOf();
  const value = an(16);
  const output = redaction.modelOutput(j(PASS, ' = "', value, '"'));
  assert.ok(!output.includes(value));
  assert.equal(markers(output).length, SINGLE_FINDING);
  assert.equal(await end(toolResult(j("value ", value))), undefined);
});

test("text refreshes the known secrets and counts each finding", async () => {
  const current = { secrets: [] as string[] };
  const state = createRedaction(async () => current.secrets, SESSION_ID);
  const secret = j("tok", an(30));
  assert.equal(await state.text(secret), secret);
  current.secrets = [secret];
  const text = await state.text(secret);
  assert.ok(!text.includes(secret));
  assert.deepEqual(state.counts().redacted, {
    [SensitiveRule.LlmCredential]: SINGLE_FINDING,
  });
  assert.equal(state.counts().scan_failed, NO_FINDING);
});

test("recordOutputFinding counts a known secret in errorMessage", async () => {
  const secret = providerKey();
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.refresh();
  state.recordOutputFinding({
    role: "assistant",
    errorMessage: j("key ", secret),
  });
  assert.deepEqual(state.counts().output_found, {
    [SensitiveRule.LlmCredential]: SINGLE_FINDING,
  });
});
