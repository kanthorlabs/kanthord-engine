import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { seededText } from "./sensitive-text-test-support.ts";
import { SensitiveRule } from "./sensitive-text.ts";
import {
  createRedaction,
  REDACTION_LOG_MESSAGE,
  REDACTION_TABLE_MAX,
  type RedactionCounts,
  redactionObserved,
  redactionSummary,
  RestoreReason,
} from "./redaction.ts";

const j = (...parts: string[]) => parts.join("");
const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let { bytes } = seededText();
beforeEach(() => {
  ({ bytes } = seededText());
});
const an = (n: number) =>
  [...bytes(n)].map((byte) => AN[byte % AN.length]).join("");
const PASS = j("pass", "word");
const SESSION_ID = "session-1";

const TOTAL_REDACTED = 3;
const PATTERN_COUNT = 2;
const KNOWN_COUNT = 1;
const OUTPUT_FOUND = 2;
const UNKEPT_COUNT = 3;
const RESTORE_BLOCKED_COUNT = 1;
const TABLE_SIZE = 4096;
const NO_FINDINGS = 0;
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

test("REDACTION_LOG_MESSAGE is non-empty", () => {
  assert.ok(REDACTION_LOG_MESSAGE);
});

test("redactionSummary converts counts into summary fields", () => {
  const counts: RedactionCounts = {
    ...zeroCounts(),
    redacted: {
      [SensitiveRule.QuotedAssignment]: PATTERN_COUNT,
      [SensitiveRule.LlmCredential]: KNOWN_COUNT,
    },
    scan_failed: KNOWN_COUNT,
    unkept: UNKEPT_COUNT,
    restore_blocked: RESTORE_BLOCKED_COUNT,
    output_found: { [SensitiveRule.LlmCredential]: OUTPUT_FOUND },
    thinking_kept: KNOWN_COUNT,
    compaction_residual: KNOWN_COUNT,
  };
  const summary = redactionSummary(counts);
  assert.equal(summary.redaction_count, TOTAL_REDACTED);
  assert.deepEqual(
    summary.redaction_rules.sort(),
    [SensitiveRule.LlmCredential, SensitiveRule.QuotedAssignment].sort(),
  );
  assert.equal(summary.redaction_failed, KNOWN_COUNT);
  assert.equal(summary.unkept, UNKEPT_COUNT);
  assert.equal(summary.restore_blocked, RESTORE_BLOCKED_COUNT);
  assert.equal(summary.output_found_count, OUTPUT_FOUND);
  assert.deepEqual(summary.output_found_rules, [SensitiveRule.LlmCredential]);
  assert.equal(summary.thinking_kept, KNOWN_COUNT);
  assert.equal(summary.compaction_residual, KNOWN_COUNT);
});

test("redactionSummary produces zero fields from empty counts", () => {
  const summary = redactionSummary(zeroCounts());
  assert.equal(summary.redaction_count, NO_FINDINGS);
  assert.deepEqual(summary.redaction_rules, []);
  assert.equal(summary.redaction_failed, NO_FINDINGS);
  assert.equal(summary.output_found_count, NO_FINDINGS);
  assert.deepEqual(summary.output_found_rules, []);
});

test("redactionObserved returns false for empty counts and true when any field is non-zero", () => {
  assert.equal(redactionObserved(redactionSummary(zeroCounts())), false);
  const withFind = {
    ...redactionSummary(zeroCounts()),
    redaction_count: SINGLE_FINDING,
    redaction_rules: [SensitiveRule.QuotedAssignment],
  };
  assert.equal(redactionObserved(withFind), true);
  const withFailed = {
    ...redactionSummary(zeroCounts()),
    redaction_failed: SINGLE_FINDING,
  };
  assert.equal(redactionObserved(withFailed), true);
});

test("createRedaction.text redacts a pattern and counts the finding", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const value = an(16);
  const text = await state.text(j(PASS, ' = "', value, '"'));
  assert.ok(!text.includes(value));
  assert.ok(text.includes("<redacted:"));
  assert.equal(
    state.counts().redacted[SensitiveRule.QuotedAssignment],
    KNOWN_COUNT,
  );
});

test("createRedaction.text loads known secrets before each call", async () => {
  const current = { secrets: [] as string[] };
  const state = createRedaction(async () => current.secrets, SESSION_ID);
  const secret = j("tok", an(30));
  current.secrets = [secret];
  const text = await state.text(secret);
  assert.ok(!text.includes(secret));
});

test("createRedaction.exitText and modelOutput are identical on the same value", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const value = an(16);
  const line = j(PASS, ' = "', value, '"');
  assert.equal(state.exitText(line), state.modelOutput(line));
});

test("createRedaction.counts returns a snapshot that does not change after later calls", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const snap1 = state.counts();
  await state.text(j(PASS, ' = "', an(16), '"'));
  const snap2 = state.counts();
  assert.equal(snap1.redacted[SensitiveRule.QuotedAssignment], undefined);
  assert.equal(snap2.redacted[SensitiveRule.QuotedAssignment], KNOWN_COUNT);
});

test("createRedaction.takeWarnings drains the warning list", async () => {
  const secret = j("sk", "-ant-api03-", an(93));
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.refresh();
  state.recordOutputFinding({
    role: "assistant",
    content: [{ type: "text", text: j("key ", secret) }],
  });
  const first = state.takeWarnings();
  assert.equal(first.length, KNOWN_COUNT);
  assert.equal(state.takeWarnings().length, NO_FINDINGS);
});

test("createRedaction.hasKnownSecretIn returns true only when a known secret appears", async () => {
  const secret = j("sk", "-ant-api03-", an(93));
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.refresh();
  assert.equal(state.hasKnownSecretIn({ key: secret }), true);
  assert.equal(state.hasKnownSecretIn({ key: "plain" }), false);
  assert.equal(state.hasKnownSecretIn(undefined), false);
});

test("REDACTION_TABLE_MAX is the expected table size", () => {
  assert.equal(REDACTION_TABLE_MAX, TABLE_SIZE);
});

test("RestoreReason values are non-empty strings", () => {
  for (const value of Object.values(RestoreReason)) {
    assert.ok(value);
  }
  assert.ok(RestoreReason.KnownCredential);
});

test("createRedaction.redactSummaryText redacts a pattern in summary text", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const value = an(16);
  const result = state.redactSummaryText(j(PASS, ' = "', value, '"'));
  assert.ok(!result.includes(value));
});

test("createRedaction.redactSessionCompact increments compaction_residual", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const value = an(16);
  const result = state.redactSessionCompact(j(PASS, ' = "', value, '"'));
  assert.ok(!result.includes(value));
  assert.equal(state.counts().compaction_residual, KNOWN_COUNT);
});
