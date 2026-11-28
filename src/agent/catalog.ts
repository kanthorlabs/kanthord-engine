import {
  CODING_PROMPT,
  ENV_AGENT_PROMPT,
  RE_ROLE_PROMPT,
  SWE_ROLE_PROMPT,
} from "./prompt-assets.ts";

export interface ToolEntry {
  locations: readonly string[];
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

export const WorkerTool = {
  EvidenceUpload: "evidence-upload",
  LinkUpdateList: "link_update_list",
} as const;
export type WorkerTool = (typeof WorkerTool)[keyof typeof WorkerTool];

export const EnvironmentTool = {
  Probe: "probe",
  EnvironmentWrite: "environment_write",
} as const;
export type EnvironmentTool =
  (typeof EnvironmentTool)[keyof typeof EnvironmentTool];

export const StartPrecondition = {
  WorkspaceDirectory: "workspace_directory",
  GitWorktree: "git_worktree",
  GitClean: "git_clean",
} as const;
export type StartPrecondition =
  (typeof StartPrecondition)[keyof typeof StartPrecondition];

export interface ProfilePromptFiles {
  coding: string | null;
  role: string;
}

export interface AgentTools {
  builtin: readonly BuiltinTool[];
  host: readonly WorkerTool[];
  environment: readonly EnvironmentTool[];
}

export const PROFILE_NAMES = ["swe@1", "re@1", "env@1"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface Profile {
  name: ProfileName;
  tools: AgentTools;
  confined: boolean;
  preconditions: readonly StartPrecondition[];
  prompt: ProfilePromptFiles;
}

const PATH_LOCATION = "path";

export const TOOL_CATALOG: Readonly<Record<string, ToolEntry>> = {
  [BuiltinTool.Read]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Edit]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Write]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Grep]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Find]: { locations: [PATH_LOCATION] },
  [BuiltinTool.Ls]: { locations: [PATH_LOCATION] },
  [WorkerTool.EvidenceUpload]: { locations: [PATH_LOCATION] },
  [WorkerTool.LinkUpdateList]: { locations: [] },
  [EnvironmentTool.Probe]: { locations: [] },
  [EnvironmentTool.EnvironmentWrite]: { locations: [] },
};

export function getToolEntry(toolName: string): ToolEntry | undefined {
  if (!Object.hasOwn(TOOL_CATALOG, toolName)) return undefined;
  return TOOL_CATALOG[toolName];
}

const SWE_CODING_TOOLS: AgentTools = {
  builtin: [
    BuiltinTool.Read,
    BuiltinTool.Edit,
    BuiltinTool.Write,
    BuiltinTool.Grep,
    BuiltinTool.Find,
    BuiltinTool.Ls,
    BuiltinTool.Bash,
  ],
  host: [WorkerTool.EvidenceUpload, WorkerTool.LinkUpdateList],
  environment: [],
};

const RE_TOOLS: AgentTools = {
  builtin: [
    BuiltinTool.Read,
    BuiltinTool.Grep,
    BuiltinTool.Find,
    BuiltinTool.Ls,
  ],
  host: [],
  environment: [],
};

const ENV_TOOLS: AgentTools = {
  builtin: [
    BuiltinTool.Read,
    BuiltinTool.Grep,
    BuiltinTool.Find,
    BuiltinTool.Ls,
  ],
  host: [],
  environment: [EnvironmentTool.Probe, EnvironmentTool.EnvironmentWrite],
};

const SWE_CODING_PRECONDITIONS: readonly StartPrecondition[] = [
  StartPrecondition.WorkspaceDirectory,
  StartPrecondition.GitWorktree,
  StartPrecondition.GitClean,
];

const WORKSPACE_PRECONDITIONS: readonly StartPrecondition[] = [
  StartPrecondition.WorkspaceDirectory,
];

const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  "swe@1": {
    name: "swe@1",
    tools: SWE_CODING_TOOLS,
    confined: false,
    preconditions: SWE_CODING_PRECONDITIONS,
    prompt: { coding: CODING_PROMPT, role: SWE_ROLE_PROMPT },
  },
  "re@1": {
    name: "re@1",
    tools: RE_TOOLS,
    confined: true,
    preconditions: WORKSPACE_PRECONDITIONS,
    prompt: { coding: CODING_PROMPT, role: RE_ROLE_PROMPT },
  },
  "env@1": {
    name: "env@1",
    tools: ENV_TOOLS,
    confined: true,
    preconditions: WORKSPACE_PRECONDITIONS,
    prompt: { coding: null, role: ENV_AGENT_PROMPT },
  },
};

export function getProfile(name: string): Profile | undefined {
  if (!Object.hasOwn(PROFILES, name)) return undefined;
  return PROFILES[name as ProfileName];
}

export function isConfinedAgent(agentName: string): boolean {
  return getProfile(agentName)?.confined ?? false;
}
