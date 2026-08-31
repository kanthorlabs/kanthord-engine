import {
  workerRegistry,
  type WorkerEntry,
} from "../../domain/worker-registry.ts";

export type WorkerListItem = WorkerEntry;

export type ListWorkersDependencies = Readonly<Record<string, never>>;

export type ListWorkersInput = Readonly<Record<string, never>>;

export function listWorkers(
  _dependencies: ListWorkersDependencies,
  _input: ListWorkersInput,
): readonly WorkerListItem[] {
  return workerRegistry.map((entry) => ({
    worker: entry.worker,
    driver: entry.driver,
    agents: [...entry.agents],
    claims: [...entry.claims],
    deliverables: [...entry.deliverables],
    harness: entry.harness,
    metadata: { composition: entry.metadata.composition },
  }));
}
