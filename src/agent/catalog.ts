import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
  HostTool,
  LINK_UPDATE_LIMIT_MAX,
  LINK_UPDATE_LIMIT_MIN,
} from "../worker/contract.ts";
import type { AgentName } from "./contract.ts";
import {
  OPS_AGENT_PROMPT,
  PE_AGENT_PROMPT,
  RE_AGENT_PROMPT,
  SWE_AGENT_PROMPT,
} from "./prompt-assets.ts";

export interface AgentDeclaration {
  agent_name: string;
  overridable_fields: readonly string[];
  agent_prompt: string;
  display_name: string;
  tools: AgentTools;
}

export interface AgentTools {
  builtin: readonly BuiltinTool[];
  host: readonly HostTool[];
  operation: readonly string[];
  workbench: readonly WorkbenchTool[];
}

export const WorkbenchTool = { EvidenceRead: "evidence_read" } as const;
export type WorkbenchTool = (typeof WorkbenchTool)[keyof typeof WorkbenchTool];

export const EVIDENCE_UPLOAD_PARAMETERS = Type.Object(
  { path: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const LINK_UPDATE_LIST_PARAMETERS = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(
      Type.Integer({
        minimum: LINK_UPDATE_LIMIT_MIN,
        maximum: LINK_UPDATE_LIMIT_MAX,
      }),
    ),
  },
  { additionalProperties: false },
);

export const HOST_TOOL_PARAMETERS: Readonly<Record<HostTool, TSchema>> = {
  [HostTool.EvidenceUpload]: EVIDENCE_UPLOAD_PARAMETERS,
  [HostTool.LinkUpdateList]: LINK_UPDATE_LIST_PARAMETERS,
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

const NODE_REVIEW_READS = [
  "mission.node.get",
  "mission.attempt.list",
  "mission.outcome.list",
  "mission.assessment.list",
  "mission.evidence.list",
  "mission.evidence.get",
] as const;

const OPS_OPERATIONS = [
  "gateway.healthcheck",
  "project.list",
  "mission.get",
  "mission.node.list",
  "mission.node.get",
  "mission.assessment.list",
  "mission.proposal.list",
  "mission.externalAction.list",
  "mission.evidence.list",
  "scheduler.execution.list",
  "scheduler.queue.list",
  "worker.instance.list",
  "agent.cooldown.list",
  "workbench.session.list",
  "mission.export",
  "mission.import.preview",
  "worker.catalog.list",
  "project.binding.list",
  "project.agentConfiguration.list",
  "llm.credential.list",
  "mission.node.pause",
  "mission.node.resume",
  "mission.node.check",
  "mission.node.priority.set",
  "mission.dependency.add",
  "mission.dependency.remove",
  "project.pause",
  "project.resume",
  "agent.cooldown.clear",
  "mission.node.unblock",
  "mission.node.block",
  "mission.node.create",
  "mission.node.update",
  "mission.proposal.decide",
  "mission.criterion.set",
  "mission.import.apply",
] as const;

export const AGENT_DECLARATIONS: Readonly<Record<AgentName, AgentDeclaration>> =
  {
    "swe@1": {
      agent_name: "swe@1",
      display_name: "SWE",
      agent_prompt: SWE_AGENT_PROMPT,
      tools: {
        builtin: [
          BuiltinTool.Read,
          BuiltinTool.Edit,
          BuiltinTool.Write,
          BuiltinTool.Grep,
          BuiltinTool.Find,
          BuiltinTool.Ls,
          BuiltinTool.Bash,
        ],
        host: [HostTool.EvidenceUpload, HostTool.LinkUpdateList],
        operation: NODE_REVIEW_READS,
        workbench: [WorkbenchTool.EvidenceRead],
      },
      overridable_fields: [
        "agent_provider",
        "model_identifier",
        "reasoning_effort",
        "fallback_configurations",
      ],
    },
    "re@1": {
      agent_name: "re@1",
      display_name: "RE",
      agent_prompt: RE_AGENT_PROMPT,
      tools: {
        builtin: [
          BuiltinTool.Read,
          BuiltinTool.Grep,
          BuiltinTool.Find,
          BuiltinTool.Ls,
        ],
        host: [],
        operation: NODE_REVIEW_READS,
        workbench: [WorkbenchTool.EvidenceRead],
      },
      overridable_fields: [
        "agent_provider",
        "model_identifier",
        "reasoning_effort",
        "fallback_configurations",
      ],
    },
    "pe@1": {
      agent_name: "pe@1",
      display_name: "PE",
      agent_prompt: PE_AGENT_PROMPT,
      tools: {
        builtin: [
          BuiltinTool.Read,
          BuiltinTool.Grep,
          BuiltinTool.Find,
          BuiltinTool.Ls,
        ],
        host: [],
        operation: [],
        workbench: [],
      },
      overridable_fields: [],
    },
    "ops@1": {
      agent_name: "ops@1",
      display_name: "Yumi",
      agent_prompt: OPS_AGENT_PROMPT,
      tools: {
        builtin: [],
        host: [],
        operation: OPS_OPERATIONS,
        workbench: [],
      },
      overridable_fields: [
        "agent_provider",
        "model_identifier",
        "reasoning_effort",
        "fallback_configurations",
      ],
    },
  };

const NO_OPERATIONS = 0;

export function workbenchAgentNames(): string[] {
  return Object.values(AGENT_DECLARATIONS)
    .filter((declaration) => declaration.tools.operation.length > NO_OPERATIONS)
    .map((declaration) => declaration.agent_name);
}

export function getAgentDeclaration(
  agentName: string,
): AgentDeclaration | undefined {
  if (!Object.hasOwn(AGENT_DECLARATIONS, agentName)) return undefined;
  return AGENT_DECLARATIONS[agentName as AgentName];
}
