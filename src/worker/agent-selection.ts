import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import {
  AgentChoiceKind,
  type AgentChoice,
  type AgentPin,
  type AgentSelection,
} from "../scheduler/contract.ts";
import type { WorkerEntry } from "./contract.ts";
import type { Dependencies, WorkerService } from "./service.ts";

const NO_PINS = 0;

export function entryOf(
  entries: ReadonlyArray<WorkerEntry & { agent: string }>,
  agentName: string,
): WorkerEntry | null {
  const selected = entries.find(({ agent }) => agent === agentName);
  if (!selected) return null;
  const { agent, ...entry } = selected;
  return agent === agentName ? entry : null;
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
  const pins: AgentPin[] = [];
  for (const agentName of agents) {
    const result = dependencies.agentConfiguration.selectAgent(
      tx,
      agentName,
      entryOf(row?.entries ?? [], agentName),
    );
    if (result.kind === AgentChoiceKind.Cooling)
      return {
        kind: AgentChoiceKind.Cooling,
        available_at: result.available_at,
      };
    if (result.kind === AgentChoiceKind.Selected) {
      selections.push(result.selection);
      pins.push({
        agent_name: agentName,
        enablement_id: result.enablement_id,
        position: result.selection.position,
      });
    }
  }
  return { kind: AgentChoiceKind.Selected, selections, pins };
}

export function agentSelectionsAt(
  dependencies: Pick<Dependencies, "workerBindingRowOf" | "agentConfiguration">,
  tx: Transaction,
  workerBindingId: string,
  pins: readonly AgentPin[],
): AgentSelection[] {
  if (pins.length === NO_PINS) return [];
  const row = dependencies.workerBindingRowOf(tx, workerBindingId);
  assert.ok(row, "A pinned worker binding revision must exist.");
  return pins.map((pin) =>
    dependencies.agentConfiguration.selectionAt(
      tx,
      pin.agent_name,
      pin.enablement_id,
      entryOf(row.entries, pin.agent_name),
      pin.position,
    ),
  );
}
