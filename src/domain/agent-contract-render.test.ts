import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { agentContracts } from "./agent-contract.ts";
import {
  AgentContractError,
  renderAgentContract,
} from "./agent-contract-render.ts";
import { harnesses } from "./harness.ts";

const harnessIds = ["claude-code", "opencode"] as const;
const agentIds = ["general@1", "swe@1", "te@1", "re@1"] as const;

describe("src/domain/agent-contract-render", () => {
  it("holds the closed harness descriptors in lookup order", () => {
    assert.deepEqual(harnesses, [
      { id: "claude-code", denyByDefault: true },
      { id: "opencode", denyByDefault: true },
      { id: "pi", denyByDefault: false },
    ]);
  });

  for (const harnessId of harnessIds) {
    for (const agentId of agentIds) {
      it(`renders ${agentId} byte-identically for ${harnessId}`, () => {
        const contract = agentContracts[agentId];
        assert.ok(contract);
        const fixture = readFileSync(
          resolve(
            import.meta.dirname,
            `../../test/fixtures/agent-contract/${harnessId}/${agentId}.md`,
          ),
          "utf8",
        );

        assert.strictEqual(renderAgentContract(contract, harnessId), fixture);
      });
    }
  }

  it("refuses a harness that cannot deny tools by default", () => {
    const contract = agentContracts["re@1"];
    assert.ok(contract);
    assert.throws(
      () => renderAgentContract(contract, "pi"),
      (error: unknown) =>
        error instanceof AgentContractError &&
        error.code === "harness-cannot-deny",
    );
  });

  it("refuses an unknown harness", () => {
    const contract = agentContracts["re@1"];
    assert.ok(contract);
    assert.throws(
      () => renderAgentContract(contract, "unknown-harness"),
      (error: unknown) =>
        error instanceof AgentContractError && error.code === "harness-unknown",
    );
  });
});
