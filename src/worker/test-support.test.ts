import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  anthropicSetup,
  fauxAssistantMessage,
  scriptedModelRuntime,
  scriptedProvider,
} from "./test-support.ts";

test("scripted provider replaces the builtin and records execution auth for each turn", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network call");
  });
  const provider = scriptedProvider([
    fauxAssistantMessage("first"),
    fauxAssistantMessage("second"),
  ]);
  const credentials = new InMemoryCredentialStore();
  const key = "scripted-secret";
  await credentials.modify("anthropic", async () => ({ type: "api_key", key }));
  const setup = anthropicSetup();
  const { runtime, model } = await scriptedModelRuntime(provider)({
    credentials,
    setup,
    handoverItem: {
      credential_id: setup.credential_id,
      provider_id: "anthropic",
    },
    signal: new AbortController().signal,
  });
  for (const expected of ["first", "second"]) {
    const answer = await runtime.completeSimple(model, {
      systemPrompt: "system",
      messages: [{ role: "user", content: "next", timestamp: Date.now() }],
    });
    assert.deepEqual(answer.content, [{ type: "text", text: expected }]);
  }
  assert.deepEqual(
    provider.calls.map(({ apiKey }) => apiKey),
    [key, key],
  );
  assert.equal(
    runtime.getRegisteredNativeProvider("anthropic"),
    provider.provider,
  );
});
