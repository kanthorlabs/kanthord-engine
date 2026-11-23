import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeSystemPrompt,
  profilePrompt,
  systemPromptDigest,
} from "./prompt-chain.ts";
import { PROFILE_NAMES } from "./catalog.ts";

test("composeSystemPrompt joins profile then instructions with a separator", () => {
  const result = composeSystemPrompt(
    [{ heading: null, text: "profile" }],
    [{ heading: "Heading:", text: "instruction" }],
  );
  const expected = ["profile", "Heading:", "instruction"].join("\n\n");
  assert.equal(result, expected);
});

test("composeSystemPrompt renders a part with no heading as text only", () => {
  const result = composeSystemPrompt(
    [{ heading: null, text: "A" }],
    [{ heading: null, text: "B" }],
  );
  const expected = ["A", "B"].join("\n\n");
  assert.equal(result, expected);
});

test("composeSystemPrompt matches the join of today for the golden case", () => {
  const profile = [{ heading: null, text: "standard text" }];
  const instructions = [
    { heading: "File heading:", text: "file text" },
    { heading: "Repo heading:", text: "repo text" },
    { heading: "Binding heading:", text: "binding text" },
    { heading: null, text: "framing text" },
  ];
  const result = composeSystemPrompt(profile, instructions);
  const expected = [
    "standard text",
    ["File heading:", "file text"].join("\n\n"),
    ["Repo heading:", "repo text"].join("\n\n"),
    ["Binding heading:", "binding text"].join("\n\n"),
    "framing text",
  ].join("\n\n");
  assert.equal(result, expected);
});

test("composeSystemPrompt asserts the profile is not empty", () => {
  assert.throws(() =>
    composeSystemPrompt([], [{ heading: null, text: "text" }]),
  );
});

test("composeSystemPrompt asserts each profile text is not empty", () => {
  assert.throws(() => composeSystemPrompt([{ heading: null, text: "" }], []));
});

test("composeSystemPrompt asserts each instruction text is not empty", () => {
  assert.throws(() =>
    composeSystemPrompt(
      [{ heading: null, text: "profile" }],
      [{ heading: null, text: "" }],
    ),
  );
});

test("profilePrompt gives parts with no heading for each profile name", () => {
  for (const name of PROFILE_NAMES) {
    const parts = profilePrompt(name);
    assert.ok(parts.length);
    for (const p of parts) assert.equal(p.heading, null);
  }
});

test("profilePrompt gives fewer parts for a profile without a coding prompt", () => {
  assert.ok(profilePrompt("swe@1").length > profilePrompt("env@1").length);
});

test("systemPromptDigest is a SHA-256 hex string", () => {
  const d = systemPromptDigest("text");
  assert.match(d, /^[a-f0-9]{64}$/);
});

test("systemPromptDigest is deterministic", () => {
  assert.equal(systemPromptDigest("same"), systemPromptDigest("same"));
  assert.notEqual(systemPromptDigest("a"), systemPromptDigest("b"));
});
