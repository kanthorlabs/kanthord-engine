import type { AgentName } from "./contract.ts";
import {
  ENV_AGENT_PROMPT,
  RE_AGENT_PROMPT,
  SWE_AGENT_PROMPT,
} from "./prompt-assets.ts";

export interface AgentDeclaration {
  agent_name: string;
  overridable_fields: readonly string[];
  agent_prompt: string;
  workbench: boolean;
}

export const AGENT_DECLARATIONS: Readonly<Record<AgentName, AgentDeclaration>> =
  {
    "swe@1": {
      agent_name: "swe@1",
      agent_prompt: SWE_AGENT_PROMPT,
      overridable_fields: [
        "agent_provider",
        "model_identifier",
        "reasoning_effort",
        "fallback_configurations",
      ],
      workbench: true,
    },
    "re@1": {
      agent_name: "re@1",
      agent_prompt: RE_AGENT_PROMPT,
      overridable_fields: [
        "agent_provider",
        "model_identifier",
        "reasoning_effort",
        "fallback_configurations",
      ],
      workbench: true,
    },
    "env@1": {
      agent_name: "env@1",
      agent_prompt: ENV_AGENT_PROMPT,
      overridable_fields: [],
      workbench: false,
    },
  };

export const WORKBENCH_AGENT_NAMES: readonly string[] = Object.values(
  AGENT_DECLARATIONS,
)
  .filter((declaration) => declaration.workbench)
  .map((declaration) => declaration.agent_name);

export function getAgentDeclaration(
  agentName: string,
): AgentDeclaration | undefined {
  if (!Object.hasOwn(AGENT_DECLARATIONS, agentName)) return undefined;
  return AGENT_DECLARATIONS[agentName as AgentName];
}
