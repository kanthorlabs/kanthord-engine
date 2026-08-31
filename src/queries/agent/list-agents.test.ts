import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { agentListResponse } from "../../http/contract/instruction.ts";
import { listAgents } from "./list-agents.ts";

describe("src/queries/agent/list-agents", () => {
  it("returns the agent contracts in declaration order", () => {
    assert.deepEqual(listAgents({}, {}), [
      {
        agent: "general@1",
        purpose: "Does any task end to end.",
        capabilities: {
          tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        },
      },
      {
        agent: "swe@1",
        purpose: "Writes production code. Writes no test.",
        capabilities: {
          tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        },
      },
      {
        agent: "te@1",
        purpose: "Writes tests. Writes no production code.",
        capabilities: {
          tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        },
      },
      {
        agent: "re@1",
        purpose: "Reviews a diff against acceptance criteria.",
        capabilities: { tools: ["read", "bash", "grep", "find", "ls"] },
      },
    ]);
  });

  it("returns a response that validates against the agent list schema", () => {
    assert.doesNotThrow(() =>
      agentListResponse.parse({ agents: listAgents({}, {}) }),
    );
  });
});
