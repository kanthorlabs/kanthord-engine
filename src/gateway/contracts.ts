import type { Transaction } from "../store.ts";
import type { Context } from "../context.ts";

export interface VerifiedClient {
  clientId: string;
  name: string;
  workerBindingId: string;
  projectId: string;
}
export interface Registration extends VerifiedClient {
  runtimeIdentity: string;
}

export interface ProjectBindings {
  resolveWorkerBinding(
    bindingId: string,
    context: Context,
  ): Promise<{ workerBindingId: string; projectId: string } | null>;
}

export interface WorkerRegistrations {
  register(transaction: Transaction, client: VerifiedClient): Registration;
  findByClient(clientId: string): Registration | undefined;
  deregister(runtimeIdentity: string): void;
}

export interface MachineDependencies {
  project: ProjectBindings;
  worker: WorkerRegistrations;
}
