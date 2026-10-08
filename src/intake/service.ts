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
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import type { GitHubPlatform } from "../repository/github.ts";
import type { GitWriter } from "../repository/index.ts";
import type { S3Platform } from "../storage/index.ts";
import { checkAction, type IntakeCustody } from "./action-check.ts";
import { performAction } from "./action-perform.ts";
import { readAction } from "./action-read.ts";
import {
  INTAKE_SERVICE_NAME,
  intakeOperations,
  type IntakeCollaborations,
} from "./contract.ts";
import { createInbound, type InboundProjects } from "./inbound-create.ts";
import { getInbound, listInbound } from "./inbound-read.ts";
import { getOutbound, listOutbound } from "./outbound-read.ts";
import { deleteOutbound, discardOutbound } from "./outbound-write.ts";
import { runOutbound, type OutboundRun } from "./outbound.ts";
import { deleteStoredObject } from "./storage-delete.ts";
import {
  checkObject,
  executionGetObject,
  getObject,
  putObject,
} from "./storage.ts";

const NO_LENGTH = 0;

export interface Dependencies {
  store: Store;
  logger: Logger;
  health: HealthRegistry;
  identity: ServiceIdentity;
  custody: IntakeCustody;
  github: GitHubPlatform;
  gitWriter: GitWriter;
  s3: S3Platform;
  masterKey: string;
  projects: InboundProjects;
}

export class IntakeService implements Service, IntakeCollaborations {
  private readonly dependencies: Dependencies;
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly outboundInFlight = new Set<string>();

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }

  declare(registry: OperationRegistry): void {
    registry.register(
      intakeOperations["outbound.request.list"],
      ({ query }, caller) => caller.commit((tx) => listOutbound(tx, query)),
    );
    registry.register(
      intakeOperations["outbound.request.get"],
      ({ params }, caller) =>
        caller.commit((tx) => getOutbound(tx, params.outbound_request_id)),
    );
    registry.register(
      intakeOperations["outbound.request.discard"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          discardOutbound(
            tx,
            this.outboundInFlight,
            params.outbound_request_id,
          ),
        ),
    );
    registry.register(
      intakeOperations["outbound.request.delete"],
      ({ body }, caller) => caller.commit((tx) => deleteOutbound(tx, body)),
    );
    registry.register(intakeOperations["inbound.create"], ({ body }, caller) =>
      createInbound(this.dependencies, caller, body),
    );
    registry.register(intakeOperations["inbound.list"], ({ query }, caller) =>
      caller.commit((tx) => listInbound(tx, query)),
    );
    registry.register(intakeOperations["inbound.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getInbound(tx, this.dependencies.masterKey, params.inbound_id),
      ),
    );
    registry.register(intakeOperations["action.check"], ({ body }, caller) =>
      checkAction(this.dependencies, caller, body.evidence_id),
    );
    registry.register(intakeOperations["action.perform"], ({ body }, caller) =>
      performAction(
        this.dependencies,
        (request) => this.runOutbound(caller, request),
        caller,
        body,
      ),
    );
    registry.register(
      intakeOperations["action.read"],
      ({ params, query }, caller) =>
        readAction(this.dependencies, caller, params.evidence_id, query),
    );
    registry.register(intakeOperations["storage.put"], ({ body }, caller) =>
      putObject(this.dependencies, caller, body),
    );
    registry.register(intakeOperations["storage.check"], ({ params }, caller) =>
      checkObject(this.dependencies, caller, params.asset_id),
    );
    registry.register(
      intakeOperations["execution.storage.get"],
      ({ params }, caller) =>
        executionGetObject(this.dependencies, caller, params.asset_id),
    );
    registry.register(intakeOperations["storage.get"], ({ params }, caller) =>
      getObject(this.dependencies, caller, params.asset_id),
    );
    registry.register(
      intakeOperations["storage.delete"],
      ({ params }, caller) =>
        deleteStoredObject(
          this.dependencies,
          (request) => this.runOutbound(caller, request),
          caller,
          params.asset_id,
        ),
    );
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

  runOutbound<TBody>(
    caller: CallerContext,
    request: OutboundRun<TBody>,
  ): Promise<TBody> {
    return runOutbound(
      {
        store: this.dependencies.store,
        logger: this.dependencies.logger,
        inFlight: this.outboundInFlight,
      },
      caller,
      request,
    );
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

  inboundsNaming(
    tx: Transaction,
    credentialName: string,
  ): { inbound_id: string }[] {
    assert.ok(tx);
    assert.ok(
      credentialName.length > NO_LENGTH,
      "A credential name is required.",
    );
    const rows = tx.database
      .prepare("SELECT id FROM intake_inbound WHERE credential = ? ORDER BY id")
      .all(credentialName) as { id: string }[];
    return rows.map(({ id }) => ({ inbound_id: id }));
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
