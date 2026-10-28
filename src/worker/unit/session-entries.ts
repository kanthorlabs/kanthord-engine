import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { canonicalJSON } from "../../kernel/json.ts";
import { isObject, isString } from "../../kernel/values.ts";
import {
  entryIdentitySchema,
  RecordKind,
  type SessionEntryRecord,
} from "../../tracking/contract.ts";

export const SESSION_ENTRY_MAX_BYTES = 61440;
const ENTRY_CUT_LOOSE_LIMIT = 4096;
const ENTRY_CUT_MEDIUM_LIMIT = 1024;
const ENTRY_CUT_TIGHT_LIMIT = 256;
export const ENTRY_CUT_LIMITS = [
  ENTRY_CUT_LOOSE_LIMIT,
  ENTRY_CUT_MEDIUM_LIMIT,
  ENTRY_CUT_TIGHT_LIMIT,
];
export const PINNED_CONTEXT_TYPE = "kanthord.pinned_context";

const REDACTED = "[redacted]";
const HALVES = 2;
const NO_CHARACTERS = 0;
const MESSAGE_TYPE = "message";
const TOOL_RESULT_ROLE = "toolResult";
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;
const FALLBACK_MESSAGE_FIELDS = [
  "role",
  "toolCallId",
  "toolName",
  "isError",
  "usage",
  "stopReason",
] as const;

type Fields = Record<string, unknown>;

function mapStrings(
  value: unknown,
  transform: (text: string) => string,
): unknown {
  if (isString(value)) return transform(value);
  if (Array.isArray(value))
    return value.map((item) => mapStrings(item, transform));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      mapStrings(item, transform),
    ]),
  );
}

export function redactSecrets(
  value: unknown,
  secrets: readonly string[],
): unknown {
  const present = secrets.filter((secret) => secret.length > NO_CHARACTERS);
  return mapStrings(value, (text) =>
    present.reduce(
      (result, secret) => result.split(secret).join(REDACTED),
      text,
    ),
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST;
}

export function cutString(text: string, limit: number): string {
  assert.ok(limit > NO_CHARACTERS);
  if (text.length <= limit) return text;
  const half = limit / HALVES;
  const headEnd = isHighSurrogate(text.charCodeAt(half - 1)) ? half - 1 : half;
  const tailStart = text.length - half;
  const tailFrom = isLowSurrogate(text.charCodeAt(tailStart))
    ? tailStart + 1
    : tailStart;
  const removed = tailFrom - headEnd;
  return `${text.slice(0, headEnd)}\n[cut ${removed} characters]\n${text.slice(tailFrom)}`;
}

function entryBytes(entry: unknown): number {
  return Buffer.byteLength(canonicalJSON(entry));
}

function fallbackEntry(copy: Fields): Fields {
  const { type, id, parentId, timestamp, message } = copy;
  const kept: Fields = { type, id, parentId, timestamp };
  if (type !== MESSAGE_TYPE || !isObject(message)) return kept;
  const fields = message as Fields;
  kept.message = Object.fromEntries(
    FALLBACK_MESSAGE_FIELDS.filter((name) => name in fields).map((name) => [
      name,
      fields[name],
    ]),
  );
  return kept;
}

function boundedEntry(copy: Fields): { entry: Fields; truncated: boolean } {
  if (entryBytes(copy) <= SESSION_ENTRY_MAX_BYTES)
    return { entry: copy, truncated: false };
  for (const limit of ENTRY_CUT_LIMITS) {
    const cut = mapStrings(copy, (text) => cutString(text, limit)) as Fields;
    if (entryBytes(cut) <= SESSION_ENTRY_MAX_BYTES)
      return { entry: cut, truncated: true };
  }
  return { entry: fallbackEntry(copy), truncated: true };
}

function toolCallIdOf(entry: SessionEntry): string | null {
  if (entry.type !== MESSAGE_TYPE) return null;
  if (entry.message.role !== TOOL_RESULT_ROLE) return null;
  return entry.message.toolCallId;
}

function entryTime(entry: SessionEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export function sessionEntryRecord(input: {
  traceId: string;
  sessionId: string;
  sequence: number;
  entry: SessionEntry;
  secrets: readonly string[];
}): SessionEntryRecord | null {
  const { entry } = input;
  if (!entryIdentitySchema.safeParse(entry.id).success) return null;
  if (
    entry.parentId !== null &&
    !entryIdentitySchema.safeParse(entry.parentId).success
  )
    return null;
  const snapshot: unknown = JSON.parse(JSON.stringify(entry));
  const copy = redactSecrets(snapshot, input.secrets);
  assert.ok(isObject(copy));
  const bounded = boundedEntry(copy as Fields);
  return {
    record_id: `${input.sessionId}:entry.${entry.id}`,
    trace_id: input.traceId,
    kind: RecordKind.SessionEntry,
    session_id: input.sessionId,
    entry_id: entry.id,
    parent_entry_id: entry.parentId,
    sequence: input.sequence,
    entry_type: entry.type,
    entry_time: entryTime(entry),
    tool_call_id: toolCallIdOf(entry),
    truncated: bounded.truncated,
    entry: bounded.entry,
  };
}
