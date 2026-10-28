import assert from "node:assert/strict";
import {
  POOL_SLOT_COUNT,
  type PoolHost,
  type PoolPlacement,
  type PoolSlot,
} from "./contract.ts";

const FIRST_SLOT = 0;
const NO_SLOTS = 0;
const KEY_SEPARATOR = "\u0000";

export interface SlotLoad {
  slot: number;
  draining: boolean;
  busy: boolean;
}

export interface PoolPlan {
  start: number[];
  resume: number[];
  drain: number[];
}

export interface PoolTarget {
  project_id: string;
  resource_identity: string;
  generation: number;
  placement: PoolPlacement;
  count: number;
}

export interface PoolProbes {
  busy(clientId: string): boolean;
  live(clientId: string): boolean;
}

export interface PoolEffects {
  start: PoolSlot[];
  drain: PoolSlot[];
}

interface Group {
  project_id: string;
  resource_identity: string;
  generation: number;
  placement: PoolPlacement;
  slots: Map<number, PoolSlot>;
  departed: Map<number, PoolSlot>;
  removed: boolean;
}

function descendingBySlot(left: SlotLoad, right: SlotLoad): number {
  return right.slot - left.slot;
}

export function planPool(slots: SlotLoad[], target: number): PoolPlan {
  assert.ok(Number.isSafeInteger(target) && target >= NO_SLOTS);
  assert.ok(target <= POOL_SLOT_COUNT);
  const plan: PoolPlan = { start: [], resume: [], drain: [] };
  const active = slots.filter(({ draining }) => !draining);
  if (active.length < target) {
    const need = target - active.length;
    plan.resume = slots
      .filter(({ draining }) => draining)
      .map(({ slot }) => slot)
      .sort((left, right) => left - right)
      .slice(FIRST_SLOT, need);
    const taken = new Set(slots.map(({ slot }) => slot));
    for (
      let slot = FIRST_SLOT;
      slot < POOL_SLOT_COUNT && plan.start.length < need - plan.resume.length;
      slot++
    )
      if (!taken.has(slot)) plan.start.push(slot);
    return plan;
  }
  const idle = active.filter(({ busy }) => !busy).sort(descendingBySlot);
  const busy = active.filter(({ busy: held }) => held).sort(descendingBySlot);
  plan.drain = [...idle, ...busy]
    .slice(FIRST_SLOT, active.length - target)
    .map(({ slot }) => slot);
  return plan;
}

function keyOf(
  projectId: string,
  resourceIdentity: string,
  generation: number,
): string {
  return [projectId, resourceIdentity, generation].join(KEY_SEPARATOR);
}

export class Pool {
  private readonly host: PoolHost;
  private readonly groups = new Map<string, Group>();

  constructor(host: PoolHost) {
    this.host = host;
    host.onEnded((clientId) => this.ended(clientId));
  }

  slotsOf(
    projectId: string,
    resourceIdentity: string,
    generation: number,
  ): PoolSlot[] {
    const group = this.groups.get(
      keyOf(projectId, resourceIdentity, generation),
    );
    return Array.from(group?.slots.values() ?? []).filter(
      ({ draining }) => !draining,
    );
  }

  restart(slot: PoolSlot): void {
    slot.draining = true;
    this.host.restart(slot);
  }

  draining(clientId: string): boolean {
    return this.slotOf(clientId)?.draining ?? false;
  }

  slotOf(clientId: string): PoolSlot | undefined {
    for (const group of this.groups.values())
      for (const slot of group.slots.values())
        if (slot.client_id === clientId) return slot;
    return undefined;
  }

  reconcile(
    scope: string | null,
    targets: PoolTarget[],
    probes: PoolProbes,
    restore: boolean,
  ): PoolEffects {
    const effects: PoolEffects = { start: [], drain: [] };
    const wanted = new Map(
      targets.map((target) => [
        keyOf(target.project_id, target.resource_identity, target.generation),
        target,
      ]),
    );
    for (const [key, target] of wanted)
      if (!this.groups.has(key))
        this.groups.set(key, {
          project_id: target.project_id,
          resource_identity: target.resource_identity,
          generation: target.generation,
          placement: target.placement,
          slots: new Map(),
          departed: new Map(),
          removed: false,
        });
    for (const [key, group] of this.groups) {
      if (scope !== null && group.project_id !== scope) continue;
      group.removed = !wanted.has(key);
      const count = wanted.get(key)?.count ?? NO_SLOTS;
      this.apply(group, count, probes, effects);
      if (restore) this.restore(group, count, probes, effects);
      if (!group.slots.size && !wanted.has(key)) this.groups.delete(key);
    }
    return effects;
  }

  execute(effects: PoolEffects): void {
    for (const slot of effects.start) this.host.start(slot);
    for (const slot of effects.drain) this.host.drain(slot);
  }

  private restore(
    group: Group,
    count: number,
    probes: PoolProbes,
    effects: PoolEffects,
  ): void {
    for (let number = count; number < POOL_SLOT_COUNT; number++) {
      const clientId = this.host.clientIdentity(
        group.project_id,
        group.resource_identity,
        group.generation,
        number,
      );
      if (group.slots.has(number) || !probes.live(clientId)) continue;
      const slot = this.slot(group, number, clientId, true);
      group.slots.set(number, slot);
      effects.start.push(slot);
    }
  }

  private apply(
    group: Group,
    count: number,
    probes: PoolProbes,
    effects: PoolEffects,
  ): void {
    const plan = planPool(
      Array.from(group.slots.values(), (slot) => ({
        slot: slot.slot,
        draining: slot.draining,
        busy: probes.busy(slot.client_id),
      })),
      count,
    );
    for (const number of plan.resume) {
      const slot = group.slots.get(number)!;
      slot.draining = false;
      effects.start.push(slot);
    }
    for (const number of plan.start) {
      const slot = this.slot(
        group,
        number,
        this.host.clientIdentity(
          group.project_id,
          group.resource_identity,
          group.generation,
          number,
        ),
        false,
      );
      group.slots.set(number, slot);
      effects.start.push(slot);
    }
    for (const number of plan.drain) {
      const slot = group.slots.get(number)!;
      slot.draining = true;
      effects.drain.push(slot);
    }
  }

  private slot(
    group: Group,
    number: number,
    clientId: string,
    draining: boolean,
  ): PoolSlot {
    return {
      project_id: group.project_id,
      resource_identity: group.resource_identity,
      generation: group.generation,
      placement: group.placement,
      slot: number,
      client_id: clientId,
      draining,
    };
  }

  private ended(clientId: string): void {
    for (const [key, group] of this.groups)
      for (const [number, slot] of group.slots)
        if (slot.client_id === clientId) {
          group.slots.delete(number);
          group.departed.set(number, slot);
          if (group.slots.size) return;
          this.groups.delete(key);
          if (group.removed)
            for (const gone of group.departed.values())
              void this.host.remove(gone);
          return;
        }
  }
}
