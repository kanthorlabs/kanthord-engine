import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  RE_AGENT_PROMPT,
  SWE_AGENT_PROMPT,
  WORKBENCH_PROMPT,
} from "./prompt-assets.ts";
import { AGENT_DECLARATIONS, getAgentDeclaration } from "./catalog.ts";

test("static agent declarations", () => {
  assert.deepEqual(Object.keys(AGENT_DECLARATIONS), ["swe@1", "re@1"]);
  assert.deepEqual(getAgentDeclaration("swe@1"), {
    agentName: "swe@1",
    agentPrompt: SWE_AGENT_PROMPT,
    hostTools: ["evidence-upload"],
    tools: ["read", "edit", "write", "grep", "find", "ls", "bash"],
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  });
  assert.deepEqual(getAgentDeclaration("re@1"), {
    agentName: "re@1",
    agentPrompt: RE_AGENT_PROMPT,
    hostTools: [],
    tools: ["read", "grep", "find", "ls"],
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  });
});

test("agent prompts are valid published UTF-8 assets", () => {
  const emptyLength = 0;
  const tab = "\t";
  const newline = "\n";
  const firstPrintable = 32;
  const deleteCharacter = 127;
  for (const file of ["base.md", "swe@1.md", "re@1.md", "workbench.md"]) {
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
  assert.ok(RE_AGENT_PROMPT.includes("re@1"));
  assert.ok(WORKBENCH_PROMPT.startsWith("## Human interlocutor"));
});

test("unknown and inherited names are not agent declarations", () => {
  assert.equal(getAgentDeclaration("unknown"), undefined);
  assert.equal(getAgentDeclaration("constructor"), undefined);
  assert.equal(getAgentDeclaration("__proto__"), undefined);
});
