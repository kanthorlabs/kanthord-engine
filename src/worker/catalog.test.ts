import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentDeclaration } from "../agent/catalog.ts";
import {
  agentsOfWorker,
  getWorkerDeclaration,
  WORKER_CATALOG,
} from "./catalog.ts";

test("every native worker names an agent of the agent catalog", () => {
  for (const name of Object.keys(WORKER_CATALOG))
    for (const agentName of agentsOfWorker(name))
      assert.equal(getAgentDeclaration(agentName)?.agent_name, agentName);
});

test("unknown and inherited names are not declarations", () => {
  assert.equal(getWorkerDeclaration("unknown"), undefined);
  assert.equal(getWorkerDeclaration("constructor"), undefined);
  assert.equal(getWorkerDeclaration("__proto__"), undefined);
});
