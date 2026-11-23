import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { seededText } from "../sensitive-text-test-support.ts";
import { SESSION_MARKER_PATTERN } from "../sensitive-text.ts";
import { createRedaction, RestoreReason } from "../redaction.ts";
import { markerRestore } from "./marker-restore.ts";

const j = (...parts: string[]) => parts.join("");
const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let { bytes } = seededText();
beforeEach(() => {
  ({ bytes } = seededText());
});
const an = (n: number) =>
  [...bytes(n)].map((byte) => AN[byte % AN.length]).join("");
const PASS = j("pass", "word");
const providerKey = () => j("sk", "-ant-api03-", an(93));
const SESSION_ID = "session-1";
const TOOL_CALL = "tool_call";
const AGENT_END = "agent_end";
const WRITE = "write";
const BASH = "bash";
const SINGLE_RESTORE_BLOCKED = 1;
const NO_RESTORE_BLOCKED = 0;

type Handler = (event: unknown, context?: unknown) => unknown;

function installed(state: ReturnType<typeof createRedaction>) {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (markerRestore(state) as (pi: ExtensionAPI) => void)(api);
  const call = async (
    toolName: string,
    input: Record<string, unknown>,
    extra = {},
  ) => {
    const event = {
      type: TOOL_CALL,
      toolCallId: "call-1",
      toolName,
      input,
      ...extra,
    };
    let result: unknown;
    for (const handler of handlers.get(TOOL_CALL) ?? []) {
      const r = await handler(event, {});
      if (r !== undefined) result = r;
    }
    return result as { block: boolean; reason: string } | undefined;
  };
  const agentEnd = async () => {
    for (const handler of handlers.get(AGENT_END) ?? [])
      await handler({ type: AGENT_END, messages: [] }, {});
  };
  return { call, agentEnd };
}

const markers = (value: string) =>
  [...value.matchAll(SESSION_MARKER_PATTERN)].map((match) => match[0]);

test("markerRestore blocks when the input holds a known secret as raw text", async () => {
  const secret = providerKey();
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.refresh();
  const { call } = installed(state);
  const result = await call(WRITE, { content: j("key=", secret) });
  assert.deepEqual(result, {
    block: true,
    reason: RestoreReason.KnownCredential,
  });
  assert.equal(state.counts().restore_blocked, SINGLE_RESTORE_BLOCKED);
});

test("markerRestore blocks a known secret in a nested value of the input", async () => {
  const secret = providerKey();
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.refresh();
  const { call } = installed(state);
  const result = await call(WRITE, {
    path: "a.txt",
    content: j("ANTHROPIC_API_KEY=", secret),
  });
  assert.deepEqual(result, {
    block: true,
    reason: RestoreReason.KnownCredential,
  });
});

test("markerRestore passes a tool input that holds no known secret and no marker", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const { call } = installed(state);
  assert.equal(await call(WRITE, { content: "plain text" }), undefined);
  assert.equal(await call(BASH, { command: "ls" }), undefined);
});

test("markerRestore restores a write input and blocks a bash input", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const value = an(16);
  const redacted = await state.text(j(PASS, ' = "', value, '"'));
  const marker = markers(redacted)[0]!;
  const { call } = installed(state);
  const write = { content: marker };
  assert.equal(await call(WRITE, write), undefined);
  assert.equal(write.content, value);
  const redacted2 = await state.text(j(PASS, ' = "', an(16), '"'));
  const marker2 = markers(redacted2)[0]!;
  const bash = { command: j("echo ", marker2) };
  const blocked = await call(BASH, bash);
  assert.deepEqual(blocked, { block: true, reason: RestoreReason.Shell });
});

test("markerRestore clears pending on agent_end", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const { agentEnd } = installed(state);
  await agentEnd();
  assert.equal(state.counts().restore_blocked, NO_RESTORE_BLOCKED);
});
