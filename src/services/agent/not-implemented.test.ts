import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NotImplementedAgent } from "./not-implemented.ts";
import { AgentError, type AgentRequest } from "./index.ts";

const request: AgentRequest = {
  agent: "general@1",
  prompt: "do the thing",
  workspacePath: "/tmp/workspace",
  timeoutMs: 1000,
};

describe("src/services/agent/not-implemented.test", () => {
  it("invoke throws AgentError(not-implemented) synchronously", () => {
    const agent = new NotImplementedAgent();
    assert.throws(
      () => {
        agent.invoke(request);
      },
      (error: unknown) => {
        if (!(error instanceof AgentError)) {
          throw error;
        }
        assert.equal(error.code, "not-implemented");
        assert.equal(error.name, "AgentError");
        assert.equal(
          error.message,
          "the agent service is implemented in phase 2",
        );
        return true;
      },
    );
  });
});
