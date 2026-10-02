import assert from "node:assert/strict";
import {
  ActionResolution,
  ActionResultKind,
  Uncertainty,
  type ActionContext,
  type ActionRef,
  type ActionResultItem,
} from "./contract.ts";

export class ExecutionMutex {
  private readonly chains = new Map<string, Promise<void>>();

  async run<T>(executionId: string, work: () => Promise<T>): Promise<T> {
    assert.ok(executionId);
    assert.ok(work instanceof Function);
    const previous = this.chains.get(executionId);
    const settled = Promise.withResolvers<void>();
    this.chains.set(executionId, settled.promise);
    try {
      if (previous) await previous;
      return await work();
    } finally {
      settled.resolve();
      if (this.chains.get(executionId) === settled.promise)
        this.chains.delete(executionId);
    }
  }
}

const ReservationState = {
  InFlight: "in_flight",
  Uncertain: "uncertain",
} as const;
type UncertainItem = Extract<
  ActionResultItem,
  { kind: typeof ActionResultKind.Uncertain }
>;
type Entry =
  | { state: typeof ReservationState.InFlight; owner: symbol }
  | { state: typeof ReservationState.Uncertain; item: UncertainItem };
export type ReservationKey = {
  nodeId: string;
  attempt: number;
  action: ActionRef;
};
const FIRST_ATTEMPT = 1;

function keyOf(key: ReservationKey): string {
  assert.ok(key.nodeId && key.action.key && !key.action.key.includes("|"));
  assert.ok(Number.isSafeInteger(key.attempt) && key.attempt >= FIRST_ATTEMPT);
  return `${key.nodeId}|${key.attempt}|${key.action.key}`;
}

export class DispatchReservations {
  private readonly entries = new Map<string, Entry>();

  acquire(key: ReservationKey): { owner: symbol } | { held: UncertainItem } {
    const id = keyOf(key);
    const current = this.entries.get(id);
    if (current?.state === ReservationState.Uncertain)
      return { held: current.item };
    if (current)
      return {
        held: {
          kind: ActionResultKind.Uncertain,
          action: key.action,
          uncertainty: Uncertainty.Effect,
        },
      };
    const owner = Symbol(id);
    this.entries.set(id, { state: ReservationState.InFlight, owner });
    return { owner };
  }

  settle(key: ReservationKey, owner: symbol, item: UncertainItem | null): void {
    const id = keyOf(key);
    const current = this.entries.get(id);
    if (current?.state !== ReservationState.InFlight || current.owner !== owner)
      return;
    if (item === null) {
      this.entries.delete(id);
      return;
    }
    assert.equal(item.kind, ActionResultKind.Uncertain);
    assert.deepEqual(item.action, key.action);
    this.entries.set(id, { state: ReservationState.Uncertain, item });
  }

  prune(
    nodeId: string,
    attempt: number,
    actions: ActionContext["actions"],
  ): void {
    assert.ok(nodeId);
    assert.ok(Number.isSafeInteger(attempt) && attempt >= FIRST_ATTEMPT);
    for (const entry of actions) {
      if (entry.resolution === ActionResolution.Unrequested) continue;
      this.entries.delete(keyOf({ nodeId, attempt, action: entry.action }));
    }
  }
}
