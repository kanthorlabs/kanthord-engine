import type { PoolEntry, PoolHost, PoolInstance } from "./contract.ts";

export interface PoolTarget {
  instance: PoolInstance;
  entries: readonly PoolEntry[];
}

export interface PoolEffects {
  start: PoolTarget[];
  update: PoolTarget[];
  archive: PoolInstance[];
}

function listing(entries: readonly PoolEntry[]): string {
  return JSON.stringify(
    entries.map(({ project_id, resource_identity, client_id, state }) => [
      project_id,
      resource_identity,
      client_id,
      state,
    ]),
  );
}

export class Pool {
  private readonly host: PoolHost;
  private readonly running = new Map<string, PoolTarget>();

  constructor(host: PoolHost) {
    this.host = host;
  }

  instances(): PoolInstance[] {
    return Array.from(this.running.values(), ({ instance }) => instance);
  }

  restart(instance: PoolInstance): void {
    this.host.restart(instance);
  }

  reconcile(targets: readonly PoolTarget[]): PoolEffects {
    const effects: PoolEffects = { start: [], update: [], archive: [] };
    const live = new Set(targets.map(({ instance }) => instance.id));
    for (const [id, target] of this.running)
      if (!live.has(id)) {
        this.running.delete(id);
        effects.archive.push(target.instance);
      }
    for (const target of targets) {
      const current = this.running.get(target.instance.id);
      this.running.set(target.instance.id, target);
      if (!current) effects.start.push(target);
      else if (listing(current.entries) !== listing(target.entries))
        effects.update.push(target);
    }
    return effects;
  }

  execute(effects: PoolEffects): void {
    for (const archived of effects.archive) void this.host.archive(archived);
    for (const target of effects.start)
      this.host.start(target.instance, target.entries);
    for (const target of effects.update)
      this.host.update(target.instance, target.entries);
  }
}
