import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryRecordSchema } from "../../tracking/contract.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import {
  cutString,
  ENTRY_CUT_LIMITS,
  SESSION_ENTRY_MAX_BYTES,
  sessionEntryRecord,
} from "./session-entries.ts";
import {
  knownMatcher,
  SensitiveRule,
  tracerMarker,
} from "../../agent/sensitive-text.ts";

const TRACE_ID = "a".repeat(32);
const SESSION_ID = "1".repeat(16);
const SECRET = "sk-test-secret-value";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TOOL_CALL_ID = `call_x|fc_${"ab12cd34".repeat(6)}`;
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const KANTHORD_IDENTITY = "execution_01J9ZQ4XKM3B6V8N2R5T7W0EB2";
const HUNDRED_KIB = 100 * 1024;
const FIRST_CUT_LIMIT = 4096;
const HALF_OF_FIRST_LIMIT = FIRST_CUT_LIMIT / 2;
const LONG_STRING = 5000;
const STRINGS_FOR_SECOND_LIMIT = 20;
const STRINGS_FOR_FALLBACK = 1000;
const ENTRY_ID = "1a2b3c4d";
const PARENT_ID = "0a1b2c3d";
const TIMESTAMP = "2026-01-02T03:04:05.000Z";
const USAGE = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
const FIRST_SEQUENCE = 1;
const NO_SECRETS: string[] = [];
const MARKER = /\n\[cut (\d+) characters\]\n/;
const MARKER_SPLIT = /\n\[cut \d+ characters\]\n/;

function entry(fields: Record<string, unknown>): SessionEntry {
  return {
    type: "message",
    id: ENTRY_ID,
    parentId: PARENT_ID,
    timestamp: TIMESTAMP,
    ...fields,
  } as SessionEntry;
}

function custom(fields: Record<string, unknown>): SessionEntry {
  return entry({ type: "custom", customType: "x", ...fields });
}

function toolResult(content: unknown, extra: Record<string, unknown> = {}) {
  return entry({
    message: {
      role: "toolResult",
      toolCallId: TOOL_CALL_ID,
      toolName: "bash",
      isError: false,
      content,
      timestamp: 1,
      ...extra,
    },
  });
}

function recordOf(
  value: SessionEntry,
  secrets: readonly string[] = NO_SECRETS,
) {
  const matcher = knownMatcher();
  for (const secret of secrets) matcher.addSecret(secret);
  return sessionEntryRecord({
    traceId: TRACE_ID,
    sessionId: SESSION_ID,
    sequence: FIRST_SEQUENCE,
    entry: value,
    matcher,
  });
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(canonicalJSON(value));
}

function manyStrings(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "text",
    text: `${index}:${"x".repeat(LONG_STRING)}`,
  }));
}

test("a small entry is whole and a secret becomes the tracer marker", () => {
  const value = toolResult([{ type: "text", text: `key ${SECRET} end` }]);
  const record = recordOf(value, [SECRET]);
  assert.ok(record);
  assert.equal(record.truncated, false);
  assert.deepEqual(record.entry.message, {
    role: "toolResult",
    toolCallId: TOOL_CALL_ID,
    toolName: "bash",
    isError: false,
    content: [
      {
        type: "text",
        text: `key ${tracerMarker(SensitiveRule.LlmCredential)} end`,
      },
    ],
    timestamp: 1,
  });
  assert.equal(sessionEntryRecordSchema.safeParse(record).success, true);
});

test("the record copies the entry, keeps its keys and ignores an empty secret", () => {
  const data = { [SECRET]: [`a ${SECRET} b ${SECRET}`, 3, null, true] };
  const value = custom({ data });
  const record = recordOf(value, ["", SECRET]);
  const marker = tracerMarker(SensitiveRule.LlmCredential);
  assert.deepEqual(record?.entry.data, {
    [SECRET]: [`a ${marker} b ${marker}`, 3, null, true],
  });
  assert.deepEqual((value as unknown as { data: unknown }).data, {
    [SECRET]: [`a ${SECRET} b ${SECRET}`, 3, null, true],
  });
});

test("the record masks a pattern finding with the tracer marker", () => {
  const fakeKey = ["AKIA", "KANTHORDCANARY01"].join("");
  const record = recordOf(
    toolResult([{ type: "text", text: `id ${fakeKey} end` }]),
  );
  const message = record?.entry.message as { content: { text: string }[] };
  assert.equal(
    message.content[0]?.text,
    `id ${tracerMarker(SensitiveRule.AwsAccessKeyId)} end`,
  );
});

