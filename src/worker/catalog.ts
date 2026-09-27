export const WorkerHost = {
  Kanthord: "kanthord",
  ExternalHarness: "external-harness",
} as const;
export type WorkerHost = (typeof WorkerHost)[keyof typeof WorkerHost];

export const WorkerMethod = {
  Steps: "steps",
  Evaluation: "evaluation",
} as const;
export type WorkerMethod = (typeof WorkerMethod)[keyof typeof WorkerMethod];

export const REQUIRED_NODE_FORMAT: readonly string[] = [
  "name",
  "requirement",
  "criterion",
  "verifications",
  "bindings",
];

export interface AgentDeclaration {
  agentName: string;
  overridableFields: readonly string[];
}

export interface WorkerDeclaration {
  name: string;
  host: WorkerHost;
  method?: WorkerMethod;
  agentName?: string;
  harness?: string;
  resourceBudget?: { turns: number; wallTimeMs: number };
  declaredNodeStates: readonly string[];
  requiredNodeFormat: readonly string[];
}

const NATIVE_RESOURCE_BUDGET = { turns: 200, wallTimeMs: 7200000 };

export const AGENT_DECLARATIONS: Readonly<Record<string, AgentDeclaration>> = {
  "swe@1": {
    agentName: "swe@1",
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  },
  "re@1": {
    agentName: "re@1",
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  },
};

export const WORKER_CATALOG: Readonly<Record<string, WorkerDeclaration>> = {
  "general@1": {
    name: "general@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Steps,
    agentName: "swe@1",
    resourceBudget: NATIVE_RESOURCE_BUDGET,
    declaredNodeStates: ["Available"],
    requiredNodeFormat: REQUIRED_NODE_FORMAT,
  },
  "reviewer@1": {
    name: "reviewer@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Evaluation,
    agentName: "re@1",
    resourceBudget: NATIVE_RESOURCE_BUDGET,
    declaredNodeStates: ["Waiting", "External.Requested"],
    requiredNodeFormat: REQUIRED_NODE_FORMAT,
  },
  "claude@1": {
    name: "claude@1",
    host: WorkerHost.ExternalHarness,
    harness: "claude-code",
    declaredNodeStates: ["Available", "Waiting", "External.Requested"],
    requiredNodeFormat: REQUIRED_NODE_FORMAT,
  },
  "opencode@1": {
    name: "opencode@1",
    host: WorkerHost.ExternalHarness,
    harness: "opencode",
    declaredNodeStates: ["Available", "Waiting", "External.Requested"],
    requiredNodeFormat: REQUIRED_NODE_FORMAT,
  },
};

export function getAgentDeclaration(
  agentName: string,
): AgentDeclaration | undefined {
  if (!Object.hasOwn(AGENT_DECLARATIONS, agentName)) return undefined;
  return AGENT_DECLARATIONS[agentName];
}

export function getWorkerDeclaration(
  workerName: string,
): WorkerDeclaration | undefined {
  if (!Object.hasOwn(WORKER_CATALOG, workerName)) return undefined;
  return WORKER_CATALOG[workerName];
}

export function agentsOfWorker(workerName: string): string[] {
  const declaration = getWorkerDeclaration(workerName);
  if (declaration?.host !== WorkerHost.Kanthord || !declaration.agentName)
    return [];
  return [declaration.agentName];
}
