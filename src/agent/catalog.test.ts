import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  ARCHITECT_AGENT_PROMPT,
  COUNCIL_AGENT_PROMPT,
  DESIGNER_AGENT_PROMPT,
  PO_AGENT_PROMPT,
  RE_AGENT_PROMPT,
  SECURITY_AGENT_PROMPT,
  SWE_AGENT_PROMPT,
  USER_AGENT_PROMPT,
  WORKBENCH_PROMPT,
} from "./prompt-assets.ts";
import { AGENT_DECLARATIONS, getAgentDeclaration } from "./catalog.ts";

test("static agent declarations", () => {
  assert.deepEqual(Object.keys(AGENT_DECLARATIONS), [
    "swe@1",
    "re@1",
    "council@1",
    "po@1",
    "designer@1",
    "user@1",
    "architect@1",
    "security@1",
  ]);
  assert.deepEqual(getAgentDeclaration("swe@1"), {
    agent_name: "swe@1",
    agent_prompt: SWE_AGENT_PROMPT,
    host_tools: ["evidence-upload"],
    tools: ["read", "edit", "write", "grep", "find", "ls", "bash"],
    overridable_fields: [
      "agent_provider",
      "model_identifier",
      "reasoning_effort",
    ],
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
    ],
  });
  const councilPrompts = {
    "council@1": COUNCIL_AGENT_PROMPT,
    "po@1": PO_AGENT_PROMPT,
    "designer@1": DESIGNER_AGENT_PROMPT,
    "user@1": USER_AGENT_PROMPT,
    "architect@1": ARCHITECT_AGENT_PROMPT,
    "security@1": SECURITY_AGENT_PROMPT,
  };
  for (const [agentName, agentPrompt] of Object.entries(councilPrompts)) {
    assert.deepEqual(getAgentDeclaration(agentName), {
      agent_name: agentName,
      agent_prompt: agentPrompt,
      host_tools: [],
      tools: [],
      overridable_fields: [
        "agent_provider",
        "model_identifier",
        "reasoning_effort",
      ],
    });
    assert.ok(agentPrompt.startsWith("## Role"));
    assert.ok(agentPrompt.includes(agentName));
  }
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
    "workbench.md",
    "council@1.md",
    "po@1.md",
    "designer@1.md",
    "user@1.md",
    "architect@1.md",
    "security@1.md",
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
  assert.ok(RE_AGENT_PROMPT.includes("re@1"));
  assert.ok(WORKBENCH_PROMPT.startsWith("## Human interlocutor"));
});

test("unknown and inherited names are not agent declarations", () => {
  assert.equal(getAgentDeclaration("unknown"), undefined);
  assert.equal(getAgentDeclaration("constructor"), undefined);
  assert.equal(getAgentDeclaration("__proto__"), undefined);
});
