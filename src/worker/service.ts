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
import assert from "node:assert/strict";
import { isMachineIdentity } from "../kernel/caller.ts";
import { AccessPolicy } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  workerOperations,
  WORKER_SERVICE_NAME,
  type WorkerRegistrations,
} from "./contract.ts";
import { InMemoryRegistrations } from "./registrations.ts";
export interface Dependencies {
  config: Record<string, never>;
  health?: HealthRegistry;
  registrations?: WorkerRegistrations;
}
export class WorkerService implements Service {
  readonly registrations: WorkerRegistrations;
  constructor(dependencies: Dependencies) {
    this.registrations =
      dependencies.registrations ?? new InMemoryRegistrations();
    dependencies.health?.register("worker", () => this.healthcheck());
  }
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          "worker.lifecycle.stopped",
          "worker: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= Promise.resolve(null);
    this.started = true;
    return this.startTask;
  }
  quiesce(): Promise<Error | null> {
    return this.quiesceTask;
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
      registrations:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }

  declare(registry: OperationRegistry): void {
    const worker = this.registrations;
    assert.equal(workerOperations.register.service, WORKER_SERVICE_NAME);
    assert.equal(workerOperations.register.access, AccessPolicy.Client);
    registry.register(
      {
        ...workerOperations.register,
        replayGuard: (recorded, identity) => {
          if (!isMachineIdentity(identity)) return false;
          const result = workerOperations.register.output.safeParse(recorded);
          return (
            result.success &&
            worker.findByClient(identity.clientId)?.runtimeIdentity ===
              result.data.runtimeIdentity
          );
        },
      },
      (_input, caller) => {
        const identity = caller.identity;
        if (!isMachineIdentity(identity))
          throw new OperationError(
            HttpStatus.Unauthorized,
            "gateway.authentication.unauthorized",
            "Authentication required.",
          );
        const previous = worker.findByClient(
          identity.clientId,
        )?.runtimeIdentity;
        let runtimeIdentity: string | undefined;
        try {
          return caller.commit((transaction) => {
            if (previous) return { runtimeIdentity: previous };
            const registration = worker.register(transaction, identity);
            assert.equal(registration.clientId, identity.clientId);
            assert.equal(registration.name, identity.name);
            assert.equal(registration.projectId, identity.projectId);
            assert.equal(
              registration.workerBindingId,
              identity.workerBindingId,
            );
            runtimeIdentity = registration.runtimeIdentity;
            assert.ok(
              runtimeIdentity,
              "Registration must return a runtime identity.",
            );
            return { runtimeIdentity };
          });
        } catch (error) {
          const accepted =
            runtimeIdentity ??
            worker.findByClient(identity.clientId)?.runtimeIdentity;
          if (accepted !== undefined && accepted !== previous)
            worker.deregister(accepted);
          throw error;
        }
      },
    );
  }
}
