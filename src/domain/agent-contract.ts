import type { agentKinds } from "./agent.ts";

export const tools = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export type AgentContract = Readonly<{
  agent: string;
  purpose: string;
  capabilities: { tools: readonly string[] };
}>;

export const agentContracts: Readonly<Record<string, AgentContract>> = {
  "general@1": {
    agent: "general@1",
    purpose: "Does any task end to end.",
    capabilities: { tools },
  },
  "swe@1": {
    agent: "swe@1",
    purpose: "Writes production code. Writes no test.",
    capabilities: { tools },
  },
  "te@1": {
    agent: "te@1",
    purpose: "Writes tests. Writes no production code.",
    capabilities: { tools },
  },
  "re@1": {
    agent: "re@1",
    purpose: "Reviews a diff against acceptance criteria.",
    capabilities: {
      tools: ["read", "bash", "grep", "find", "ls"] as const,
    },
  },
} satisfies Readonly<Record<(typeof agentKinds)[number], AgentContract>>;
