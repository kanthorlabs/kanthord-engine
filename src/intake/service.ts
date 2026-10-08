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
  lifecycle,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { ValueType } from "../kernel/values.ts";
import type { GitHubPlatform } from "../repository/github.ts";
import type { GitWriter } from "../repository/index.ts";
import type { S3Platform } from "../storage/index.ts";
import { checkAction, type IntakeCustody } from "./action-check.ts";
import { performAction } from "./action-perform.ts";
import { readAction } from "./action-read.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  intakeOperations,
  PENDING_EVENT_LIMIT,
  POLL_INTERVAL_MS,
  type IntakeCollaborations,
  type IntakeConsumers,
} from "./contract.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createInbound, type InboundProjects } from "./inbound-create.ts";
import { removeInbound } from "./inbound-delete.ts";
import { getEvent, listEvents } from "./event-read.ts";
import { deleteEvents, discardEvent, retryEvent } from "./event-write.ts";
import { getInbound, listInbound } from "./inbound-read.ts";
import { getOutbound, listOutbound } from "./outbound-read.ts";
import { receiveEvent } from "./receipt.ts";
import { deleteOutbound, discardOutbound } from "./outbound-write.ts";
import { runOutbound, type OutboundRun } from "./outbound.ts";
import { pollInboundIds } from "./inbound-store.ts";
import { PollLoops } from "./poll.ts";
import { deleteStoredObject } from "./storage-delete.ts";
import {
  checkObject,
  executionGetObject,
  getObject,
  putObject,
} from "./storage.ts";

const NO_LENGTH = 0;

function assertConsumers(consumers: IntakeConsumers): void {
  const expected = Object.values(Consumer);
  assert.deepEqual(Object.keys(consumers).sort(), [...expected].sort());
  for (const consumer of expected)
    assert.equal(typeof consumers[consumer], ValueType.Function);
}

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
  consumers: IntakeConsumers;
  pendingEventLimit?: number;
  pollIntervalMs?: number;
}

export class IntakeService implements Service, IntakeCollaborations {
  private readonly dependencies: Dependencies;
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly outboundInFlight = new Set<string>();
  readonly pollLoops: PollLoops;
  readonly dispatcher: Dispatcher;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.dispatcher = new Dispatcher({
      store: dependencies.store,
      logger: dependencies.logger,
      identity: dependencies.identity,
      consumers: dependencies.consumers,
      context: this.shutdown,
    });
    this.pollLoops = new PollLoops({
      store: dependencies.store,
      logger: dependencies.logger,
      identity: dependencies.identity,
      custody: dependencies.custody,
      github: dependencies.github,
      context: this.shutdown,
      pendingEventLimit: dependencies.pendingEventLimit ?? PENDING_EVENT_LIMIT,
      pollIntervalMs: dependencies.pollIntervalMs ?? POLL_INTERVAL_MS,
      wake: () => this.wake(),
    });
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
      createInbound(
        { ...this.dependencies, pollLoops: this.pollLoops },
        caller,
        body,
      ),
    );
    registry.register(intakeOperations["inbound.list"], ({ query }, caller) =>
      caller.commit((tx) => listInbound(tx, query)),
    );
    registry.register(intakeOperations["inbound.get"], ({ params }, caller) =>
      caller.commit((tx) =>
        getInbound(tx, this.dependencies.masterKey, params.inbound_id),
      ),
    );
    registry.register(
      intakeOperations["inbound.delete"],
      ({ params }, caller) => {
        const answer = caller.commit((tx) =>
          removeInbound(tx, params.inbound_id),
        );
        this.inboundRemoved(params.inbound_id);
        return answer;
      },
    );
    registry.register(
      intakeOperations["inbound.event.list"],
      ({ query }, caller) => caller.commit((tx) => listEvents(tx, query)),
    );
    registry.register(
      intakeOperations["inbound.event.get"],
      ({ params }, caller) =>
        caller.commit((tx) => getEvent(tx, params.inbound_event_id)),
    );
    registry.register(
      intakeOperations["inbound.event.retry"],
      ({ params }, caller) => {
        const answer = caller.commit((tx) =>
          retryEvent(tx, params.inbound_event_id),
        );
        this.wake();
        return answer;
      },
    );
    registry.register(
      intakeOperations["inbound.event.discard"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          discardEvent(
            tx,
            (id) => this.dispatcher.inFlight(id),
            params.inbound_event_id,
          ),
        ),
    );
    registry.register(
      intakeOperations["inbound.event.delete"],
      ({ body }, caller) => caller.commit((tx) => deleteEvents(tx, body)),
    );
    registry.register(
      intakeOperations["inbound.event.receive"],
      ({ params }, caller) =>
        receiveEvent(
          {
            store: this.dependencies.store,
            masterKey: this.dependencies.masterKey,
            pendingEventLimit:
              this.dependencies.pendingEventLimit ?? PENDING_EVENT_LIMIT,
            wake: () => this.wake(),
          },
          caller,
          params,
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
    assertConsumers(this.dependencies.consumers);
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
    this.pollLoops.quiesce();
    this.dispatcher.quiesce();
    return this.quiesceTask;
  }

  async drain(): Promise<void> {
    await Promise.all([this.pollLoops.drain(), this.dispatcher.join()]);
  }

  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.started = false;
    this.stopTask ??= lifecycle(async () => {
      this.dispatcher.quiesce();
      await Promise.all([this.pollLoops.stopAll(), this.dispatcher.join()]);
    });
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
      this.startPollLoops();
      this.wake();
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
    }
  }

  private startPollLoops(): void {
    if (this.shutdown.err()) return;
    const ids = this.dependencies.store.transaction((tx) => pollInboundIds(tx));
    for (const id of ids) this.pollLoops.start(id);
  }

  inboundRemoved(inboundId: string): void {
    assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
    this.pollLoops.stop(inboundId);
  }

  wake(): void {
    if (!this.started) return;
    this.dispatcher.wake();
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
