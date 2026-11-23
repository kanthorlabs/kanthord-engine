import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeSystemPrompt,
  profilePrompt,
  systemPromptDigest,
} from "./prompt-chain.ts";
import { getProfile, PROFILE_NAMES } from "./catalog.ts";
import { BASE_PROMPT } from "./prompt-assets.ts";

const HEADING_WITH_EMPTY_TEXT = "profile\n\nHeading:\n\n";
const DIGEST_INPUT = "abc";
const DIGEST_INPUT_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

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

test("composeSystemPrompt renders a heading with an empty text as the heading and the separator", () => {
  const result = composeSystemPrompt(
    [{ heading: null, text: "profile" }],
    [{ heading: "Heading:", text: "" }],
  );
  assert.equal(result, HEADING_WITH_EMPTY_TEXT);
});

test("profilePrompt gives the Standard, the coding text of a coding profile and the Role, with no heading", () => {
  for (const name of PROFILE_NAMES) {
    const { prompt } = getProfile(name)!;
    assert.deepEqual(
      profilePrompt(name),
      [
        BASE_PROMPT,
        ...(prompt.coding === null ? [] : [prompt.coding]),
        prompt.role,
      ].map((text) => ({ heading: null, text })),
    );
  }
});

test("systemPromptDigest is the SHA-256 hex digest of the UTF-8 text", () => {
  assert.equal(systemPromptDigest(DIGEST_INPUT), DIGEST_INPUT_SHA256);
});
