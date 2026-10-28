import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentDeclaration } from "../agent/catalog.ts";
import {
  agentsOfWorker,
  getWorkerDeclaration,
  RELEASED_WORKER_NAMES,
  WORKER_CATALOG,
  WorkerHost,
  WorkerMethod,
} from "./catalog.ts";

const declaredIntents = ["implement", "examine"];

test("static worker declarations", () => {
  assert.deepEqual(Object.keys(WORKER_CATALOG), [
    "coder@1",
    "reviewer@1",
    "claude-code@1",
  ]);
  assert.deepEqual(getWorkerDeclaration("coder@1"), {
    name: "coder@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Steps,
    agent_names: ["swe@1"],
    resource_budget: { turns: 200, wall_time_ms: 7200000 },
    declared_node_states: ["Available"],
    declared_intents: declaredIntents,
  });
  assert.deepEqual(getWorkerDeclaration("reviewer@1"), {
    name: "reviewer@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Evaluation,
    agent_names: ["re@1"],
    resource_budget: { turns: 200, wall_time_ms: 7200000 },
    declared_node_states: ["Waiting", "External.Requested"],
    declared_intents: declaredIntents,
  });
  assert.deepEqual(getWorkerDeclaration("claude-code@1"), {
    name: "claude-code@1",
    host: WorkerHost.ExternalHarness,
    harness: "claude-code",
    resource_budget: { wall_time_ms: 7200000 },
    declared_node_states: ["Available", "Waiting", "External.Requested"],
    declared_intents: declaredIntents,
  });
});

test("worker agent lookup returns a fresh array", () => {
  assert.deepEqual(agentsOfWorker("coder@1"), ["swe@1"]);
  assert.deepEqual(agentsOfWorker("reviewer@1"), ["re@1"]);
  assert.deepEqual(agentsOfWorker("claude-code@1"), []);
  assert.deepEqual(agentsOfWorker("unknown"), []);
  assert.notStrictEqual(agentsOfWorker("coder@1"), agentsOfWorker("coder@1"));
});

test("every native worker names an agent of the agent catalog", () => {
  for (const name of Object.keys(WORKER_CATALOG))
    for (const agentName of agentsOfWorker(name))
      assert.equal(getAgentDeclaration(agentName)?.agent_name, agentName);
});

test("every released worker is a declaration", () => {
  assert.deepEqual(RELEASED_WORKER_NAMES, ["coder@1", "reviewer@1"]);
  for (const name of RELEASED_WORKER_NAMES)
    assert.equal(getWorkerDeclaration(name)?.name, name);
});

test("unknown and inherited names are not declarations", () => {
  assert.equal(getWorkerDeclaration("unknown"), undefined);
  assert.equal(getWorkerDeclaration("general@1"), undefined);
  assert.equal(getWorkerDeclaration("developer@1"), undefined);
  assert.equal(getWorkerDeclaration("opencode@1"), undefined);
  assert.equal(getWorkerDeclaration("constructor"), undefined);
  assert.equal(getWorkerDeclaration("__proto__"), undefined);
});
