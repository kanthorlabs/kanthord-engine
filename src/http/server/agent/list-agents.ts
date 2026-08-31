import type { Handler } from "../app.ts";
import type {
  AgentListItem,
  ListAgentsInput,
} from "../../../queries/agent/list-agents.ts";

export type ListAgentHandlerDependencies = Readonly<{
  listAgents: (input: ListAgentsInput) => readonly AgentListItem[];
}>;

export function listAgentHandler(
  dependencies: ListAgentHandlerDependencies,
): Handler {
  return () => ({
    kind: "json",
    status: 200,
    body: { agents: dependencies.listAgents({}) },
  });
}
