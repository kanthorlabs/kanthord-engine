import assert from "node:assert/strict";
import type { Logger } from "pino";
import { ulid } from "ulid";
import type { ServiceIdentity } from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import { diagnostic } from "../kernel/errors.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { ValueType } from "../kernel/values.ts";
import { configurationSchemaOf } from "./configuration.ts";
import {
  InboundEventState,
  type ConsumerValue,
  type IntakeConsumers,
} from "./contract.ts";
import {
  eventState,
  failEvent,
  oldestPendingEvent,
  pendingCount,
  readEvent,
  succeedEvent,
} from "./event-store.ts";
import { readInbound } from "./inbound-store.ts";

const NO_LENGTH = 0;
const FIRST_STEP = 0;
const FINAL_SELECTION = 1;
const MAX_IN_FLIGHT = 1;
const EVENT_ENCODING = "base64";
const INDETERMINATE_CODE = "indeterminate";
const INDETERMINATE_MESSAGE = "The consumer call answered no result.";
const DEFECT_CODE = "system.operation.unknown";
const DEFECT_MESSAGE = "The consumer call failed.";

export interface DispatcherDependencies {
  store: Store;
  logger: Logger;
  identity: ServiceIdentity;
  consumers: IntakeConsumers;
  context: Context;
}

type ConsumerInput = Parameters<IntakeConsumers[ConsumerValue]>[0];

interface Handoff {
  consumer: ConsumerValue;
  input: ConsumerInput;
}

type Outcome =
  { succeeded: true } | { succeeded: false; code: string; message: string };

const SUCCEEDED: Outcome = Object.freeze({ succeeded: true });
const SKIPPED = Symbol("skipped");

export function nextCandidate(
  tx: Transaction,
  inFlight: ReadonlySet<string>,
): string | null {
  assert.ok(inFlight.size <= MAX_IN_FLIGHT, "One handoff runs at a time.");
  const id = oldestPendingEvent(tx, inFlight);
  assert.ok(id === null || !inFlight.has(id), "A candidate is not in flight.");
  return id;
}

export function reserve(
  tx: Transaction,
  inFlight: Set<string>,
  id: string,
): boolean {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  assert.ok(inFlight.size < MAX_IN_FLIGHT, "One handoff runs at a time.");
  if (eventState(tx, id) !== InboundEventState.Pending) return false;
  inFlight.add(id);
  return true;
}

function handoffOf(tx: Transaction, id: string): Handoff {
  const event = readEvent(tx, id);
  assert.ok(event !== null, "A reserved event row exists.");
  const inbound = readInbound(tx, event.inbound_id);
  assert.ok(inbound !== null, "An event with a pending state has an inbound.");
  const configuration = configurationSchemaOf(
    inbound.kind,
    inbound.platform,
  ).parse(JSON.parse(inbound.configuration));
  return {
    consumer: inbound.consumer,
    input: {
      inbound_event_id: event.id,
      project_id: inbound.project_id,
      platform: inbound.platform,
      resource: configuration.resource,
      event: Buffer.from(event.event).toString(EVENT_ENCODING),
      metadata: JSON.parse(event.metadata) as Record<string, unknown>,
    },
  };
}

function outcomeOf(result: OperationResult<unknown>): Outcome {
  assert.ok(Object.values(OperationResultType).includes(result.type));
  if (result.type === OperationResultType.Completed) return SUCCEEDED;
  if (result.type === OperationResultType.Indeterminate)
    return {
      succeeded: false,
      code: INDETERMINATE_CODE,
      message: INDETERMINATE_MESSAGE,
    };
  assert.ok(result.error.error.code.length > NO_LENGTH, "A failure has code.");
  return {
    succeeded: false,
    code: result.error.error.code,
    message: result.error.error.message,
  };
}

function settle(tx: Transaction, id: string, outcome: Outcome): void {
  const written = outcome.succeeded
    ? succeedEvent(tx, id)
    : failEvent(tx, id, {
        code: outcome.code,
        message: outcome.message,
        created_at: Date.now(),
      });
  if (written) return;
  const state = eventState(tx, id);
  assert.ok(
    state !== InboundEventState.Pending,
    "A conditional write that changes no row meets another state.",
  );
}

export class Dispatcher {
  private readonly dependencies: DispatcherDependencies;
  private readonly running = new Set<string>();
  private drainTask: Promise<void> | null = null;
  private again = false;
  private quiescent = false;

  constructor(dependencies: DispatcherDependencies) {
    this.dependencies = dependencies;
  }

  wake(): void {
    if (this.quiescent) return;
    if (this.drainTask !== null) {
      this.again = true;
      return;
    }
    this.drainTask = this.drain().finally(() => {
      this.drainTask = null;
    });
  }

  inFlight(id: string): boolean {
    assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
    return this.running.has(id);
  }

  quiesce(): void {
    this.quiescent = true;
    assert.ok(this.halted(), "A quiescent dispatcher starts no handoff.");
  }

  async join(): Promise<void> {
    await this.drainTask;
  }

  private halted(): boolean {
    return this.quiescent || this.dependencies.context.err() !== null;
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      await this.pass();
    } while (this.again && !this.halted());
  }

  private async pass(): Promise<void> {
    const store = this.dependencies.store;
    const limit = store.transaction((tx) => pendingCount(tx)) + FINAL_SELECTION;
    assert.ok(limit >= FINAL_SELECTION, "A pass selects at least once.");
    for (let step = FIRST_STEP; step < limit; step++) {
      if (this.halted()) return;
      const selected = this.select();
      if (selected === null) return;
      if (selected !== SKIPPED) await this.handOver(selected);
    }
    this.again = true;
  }

  private select(): string | typeof SKIPPED | null {
    const store = this.dependencies.store;
    const candidate = store.transaction((tx) =>
      nextCandidate(tx, this.running),
    );
    if (candidate === null) return null;
    const reserved = store.transaction((tx) =>
      reserve(tx, this.running, candidate),
    );
    return reserved ? candidate : SKIPPED;
  }

  private async handOver(id: string): Promise<void> {
    assert.ok(this.running.has(id), "A handoff owns its reservation.");
    const store = this.dependencies.store;
    try {
      const handoff = store.transaction((tx) => handoffOf(tx, id));
      const outcome = await this.call(handoff);
      store.transaction((tx) => settle(tx, id, outcome));
    } finally {
      this.running.delete(id);
    }
  }

  private async call(handoff: Handoff): Promise<Outcome> {
    const { consumers, identity, context, logger } = this.dependencies;
    assert.equal(typeof consumers[handoff.consumer], ValueType.Function);
    try {
      const result = await consumers[handoff.consumer](handoff.input, {
        identity,
        idempotencyKey: ulid(),
        context,
      });
      return outcomeOf(result);
    } catch (error) {
      logger.error(
        {
          inbound_event_id: handoff.input.inbound_event_id,
          consumer: handoff.consumer,
          reason: diagnostic(error),
        },
        "intake: the consumer call of an inbound event failed.",
      );
      return { succeeded: false, code: DEFECT_CODE, message: DEFECT_MESSAGE };
    }
  }
}
