import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_AGENTS, CouncilErrorCode, RoleAgent } from "./contract.ts";
import { requireEnabled, type EnablementReader } from "./enablement.ts";

const CONFIGURATION = {
  agent_provider: "main",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "medium",
} as const;

test("requireEnabled answers the default configuration of every agent", async () => {
  const read: EnablementReader = async () => ({
    state: "enabled",
    default_configuration: CONFIGURATION,
  });
  const configurations = await requireEnabled(read);
  assert.deepEqual([...configurations.keys()], [...ALL_AGENTS]);
  assert.deepEqual(configurations.get("po@1"), CONFIGURATION);
});

test("requireEnabled lists every absent and disabled agent", async () => {
  const read: EnablementReader = async (agentName) =>
    agentName === RoleAgent.Po
      ? undefined
      : agentName === RoleAgent.Security
        ? { state: "disabled", default_configuration: CONFIGURATION }
        : { state: "enabled", default_configuration: CONFIGURATION };
  await assert.rejects(requireEnabled(read), {
    code: CouncilErrorCode.AgentNotEnabled,
    message: /po@1, security@1/,
  });
});
