import assert from "node:assert/strict";
import type { Logger } from "pino";
import type { ServiceIdentity } from "../kernel/caller.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import type { HealthRegistry, ResourceEntry } from "../kernel/health.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { INTAKE_SERVICE_NAME } from "./contract.ts";

export interface Dependencies {
  store: Store;
  logger: Logger;
  health: HealthRegistry;
  identity: ServiceIdentity;
}

export class IntakeService implements Service {
  private readonly dependencies: Dependencies;
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }

  declare(registry: OperationRegistry): void {
    assert.ok(registry);
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          "intake.lifecycle.stopped",
          "intake: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= this.open();
    return this.startTask;
  }

  private async open(): Promise<Error | null> {
    assert.equal(this.dependencies.identity.service, INTAKE_SERVICE_NAME);
    this.dependencies.health.register(INTAKE_SERVICE_NAME, () =>
      this.healthcheck(),
    );
    this.started = true;
    return null;
  }

  quiesce(): Promise<Error | null> {
    return this.quiesceTask;
  }

  async drain(): Promise<void> {}

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

  resourceInventory(tx: Transaction): ResourceEntry[] {
    assert.ok(tx);
    return [];
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      events:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
