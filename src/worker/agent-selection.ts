import type { Transaction } from "../kernel/store.ts";
import {
  AgentChoiceKind,
  type AgentChoice,
  type AgentSelection,
} from "../scheduler/contract.ts";
import type { WorkerEntry } from "./contract.ts";
import type { Dependencies, WorkerService } from "./service.ts";

export function entryOf(
  entries: ReadonlyArray<WorkerEntry & { agent: string }>,
  agentName: string,
): WorkerEntry | null {
  const selected = entries.find(({ agent }) => agent === agentName);
  if (!selected) return null;
  const { agent, ...entry } = selected;
  return agent === agentName ? entry : null;
}

export function pinnedEntry(
  selections: readonly AgentSelection[],
  agentName: string,
  entry: WorkerEntry | null,
): WorkerEntry | null {
  const pin = selections.find(({ agent_name }) => agent_name === agentName);
  if (!pin) return entry;
  return {
    agent_provider: pin.agent_provider,
    model_identifier: pin.model_identifier,
    reasoning_effort: pin.reasoning_effort,
    fallback_configurations: [],
  };
}

export function agentChoice(
  dependencies: Pick<Dependencies, "workerBindingRowOf" | "agentConfiguration">,
  worker: Pick<WorkerService, "declarationOf">,
  tx: Transaction,
  workerBindingId: string,
): AgentChoice {
  const row = dependencies.workerBindingRowOf(tx, workerBindingId);
  const agents = row
    ? (worker.declarationOf(row.worker_name)?.agent_names ?? [])
    : [];
  const selections: AgentSelection[] = [];
  for (const agentName of agents) {
    const result = dependencies.agentConfiguration.selectAgent(
      tx,
      agentName,
      entryOf(row?.entries ?? [], agentName),
    );
    if (result.kind === AgentChoiceKind.Cooling)
      return { kind: AgentChoiceKind.Cooling, until_at: result.until_at };
    if (result.kind === AgentChoiceKind.Selected)
      selections.push(result.selection);
  }
  return { kind: AgentChoiceKind.Selected, selections };
}
