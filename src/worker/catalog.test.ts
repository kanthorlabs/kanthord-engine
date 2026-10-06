import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentDeclaration } from "../agent/catalog.ts";
import {
  REQUIRED_NODE_FORMAT,
  WORKER_CATALOG,
  WorkerHost,
  WorkerMethod,
  agentsOfWorker,
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

test("every native worker names an agent of the agent catalog", () => {
  for (const name of Object.keys(WORKER_CATALOG))
    for (const agentName of agentsOfWorker(name))
      assert.equal(getAgentDeclaration(agentName)?.agentName, agentName);
});

test("unknown and inherited names are not declarations", () => {
  assert.equal(getWorkerDeclaration("unknown"), undefined);
  assert.equal(getWorkerDeclaration("constructor"), undefined);
  assert.equal(getWorkerDeclaration("__proto__"), undefined);
});