test("commit, tool call, UUID and kanthord identities stay whole", () => {
  const text = [COMMIT, TOOL_CALL_ID, UUID, KANTHORD_IDENTITY].join(" ");
  const record = recordOf(toolResult([{ type: "text", text }]), [SECRET]);
  assert.ok(record);
  const message = record.entry.message as { content: { text: string }[] };
  assert.equal(message.content[0]?.text, text);
  assert.equal(record.tool_call_id, TOOL_CALL_ID);
  const uuidRecord = recordOf(custom({ id: UUID, parentId: UUID }));
  assert.equal(uuidRecord?.entry_id, UUID);
  assert.equal(uuidRecord?.parent_entry_id, UUID);
});

test("an entry of 100 KiB keeps the head and the tail of each long string", () => {
  const head = "H".repeat(HALF_OF_FIRST_LIMIT);
  const tail = "T".repeat(HALF_OF_FIRST_LIMIT);
  const text = `${head}${"m".repeat(HUNDRED_KIB)}${tail}`;
  const record = recordOf(toolResult([{ type: "text", text }]));
  assert.ok(record);
  assert.equal(record.truncated, true);
  const cut = (record.entry.message as { content: { text: string }[] })
    .content[0]!.text;
  const [before, after] = cut.split(MARKER_SPLIT);
  assert.equal(before, head);
  assert.equal(after, tail);
  assert.equal(Number(MARKER.exec(cut)?.[1]), HUNDRED_KIB);
  assert.ok(bytesOf(record.entry) <= SESSION_ENTRY_MAX_BYTES);
});

test("an entry that the limit 4096 cannot bound falls to the limit 1024", () => {
  const record = recordOf(toolResult(manyStrings(STRINGS_FOR_SECOND_LIMIT)));
  assert.ok(record);
  assert.equal(record.truncated, true);
  const content = (record.entry.message as { content: { text: string }[] })
    .content;
  assert.ok(content[0]!.text.length > ENTRY_CUT_LIMITS[2]!);
  assert.ok(content[0]!.text.length < FIRST_CUT_LIMIT);
  assert.ok(bytesOf(record.entry) <= SESSION_ENTRY_MAX_BYTES);
});

test("an entry that the limit 256 cannot bound falls to the fallback fields", () => {
  const record = recordOf(
    toolResult(manyStrings(STRINGS_FOR_FALLBACK), {
      usage: USAGE,
      stopReason: "stop",
    }),
  );
  assert.ok(record);
  assert.equal(record.truncated, true);
  assert.deepEqual(record.entry, {
    type: "message",
    id: ENTRY_ID,
    parentId: PARENT_ID,
    timestamp: TIMESTAMP,
    message: {
      role: "toolResult",
      toolCallId: TOOL_CALL_ID,
      toolName: "bash",
      isError: false,
      usage: USAGE,
      stopReason: "stop",
    },
  });
});

test("the fallback of an entry without a message holds the four base fields", () => {
  const record = recordOf(custom({ data: manyStrings(STRINGS_FOR_FALLBACK) }));
  assert.deepEqual(record?.entry, {
    type: "custom",
    id: ENTRY_ID,
    parentId: PARENT_ID,
    timestamp: TIMESTAMP,
  });
});

test("a cut keeps a surrogate pair whole", () => {
  const headSplit = `${"x".repeat(HALF_OF_FIRST_LIMIT - 1)}😀${"y".repeat(HUNDRED_KIB)}`;
  const tailSplit = `${"x".repeat(HUNDRED_KIB)}😀${"y".repeat(HALF_OF_FIRST_LIMIT - 1)}`;
  const whole = `${"x".repeat(HUNDRED_KIB)}😀${"y".repeat(HUNDRED_KIB)}`;
  for (const text of [headSplit, tailSplit, whole]) {
    const cut = cutString(text, FIRST_CUT_LIMIT);
    assert.ok(cut.isWellFormed());
    const [before, after] = cut.split(MARKER_SPLIT);
    assert.ok(before!.length >= HALF_OF_FIRST_LIMIT - 1);
    assert.ok(after!.length >= HALF_OF_FIRST_LIMIT - 1);
    const removed = Number(MARKER.exec(cut)?.[1]);
    assert.equal(before!.length + removed + after!.length, text.length);
  }
});

test("an invalid entry identity answers null", () => {
  assert.equal(recordOf(custom({ id: "BAD ID" })), null);
  assert.equal(recordOf(custom({ parentId: "bad id" })), null);
});
