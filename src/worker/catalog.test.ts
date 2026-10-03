import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  BASE_PROMPT,
  RE_AGENT_PROMPT,
  SWE_AGENT_PROMPT,
} from "./prompt-assets.ts";
import {
  AGENT_DECLARATIONS,
  REQUIRED_NODE_FORMAT,
  WORKER_CATALOG,
  WorkerHost,
  WorkerMethod,
  agentsOfWorker,
  getAgentDeclaration,
  getWorkerDeclaration,
} from "./catalog.ts";

const requiredNodeFormat = [
  "name",
  "requirement",
  "criterion",
  "verifications",
  "bindings",
];

test("static worker declarations", () => {
  assert.deepEqual(REQUIRED_NODE_FORMAT, requiredNodeFormat);
  assert.deepEqual(Object.keys(WORKER_CATALOG), [
    "general@1",
    "reviewer@1",
    "claude@1",
    "opencode@1",
  ]);
  assert.deepEqual(getWorkerDeclaration("general@1"), {
    name: "general@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Steps,
    agentName: "swe@1",
    resourceBudget: { turns: 200, wallTimeMs: 7200000 },
    declaredNodeStates: ["Available"],
    requiredNodeFormat,
  });
  assert.deepEqual(getWorkerDeclaration("reviewer@1"), {
    name: "reviewer@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Evaluation,
    agentName: "re@1",
    resourceBudget: { turns: 200, wallTimeMs: 7200000 },
    declaredNodeStates: ["Waiting", "External.Requested"],
    requiredNodeFormat,
  });
  assert.deepEqual(getWorkerDeclaration("claude@1"), {
    name: "claude@1",
    host: WorkerHost.ExternalHarness,
    harness: "claude-code",
    resourceBudget: { wallTimeMs: 7200000 },
    declaredNodeStates: ["Available", "Waiting", "External.Requested"],
    requiredNodeFormat,
  });
  assert.deepEqual(getWorkerDeclaration("opencode@1"), {
    name: "opencode@1",
    host: WorkerHost.ExternalHarness,
    harness: "opencode",
    resourceBudget: { wallTimeMs: 7200000 },
    declaredNodeStates: ["Available", "Waiting", "External.Requested"],
    requiredNodeFormat,
  });
});

test("static agent declarations", () => {
  assert.deepEqual(Object.keys(AGENT_DECLARATIONS), ["swe@1", "re@1"]);
  assert.deepEqual(getAgentDeclaration("swe@1"), {
    agentName: "swe@1",
    basePrompt: BASE_PROMPT,
    agentPrompt: SWE_AGENT_PROMPT,
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  });
  assert.deepEqual(getAgentDeclaration("re@1"), {
    agentName: "re@1",
    basePrompt: BASE_PROMPT,
    agentPrompt: RE_AGENT_PROMPT,
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  });
});

test("worker agent lookup returns a fresh array", () => {
  assert.deepEqual(agentsOfWorker("general@1"), ["swe@1"]);
  assert.deepEqual(agentsOfWorker("reviewer@1"), ["re@1"]);
  assert.deepEqual(agentsOfWorker("claude@1"), []);
  assert.deepEqual(agentsOfWorker("opencode@1"), []);
  assert.deepEqual(agentsOfWorker("unknown"), []);
  assert.notStrictEqual(
    agentsOfWorker("general@1"),
    agentsOfWorker("general@1"),
  );
});

test("agent prompts are valid published UTF-8 assets", () => {
  const emptyLength = 0;
  const tab = "\t";
  const newline = "\n";
  const firstPrintable = 32;
  const deleteCharacter = 127;
  for (const file of ["base.md", "swe@1.md", "re@1.md"]) {
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
  assert.equal(
    getAgentDeclaration("swe@1")!.basePrompt,
    getAgentDeclaration("re@1")!.basePrompt,
  );
  assert.ok(SWE_AGENT_PROMPT.startsWith("## Role"));
  assert.ok(SWE_AGENT_PROMPT.includes("swe@1"));
  assert.ok(RE_AGENT_PROMPT.includes("re@1"));
});

test("unknown and inherited names are not declarations", () => {
  assert.equal(getWorkerDeclaration("unknown"), undefined);
  assert.equal(getAgentDeclaration("unknown"), undefined);
  assert.equal(getWorkerDeclaration("constructor"), undefined);
  assert.equal(getWorkerDeclaration("__proto__"), undefined);
  assert.equal(getAgentDeclaration("constructor"), undefined);
  assert.equal(getAgentDeclaration("__proto__"), undefined);
});
