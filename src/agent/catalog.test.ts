import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  ENV_AGENT_PROMPT,
  RE_AGENT_PROMPT,
  SWE_AGENT_PROMPT,
  WORKBENCH_PROMPT,
} from "./prompt-assets.ts";
import {
  AGENT_DECLARATIONS,
  getAgentDeclaration,
  WORKBENCH_AGENT_NAMES,
} from "./catalog.ts";

test("static agent declarations", () => {
  assert.deepEqual(Object.keys(AGENT_DECLARATIONS), ["swe@1", "re@1", "env@1"]);
  assert.deepEqual(getAgentDeclaration("swe@1"), {
    agent_name: "swe@1",
    agent_prompt: SWE_AGENT_PROMPT,
    host_tools: ["evidence-upload"],
    tools: ["read", "edit", "write", "grep", "find", "ls", "bash"],
    overridable_fields: [
      "agent_provider",
      "model_identifier",
      "reasoning_effort",
      "fallback_configurations",
    ],
    workbench: true,
  });
  assert.deepEqual(getAgentDeclaration("re@1"), {
    agent_name: "re@1",
    agent_prompt: RE_AGENT_PROMPT,
    host_tools: [],
    tools: ["read", "grep", "find", "ls"],
    overridable_fields: [
      "agent_provider",
      "model_identifier",
      "reasoning_effort",
      "fallback_configurations",
    ],
    workbench: true,
  });
  assert.deepEqual(getAgentDeclaration("env@1"), {
    agent_name: "env@1",
    agent_prompt: ENV_AGENT_PROMPT,
    host_tools: [],
    tools: ["read", "grep", "find", "ls"],
    overridable_fields: [],
    workbench: false,
  });
  assert.deepEqual(WORKBENCH_AGENT_NAMES, ["swe@1", "re@1"]);
});

test("env@1 prompt equals the shipped file", () => {
  assert.equal(
    ENV_AGENT_PROMPT,
    readFileSync(
      new URL("../../static/prompt/env@1.md", import.meta.url),
      "utf8",
    ),
  );
});

test("agent prompts are valid published UTF-8 assets", () => {
  const emptyLength = 0;
  const tab = "\t";
  const newline = "\n";
  const firstPrintable = 32;
  const deleteCharacter = 127;
  for (const file of [
    "base.md",
    "swe@1.md",
    "re@1.md",
    "env@1.md",
    "workbench.md",
  ]) {
    const bytes = readFileSync(
      new URL(`../../static/prompt/${file}`, import.meta.url),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.ok(text.length > emptyLength);
    assert.ok(
      [...text].every(
        (character) =>
          character === tab ||
          character === newline ||
          (character.codePointAt(0)! >= firstPrintable &&
            character.codePointAt(0) !== deleteCharacter),
      ),
    );
  }
  assert.ok(SWE_AGENT_PROMPT.startsWith("## Role"));
  assert.ok(SWE_AGENT_PROMPT.includes("swe@1"));
  assert.ok(
    SWE_AGENT_PROMPT.includes("Never run the whole test suite of a directory."),
  );
  assert.ok(RE_AGENT_PROMPT.includes("re@1"));
  assert.ok(WORKBENCH_PROMPT.startsWith("## Human interlocutor"));
});

test("unknown and inherited names are not agent declarations", () => {
  assert.equal(getAgentDeclaration("unknown"), undefined);
  assert.equal(getAgentDeclaration("constructor"), undefined);
  assert.equal(getAgentDeclaration("__proto__"), undefined);
});
