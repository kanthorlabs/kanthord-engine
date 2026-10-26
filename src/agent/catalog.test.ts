import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  BASE_PROMPT,
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
    SWE_AGENT_PROMPT.includes("Run every test file that the change edits."),
  );
  assert.ok(
    SWE_AGENT_PROMPT.includes(
      "Run every test file that names such a symbol. Run the verification commands of the work prompt, also when a command runs a whole test suite. Do not run another whole test suite.",
    ),
  );
  assert.ok(
    SWE_AGENT_PROMPT.includes(
      "Run the compiler, type, lint and static-analysis checks of the codebase.",
    ),
  );
  assert.ok(RE_AGENT_PROMPT.includes("re@1"));
  assert.ok(
    RE_AGENT_PROMPT.includes(
      "The prose style and the finding format of a candidate report are no default-standard violation.",
    ),
  );
  assert.ok(WORKBENCH_PROMPT.startsWith("## Human interlocutor"));
});

function ruleNames(text: string): string[] {
  return [...text.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map((match) => match[1]!);
}

test("base prompt holds exactly the shared rules", () => {
  assert.deepEqual(ruleNames(BASE_PROMPT), [
    "Think before you act.",
    "Simplicity first.",
    "Surgical changes.",
    "Every text follows the ASD-STE100 style.",
    "No flattery.",
    "No secret in the work.",
  ]);
  for (const sentence of [
    "Keep the structure and the formatting that the request does not change, even when another choice is better.",
    "Mention a defect in adjacent content instead of a fix.",
    "Keep code, commands, names and identifiers exact.",
    "This rule governs every reply, report, assessment and document that you write.",
    "Write, log, print, send or report no secret: no token, password, key, credential hash or session record.",
  ])
    assert.ok(BASE_PROMPT.includes(sentence), sentence);
});

test("swe@1 and re@1 hold the code rules in the same words", () => {
  const heading = "## Code principles";
  const fileStart = 0;
  const sweStart = SWE_AGENT_PROMPT.indexOf(heading);
  const reStart = RE_AGENT_PROMPT.indexOf(heading);
  assert.ok(sweStart > fileStart);
  assert.ok(reStart > fileStart);
  const shared = SWE_AGENT_PROMPT.slice(sweStart);
  assert.equal(RE_AGENT_PROMPT.slice(reStart), shared);
  assert.deepEqual(ruleNames(shared), [
    "Simplicity in code.",
    "Surgical code changes.",
    "Prefer the built-ins of the platform.",
    "One responsibility per component.",
    "Code comments are forbidden.",
    "No leftover.",
    "Linear control flow.",
    "Bounded loops.",
    "Resource ownership.",
    "Small functions.",
    "Assertions.",
    "Explicit errors.",
    "Zero warnings.",
    "No test knowledge in production code.",
    "Bounded waits.",
    "No self-spawning test.",
    "Present every blocker and every suggestion as a bullet list, one item per bullet, in this exact format:",
  ]);
  assert.ok(shared.includes("`status:FIXED` when the work holds the change"));
});

test("unknown and inherited names are not agent declarations", () => {
  assert.equal(getAgentDeclaration("unknown"), undefined);
  assert.equal(getAgentDeclaration("constructor"), undefined);
  assert.equal(getAgentDeclaration("__proto__"), undefined);
});
