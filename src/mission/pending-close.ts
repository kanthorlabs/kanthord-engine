import type { Transaction } from "../kernel/store.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import type { HumanActor } from "../kernel/actor.ts";
import type { ServerTrace } from "../tracking/contract.ts";
import type { Act } from "./act-telemetry.ts";
import { NodeState } from "./contract.ts";
import type { ControlResult, HumanAct, Override } from "./contract.ts";
import type { EvidenceDelete } from "./evidence-delete.ts";
import { requireNode } from "./node-read.ts";

interface PendingCloseBase {
  execution_id: string;
  node_id: string;
  attempt: number;
  actor: HumanActor;
  trace: ServerTrace | null;
}

export type PendingClose = PendingCloseBase &
  (
    | { act: typeof Act.Override; body: Override; result: ControlResult }
    | { act: typeof Act.Discard; body: HumanAct; result: ControlResult }
    | {
        act: typeof Act.DeleteEvidence;
        body: EvidenceDelete;
        evidence_id: string;
        identity: CallerIdentity;
      }
  );

export function holdsStepOne(
  tx: Transaction,
  pending: Pick<PendingClose, "node_id" | "attempt">,
): boolean {
  const node = requireNode(tx, pending.node_id);
  return node.state === NodeState.Paused && node.attempt === pending.attempt;
}

export class PendingCloses {
  private readonly byExecution = new Map<string, PendingClose>();

  add(pending: PendingClose): void {
    this.byExecution.set(pending.execution_id, pending);
  }

  take(executionId: string): PendingClose | null {
    const pending = this.byExecution.get(executionId) ?? null;
    this.byExecution.delete(executionId);
    return pending;
  }

  ofNode(nodeId: string): PendingClose | null {
    for (const pending of this.byExecution.values())
      if (pending.node_id === nodeId) return pending;
    return null;
  }
}
