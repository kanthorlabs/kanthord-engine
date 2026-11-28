import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LAYER_MESSAGE_TYPE, pinnedLayersHook } from "./pinned-layers.ts";

type Handler = (event: unknown, context?: unknown) => unknown;

const CONTEXT = "context";
const USER_ROLE = "user";
const SYSTEM_ROLE = "system";
const CUSTOM_ROLE = "custom";
const TEXT_TYPE = "text";
const LAYER_INDEX = 1;
const USER_INDEX = 2;
const SINGLE_MESSAGE = 1;
const LAYER_AT_START = 0;

function fire(
  pinned: () => string | null,
  messages: unknown[],
): unknown[] | undefined {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  (pinnedLayersHook(pinned) as (pi: ExtensionAPI) => void)(api);
  let result: unknown[] | undefined;
  for (const handler of handlers.get(CONTEXT) ?? []) {
    const r = handler({ type: CONTEXT, messages }, {}) as
      { messages: unknown[] } | undefined;
    if (r) result = r.messages;
  }
  return result;
}

const userMessage = (text: string) => ({
  role: USER_ROLE,
  content: [{ type: TEXT_TYPE, text }],
  timestamp: 1,
});

const layerMessage = (content: string) => ({
  role: CUSTOM_ROLE,
  customType: LAYER_MESSAGE_TYPE,
  content,
  display: false,
  timestamp: 1,
});

const systemMessage = (content: string) => ({
  role: SYSTEM_ROLE,
  content,
  sections: {},
  toolsAdded: [],
  timestamp: 0,
});

test("pinnedLayersHook injects the pinned layer before the first non-system message", () => {
  const work = "do the task";
  const messages = [systemMessage("sys"), userMessage("hello")];
  const result = fire(() => work, messages);
  assert.ok(result);
  assert.equal(result.length, messages.length + LAYER_INDEX);
  assert.equal(
    (result[LAYER_INDEX] as { customType: string }).customType,
    LAYER_MESSAGE_TYPE,
  );
  assert.equal((result[USER_INDEX] as { role: string }).role, USER_ROLE);
});

test("pinnedLayersHook omits the injection when the work message is already in the context", () => {
  const work = "do the task";
  const messages = [userMessage(work)];
  const result = fire(() => work, messages);
  assert.ok(result);
  assert.ok(
    !result.some(
      (m) => (m as { customType?: string }).customType === LAYER_MESSAGE_TYPE,
    ),
  );
});

test("pinnedLayersHook removes a stale layer message from prior context", () => {
  const messages = [layerMessage("old layer"), userMessage("user ask")];
  const result = fire(() => null, messages);
  assert.ok(result);
  assert.ok(
    !result.some(
      (m) => (m as { customType?: string }).customType === LAYER_MESSAGE_TYPE,
    ),
  );
  assert.equal(result.length, SINGLE_MESSAGE);
});

test("pinnedLayersHook injects at the start when there is no system message", () => {
  const work = "task";
  const messages = [userMessage("hello")];
  const result = fire(() => work, messages);
  assert.ok(result);
  assert.equal(
    (result[LAYER_AT_START] as { customType: string }).customType,
    LAYER_MESSAGE_TYPE,
  );
});
