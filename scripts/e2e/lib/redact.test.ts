import test from "node:test";
import assert from "node:assert/strict";

import {
  createSecretRegistry,
  redact,
  redactedMarker,
  secrets,
} from "./redact.ts";
import { RunnerError } from "./errors.ts";

test("hold(value) shorter than 8 characters throws invalid-argument", () => {
  const registry = createSecretRegistry();

  assert.throws(
    () => registry.hold("short"),
    (error: unknown) =>
      error instanceof RunnerError &&
      error.code === "invalid-argument" &&
      error.message === "a secret must be at least 8 characters",
  );
});

test("redact(text) replaces a held value with the marker", () => {
  const registry = createSecretRegistry();
  registry.hold("abcdefgh12");

  assert.equal(
    registry.redact("Bearer abcdefgh12"),
    `Bearer ${redactedMarker}`,
  );
});

test("redact(text) replaces the longest matching form first, leaving one marker", () => {
  const registry = createSecretRegistry();
  registry.hold("abcdefgh12");
  registry.hold("abcdefgh12345");

  assert.equal(registry.redact("abcdefgh12345"), redactedMarker);
});

test("forms() for one held value has exactly three entries: the value, its base64, and the user:value@ form", () => {
  const registry = createSecretRegistry();
  registry.hold("abcdefgh12");

  assert.deepEqual(registry.forms(), [
    "abcdefgh12",
    Buffer.from("abcdefgh12").toString("base64"),
    "user:abcdefgh12@",
  ]);
});

test("redact(base64(value)) holds no readable secret", () => {
  const registry = createSecretRegistry();
  registry.hold("r-tok-long");

  const encoded = Buffer.from("reader:r-tok-long").toString("base64");
  const result = registry.redact(encoded);

  assert.equal(result.includes("r-tok-long"), false);
});

test("redact(basic-auth url) holds no bare secret value", () => {
  const registry = createSecretRegistry();
  registry.hold("w-tok-long");

  const result = registry.redact("http://writer:w-tok-long@127.0.0.1:7422/x");

  assert.equal(result.includes("w-tok-long"), false);
});

test("redact does not mutate the registry", () => {
  const registry = createSecretRegistry();
  registry.hold("abcdefgh12");

  const before = registry.values();
  registry.redact("Bearer abcdefgh12");
  const after = registry.values();

  assert.deepEqual(before, after);
});

test("the module-level secrets registry and the bound redact function share state", () => {
  secrets.hold("global-secret-1");

  assert.equal(
    redact("token is global-secret-1"),
    `token is ${redactedMarker}`,
  );
});
