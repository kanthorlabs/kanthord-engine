import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Transaction } from "../kernel/store.ts";
import type { MissionConfig } from "./config.ts";
import {
  MISSION_SERVICE_NAME,
  type HumanActor,
  type MissionBindings,
  type MissionCollaborations,
  type WorkQueue,
} from "./contract.ts";

const MISSION_STOPPED_CODE = "mission.lifecycle.stopped";
const NOT_IMPLEMENTED_MESSAGE = "not implemented";

export interface Dependencies {
  config: MissionConfig;
  health?: HealthRegistry;
  bindings: MissionBindings;
  workQueue: WorkQueue;
}

export class MissionService implements Service, MissionCollaborations {
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    dependencies.health?.register(MISSION_SERVICE_NAME, () =>
      this.healthcheck(),
    );
  }

  declare(registry: OperationRegistry): void {
    void registry;
  }

  createMission(tx: Transaction, projectId: string, actor: HumanActor): void {
    void tx;
    void projectId;
    void actor;
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  }

  liveNodesPinning(tx: Transaction, bindingId: string): string[] {
    void tx;
    void bindingId;
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          MISSION_STOPPED_CODE,
          "mission: a stopped service cannot start again.",
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
      operations:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
