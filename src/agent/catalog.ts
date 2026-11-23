import {
  EVIDENCE_UPLOAD_PARAMETERS,
  HOST_TOOL_PARAMETERS,
  HostTool,
  LINK_UPDATE_LIST_PARAMETERS,
} from "../worker/contract.ts";
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

export interface ToolEntry {
  locations: readonly string[];
}

export {
  EVIDENCE_UPLOAD_PARAMETERS,
  HOST_TOOL_PARAMETERS,
  LINK_UPDATE_LIST_PARAMETERS,
};

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

export const EnvironmentTool = {
  Probe: "probe",
  EnvironmentWrite: "environment_write",
} as const;
export type EnvironmentTool =
  (typeof EnvironmentTool)[keyof typeof EnvironmentTool];

const PATH_LOCATION = "path";

export const TOOL_CATALOG: Readonly<Record<string, ToolEntry>> = {
  [BuiltinTool.Read]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Edit]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Write]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Grep]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Find]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Ls]: { locations: [PATH_LOCATION] },
  [HostTool.EvidenceUpload]: { locations: [PATH_LOCATION] },
  [HostTool.LinkUpdateList]: { locations: [] },
  [EnvironmentTool.Probe]: { locations: [] },
  [EnvironmentTool.EnvironmentWrite]: { locations: [] },
};

export function getToolEntry(toolName: string): ToolEntry | undefined {
  if (!Object.hasOwn(TOOL_CATALOG, toolName)) return undefined;
  return TOOL_CATALOG[toolName];
}

export const AGENT_DECLARATIONS: Readonly<Record<AgentName, AgentDeclaration>> =
  {
    "swe@1": {
      agent_name: "swe@1",
      agent_prompt: SWE_AGENT_PROMPT,
      host_tools: [HostTool.EvidenceUpload, HostTool.LinkUpdateList],
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

const CONFINED_AGENTS: ReadonlySet<string> = new Set<AgentName>(["re@1"]);

export function isConfinedAgent(agentName: string): boolean {
  return CONFINED_AGENTS.has(agentName);
}

export function getAgentDeclaration(
  agentName: string,
): AgentDeclaration | undefined {
  if (!Object.hasOwn(AGENT_DECLARATIONS, agentName)) return undefined;
  return AGENT_DECLARATIONS[agentName as AgentName];
}
