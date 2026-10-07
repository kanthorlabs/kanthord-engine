import { HostTool } from "../worker/contract.ts";
import { RE_AGENT_PROMPT, SWE_AGENT_PROMPT } from "./prompt-assets.ts";

export interface AgentDeclaration {
  agentName: string;
  overridableFields: readonly string[];
  agentPrompt: string;
  tools: readonly BuiltinTool[];
  hostTools: readonly HostTool[];
}

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

export const AGENT_DECLARATIONS: Readonly<Record<string, AgentDeclaration>> = {
  "swe@1": {
    agentName: "swe@1",
    agentPrompt: SWE_AGENT_PROMPT,
    hostTools: [HostTool.EvidenceUpload],
    tools: [
      BuiltinTool.Read,
      BuiltinTool.Edit,
      BuiltinTool.Write,
      BuiltinTool.Grep,
      BuiltinTool.Find,
      BuiltinTool.Ls,
      BuiltinTool.Bash,
    ],
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  },
  "re@1": {
    agentName: "re@1",
    agentPrompt: RE_AGENT_PROMPT,
    hostTools: [],
    tools: [
      BuiltinTool.Read,
      BuiltinTool.Grep,
      BuiltinTool.Find,
      BuiltinTool.Ls,
    ],
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  },
};

export function getAgentDeclaration(
  agentName: string,
): AgentDeclaration | undefined {
  if (!Object.hasOwn(AGENT_DECLARATIONS, agentName)) return undefined;
  return AGENT_DECLARATIONS[agentName];
}
