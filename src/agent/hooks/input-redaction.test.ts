import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { seededText } from "../sensitive-text-test-support.ts";
import { SESSION_MARKER_PATTERN } from "../sensitive-text.ts";
import { createRedaction } from "../redaction.ts";
import { inputRedaction } from "./input-redaction.ts";

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
const TURN_START = "turn_start";
const MESSAGE_END = "message_end";
const SINGLE_MARKER = 1;

type Handler = (event: unknown, context?: unknown) => unknown;

const markers = (value: unknown) =>
  [...JSON.stringify(value).matchAll(SESSION_MARKER_PATTERN)].map(
    (match) => match[0],
  );

function installed(state: ReturnType<typeof createRedaction>) {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (inputRedaction(state) as (pi: ExtensionAPI) => void)(api);
  const fire = async (name: string, event: unknown) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const r = await handler(event, {});
      if (r !== undefined) result = r;
    }
    return result;
  };
  return {
    turn: () => fire(TURN_START, { type: TURN_START }),
    end: async (message: Record<string, unknown>) => {
      const result = (await fire(MESSAGE_END, {
        type: MESSAGE_END,
        message,
      })) as { message: Record<string, unknown> } | undefined;
      return result?.message;
    },
  };
}

const toolResult = (text: string) => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text", text }],
  details: {},
  isError: false,
  timestamp: 1,
});

test("inputRedaction redacts toolResult and user messages on message_end", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const { end } = installed(state);
  const value = an(16);
  const line = j(PASS, ' = "', value, '"');
  const copy = await end(toolResult(line));
  assert.ok(copy, "toolResult must be redacted");
  assert.ok(!JSON.stringify(copy).includes(value));
  assert.equal(markers(copy).length, SINGLE_MARKER);
});

test("inputRedaction leaves assistant messages unchanged", async () => {
  const state = createRedaction(async () => [], SESSION_ID);
  const { end } = installed(state);
  const value = an(16);
  const result = await end({
    role: "assistant",
    content: [{ type: "text", text: j(PASS, ' = "', value, '"') }],
    api: "anthropic-messages",
    timestamp: 1,
  });
  assert.equal(result, undefined);
});

test("inputRedaction refreshes secrets on turn_start", async () => {
  const current = { secrets: [] as string[] };
  const state = createRedaction(async () => current.secrets, SESSION_ID);
  const { turn, end } = installed(state);
  const secret = j("tok", an(30));
  current.secrets = [secret];
  await turn();
  const copy = await end(toolResult(secret));
  assert.ok(!JSON.stringify(copy).includes(secret));
});
