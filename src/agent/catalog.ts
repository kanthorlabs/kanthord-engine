import { Type } from "@earendil-works/pi-ai";
import { HostTool } from "../worker/contract.ts";
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
  tools: readonly BuiltinTool[];
  host_tools: readonly HostTool[];
  workbench: boolean;
}

export const EVIDENCE_UPLOAD_PARAMETERS = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const BuiltinTool = {
  Read: "read",
  Edit: "edit",
  Write: "write",
  Grep: "grep",
  Find: "find",
  Ls: "ls",
  Bash: "bash",
} as const;
export type BuiltinTool = (typeof BuiltinTool)[keyof typeof BuiltinTool];

export const AGENT_DECLARATIONS: Readonly<Record<AgentName, AgentDeclaration>> =
  {
    "swe@1": {
      agent_name: "swe@1",
      agent_prompt: SWE_AGENT_PROMPT,
      host_tools: [HostTool.EvidenceUpload],
      tools: [
        BuiltinTool.Read,
        BuiltinTool.Edit,
        BuiltinTool.Write,
        BuiltinTool.Grep,
        BuiltinTool.Find,
        BuiltinTool.Ls,
        BuiltinTool.Bash,
      ],
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
      host_tools: [],
      tools: [
        BuiltinTool.Read,
        BuiltinTool.Grep,
        BuiltinTool.Find,
        BuiltinTool.Ls,
      ],
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
      host_tools: [],
      tools: [
        BuiltinTool.Read,
        BuiltinTool.Grep,
        BuiltinTool.Find,
        BuiltinTool.Ls,
      ],
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
