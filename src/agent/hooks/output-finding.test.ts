import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { seededText } from "../sensitive-text-test-support.ts";
import { SensitiveRule } from "../sensitive-text.ts";
import { createRedaction } from "../redaction.ts";
import { outputFinding } from "./output-finding.ts";

const j = (...parts: string[]) => parts.join("");
const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let { bytes } = seededText();
beforeEach(() => {
  ({ bytes } = seededText());
});
const an = (n: number) =>
  [...bytes(n)].map((byte) => AN[byte % AN.length]).join("");
const providerKey = () => j("sk", "-ant-api03-", an(93));
const SESSION_ID = "session-1";
const MESSAGE_END = "message_end";
const SINGLE_FINDING = 1;
const TRIPLE_FINDING = 3;

type Handler = (event: unknown, context?: unknown) => unknown;

function installed(state: ReturnType<typeof createRedaction>) {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (outputFinding(state) as (pi: ExtensionAPI) => void)(api);
  return async (message: Record<string, unknown>) => {
    let result: unknown;
    for (const handler of handlers.get(MESSAGE_END) ?? []) {
      const r = await handler({ type: MESSAGE_END, message }, {});
      if (r !== undefined) result = r;
    }
    return result;
  };
}

const assistant = (text: string, timestamp = 1) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  timestamp,
});

test("outputFinding records a known secret in an assistant message and returns undefined", async () => {
  const secret = providerKey();
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.refresh();
  const fire = installed(state);
  const result = await fire(assistant(j("use key ", secret)));
  assert.equal(result, undefined);
  assert.equal(
    state.counts().output_found[SensitiveRule.LlmCredential],
    SINGLE_FINDING,
  );
});

test("outputFinding ignores a non-assistant message", async () => {
  const secret = providerKey();
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.refresh();
  const fire = installed(state);
  await fire({
    role: "toolResult",
    toolCallId: "c",
    toolName: "read",
    content: [{ type: "text", text: j("key ", secret) }],
    details: {},
    isError: false,
    timestamp: 1,
  });
  assert.equal(
    state.counts().output_found[SensitiveRule.LlmCredential],
    undefined,
  );
});

test("outputFinding records no finding when the message holds no known secret", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const fire = installed(state);
  await fire(assistant("no secrets here"));
  assert.deepEqual(state.counts().output_found, {});
});

test("outputFinding accumulates findings across multiple messages", async () => {
  const key1 = providerKey();
  const key2 = providerKey();
  const state = createRedaction(async () => [key1, key2], SESSION_ID);
  await state.refresh();
  const fire = installed(state);
  await fire(assistant(key1));
  await fire(assistant(j(key2, " ", key2), 2));
  assert.equal(
    state.counts().output_found[SensitiveRule.LlmCredential],
    TRIPLE_FINDING,
  );
});
