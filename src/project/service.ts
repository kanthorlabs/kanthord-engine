import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import { throwIfCancelled } from "../kernel/context.ts";
import type { ProjectBindings } from "./contract.ts";
export interface Dependencies {
  config: Record<string, never>;
  health?: HealthRegistry;
  bindings?: ProjectBindings;
}
export class ProjectService implements Service, ProjectBindings {
  private readonly bindings?: ProjectBindings;
  constructor(dependencies: Dependencies) {
    this.bindings = dependencies.bindings;
    dependencies.health?.register("project", () => this.healthcheck());
  }
  declare(registry: OperationRegistry): void {
    void registry;
  }
  async resolveWorkerBinding(bindingId: string, context: Context) {
    throwIfCancelled(context);
    return this.bindings
      ? this.bindings.resolveWorkerBinding(bindingId, context)
      : null;
  }
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private started = false;
  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          "project.lifecycle.stopped",
          "project: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= Promise.resolve(null);
    this.started = true;
    return this.startTask;
  }
  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.started = false;
    this.stopTask ??= Promise.resolve(null);
    return this.stopTask;
  }
  async run(context: Context = background): Promise<Error | null> {
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) return error;
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
    }
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      bindings:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
