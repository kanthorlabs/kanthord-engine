import {
  agentContracts,
  type AgentContract,
} from "../../domain/agent-contract.ts";
import { agentKinds } from "../../domain/agent.ts";

export type AgentListItem = AgentContract;

export type ListAgentsDependencies = Readonly<Record<string, never>>;

export type ListAgentsInput = Readonly<Record<string, never>>;

export function listAgents(
  _dependencies: ListAgentsDependencies,
  _input: ListAgentsInput,
): readonly AgentListItem[] {
  return agentKinds.map((agent) => {
    const contract = agentContracts[agent];
    if (contract === undefined) {
      throw new Error(`agent contract missing for ${agent}`);
    }
    return contract;
  });
}
