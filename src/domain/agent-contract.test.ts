import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentContracts, tools } from "./agent-contract.ts";
import { workerRegistry } from "./worker-registry.ts";

describe("src/domain/agent-contract", () => {
  it("holds the closed tool whitelist in contract order", () => {
    assert.deepEqual(tools, [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("declares all four role contracts with exact tool whitelists", () => {
    assert.deepEqual(agentContracts, {
      "general@1": {
        agent: "general@1",
        purpose: "Does any task end to end.",
        capabilities: { tools },
      },
      "swe@1": {
        agent: "swe@1",
        purpose: "Writes production code. Writes no test.",
        capabilities: { tools },
      },
      "te@1": {
        agent: "te@1",
        purpose: "Writes tests. Writes no production code.",
        capabilities: { tools },
      },
      "re@1": {
        agent: "re@1",
        purpose: "Reviews a diff against acceptance criteria.",
        capabilities: {
          tools: ["read", "bash", "grep", "find", "ls"],
        },
      },
    });
  });

  it("omits edit and write from the review role", () => {
    const reviewTools = agentContracts["re@1"]?.capabilities.tools;
    assert.ok(reviewTools);
    assert.deepEqual(reviewTools, ["read", "bash", "grep", "find", "ls"]);
    assert.equal(reviewTools.includes("edit"), false);
    assert.equal(reviewTools.includes("write"), false);
  });

  it("gives general, software and test roles equal tool sets", () => {
    assert.deepEqual(
      agentContracts["swe@1"]?.capabilities.tools,
      agentContracts["te@1"]?.capabilities.tools,
    );
    assert.deepEqual(
      agentContracts["general@1"]?.capabilities.tools,
      agentContracts["swe@1"]?.capabilities.tools,
    );
  });

  it("leaves role path ownership unrepresented", () => {
    assert.equal(
      Object.values(agentContracts).every((contract) => !("paths" in contract)),
      true,
    );
  });

  it("keeps role contracts independent from the worker registry", () => {
    const agents = new Set(Object.keys(agentContracts));
    assert.equal(
      workerRegistry.every((worker) =>
        worker.agents.every((agent) => !agents.has(agent)),
      ),
      true,
    );
  });
});
