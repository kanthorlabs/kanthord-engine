import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { credentialSecrets, mergedSecrets } from "./known-secrets.ts";

test("mergedSecrets returns the secrets of every source", async () => {
  const merged = mergedSecrets([
    async () => ["a", "b"],
    async () => ["b", "c"],
  ]);
  assert.deepEqual(await merged(), ["a", "b", "c"]);
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({ type: "api_key", key: "k1" }));
  await store.modify("openai", async () => ({
    type: "oauth",
    access: "a1",
    refresh: "r1",
    expires: 1,
  }));
  assert.deepEqual(await credentialSecrets(store, "anthropic")(), ["k1"]);
  assert.deepEqual(await credentialSecrets(store, "openai")(), ["a1", "r1"]);
  assert.deepEqual(await credentialSecrets(store, "absent")(), []);
});
