import type { MessagePort } from "node:worker_threads";
import { Diagnostic } from "../../kernel/errors.ts";
import { BindingEntryState } from "../../worker/contract.ts";
import { portTransport } from "./transport.ts";
import { entryPorts, type ThreadEntry } from "./thread-data.ts";
import type { UnitBinding, WorkerUnit } from "./unit.ts";

interface Hosted {
  binding: UnitBinding;
  port: MessagePort;
}

export class SlotBindings {
  private readonly hosted = new Map<string, Hosted>();
  private readonly received = new Set<MessagePort>();
  private readonly report: (line: string) => void;
  private unit?: WorkerUnit;
  private queue: Promise<void> = Promise.resolve();

  constructor(report: (line: string) => void) {
    this.report = report;
  }

  initial(entries: readonly ThreadEntry[]): UnitBinding[] {
    return entries.flatMap((entry) =>
      entry.port === null ? [] : [this.host(entry, entry.port)],
    );
  }

  bind(unit: WorkerUnit): void {
    this.unit = unit;
  }

  apply(entries: readonly ThreadEntry[]): Promise<void> {
    for (const port of entryPorts(entries)) this.received.add(port);
    this.queue = this.queue.then(() => this.reconcile(entries));
    return this.queue;
  }

  close(): void {
    for (const port of this.received) port.close();
  }

  private host(entry: ThreadEntry, port: MessagePort): UnitBinding {
    const binding = {
      transport: portTransport(port),
      client_secret: entry.client_secret,
    };
    this.hosted.set(entry.client_id, { binding, port });
    return binding;
  }

  private async reconcile(entries: readonly ThreadEntry[]): Promise<void> {
    const listed = new Map(entries.map((entry) => [entry.client_id, entry]));
    const removals: Promise<void>[] = [];
    for (const [clientId, hosted] of this.hosted) {
      const entry = listed.get(clientId);
      if (!entry || entry.state === BindingEntryState.Draining)
        removals.push(this.remove(clientId, hosted));
    }
    const additions: Promise<void>[] = [];
    for (const entry of entries) {
      if (
        this.hosted.has(entry.client_id) ||
        entry.state === BindingEntryState.Draining ||
        entry.port === null
      )
        continue;
      additions.push(this.add(this.host(entry, entry.port)));
    }
    await Promise.all([...removals, ...additions]);
  }

  private async add(binding: UnitBinding): Promise<void> {
    this.failed(await this.unit!.add(binding));
  }

  private async remove(clientId: string, hosted: Hosted): Promise<void> {
    this.hosted.delete(clientId);
    this.failed(await this.unit!.remove(hosted.binding));
    hosted.port.close();
  }

  private failed(error: Error | null): void {
    if (error)
      this.report(
        `slot: a binding failed with ${error instanceof Diagnostic ? error.code : "an error"}.\n`,
      );
  }
}
