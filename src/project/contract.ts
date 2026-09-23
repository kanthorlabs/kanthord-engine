import type { Context } from "../kernel/context.ts";
export const projectOperations = {};
export interface ProjectBindings {
  resolveWorkerBinding(
    bindingId: string,
    context: Context,
  ): Promise<{ workerBindingId: string; projectId: string } | null>;
}
