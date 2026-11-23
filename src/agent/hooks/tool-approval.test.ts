import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type {
  ExtensionAPI,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { seededText } from "../sensitive-text-test-support.ts";
import { SESSION_MARKER_PATTERN } from "../sensitive-text.ts";
import { createRedaction } from "../redaction.ts";
import { markerRestore } from "./marker-restore.ts";
import { toolApproval } from "./tool-approval.ts";

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
const TOOL_CALL = "tool_call";
const OPERATION_TOOL = "custody_secret_set";
const WRITE_TOOL = "write";
const BASH_TOOL = "bash";
const REFUSED_REASON = "refused";
const NOT_ALLOWED_REASON = "not allowed";

type Handler = (event: unknown, context?: unknown) => unknown;

const markers = (value: string) =>
  [...value.matchAll(SESSION_MARKER_PATTERN)].map((match) => match[0]);

test("toolApproval throws when reason is empty", () => {
  assert.throws(() => toolApproval({ approve: async () => true, reason: "" }));
});

test("toolApproval allows when approve returns true and blocks when it returns false", async () => {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (
    toolApproval({
      approve: async (call) => call.toolName !== BASH_TOOL,
      reason: NOT_ALLOWED_REASON,
    }) as (pi: ExtensionAPI) => void
  )(api);
  const fire = async (toolName: string) => {
    const event = {
      type: TOOL_CALL,
      toolCallId: "c",
      toolName,
      input: {},
    } as unknown as ToolCallEvent;
    let result: unknown;
    for (const handler of handlers.get(TOOL_CALL) ?? []) {
      const r = await handler(event, {});
      if (r !== undefined) result = r;
    }
    return result;
  };
  assert.equal(await fire(WRITE_TOOL), undefined);
  assert.deepEqual(await fire(BASH_TOOL), {
    block: true,
    reason: NOT_ALLOWED_REASON,
  });
});

test("a later approval holds the unchanged marker of an operation input", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const value = an(16);
  const redacted = await state.text(j(PASS, ' = "', value, '"'));
  const marker = markers(redacted)[0]!;
  assert.ok(marker, "marker must be produced");
  const approvals = new Map<string, unknown>();
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (markerRestore(state) as (pi: ExtensionAPI) => void)(api);
  (
    toolApproval({
      approve: async (call) => {
        if (call.toolName === OPERATION_TOOL)
          approvals.set(call.toolCallId, structuredClone(call.input));
        return true;
      },
      reason: REFUSED_REASON,
    }) as (pi: ExtensionAPI) => void
  )(api);
  const fire = async (
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
  ) => {
    const event = {
      type: TOOL_CALL,
      toolCallId,
      toolName,
      input,
    } as unknown as ToolCallEvent;
    for (const handler of handlers.get(TOOL_CALL) ?? [])
      await handler(event, {});
    return event.input;
  };
  await fire(OPERATION_TOOL, "op", { secret_value: marker });
  assert.deepEqual(approvals.get("op"), { secret_value: marker });
  assert.deepEqual(await fire(WRITE_TOOL, "w", { content: marker }), {
    content: value,
  });
  assert.equal(approvals.has("w"), false);
});
