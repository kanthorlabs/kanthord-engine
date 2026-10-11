import { HostTool } from "../worker/contract.ts";
import {
  ARCHITECT_AGENT_PROMPT,
  COUNCIL_AGENT_PROMPT,
  DESIGNER_AGENT_PROMPT,
  PO_AGENT_PROMPT,
  RE_AGENT_PROMPT,
  SECURITY_AGENT_PROMPT,
  SWE_AGENT_PROMPT,
  USER_AGENT_PROMPT,
} from "./prompt-assets.ts";

export interface AgentDeclaration {
  agent_name: string;
  overridable_fields: readonly string[];
  agent_prompt: string;
  tools: readonly BuiltinTool[];
  host_tools: readonly HostTool[];
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

function councilDeclaration(
  agentName: string,
  agentPrompt: string,
): AgentDeclaration {
  return {
    agent_name: agentName,
    agent_prompt: agentPrompt,
    host_tools: [],
    tools: [],
    overridable_fields: [
      "agent_provider",
      "model_identifier",
      "reasoning_effort",
    ],
  };
}

export const AGENT_DECLARATIONS: Readonly<Record<string, AgentDeclaration>> = {
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
    ],
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
    ],
  },
  "council@1": councilDeclaration("council@1", COUNCIL_AGENT_PROMPT),
  "po@1": councilDeclaration("po@1", PO_AGENT_PROMPT),
  "designer@1": councilDeclaration("designer@1", DESIGNER_AGENT_PROMPT),
  "user@1": councilDeclaration("user@1", USER_AGENT_PROMPT),
  "architect@1": councilDeclaration("architect@1", ARCHITECT_AGENT_PROMPT),
  "security@1": councilDeclaration("security@1", SECURITY_AGENT_PROMPT),
};

export function getAgentDeclaration(
  agentName: string,
): AgentDeclaration | undefined {
  if (!Object.hasOwn(AGENT_DECLARATIONS, agentName)) return undefined;
  return AGENT_DECLARATIONS[agentName];
}
