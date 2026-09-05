import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

import { claimNode } from "../../src/commands/node/claim-node.ts";
import { updateNode } from "../../src/commands/node/update-node.ts";
import type { ActorRow } from "../../src/domain/actor.ts";
import type { Clock } from "../../src/services/clock/index.ts";
import type {
  EventLog,
  RecordedEvent,
} from "../../src/services/event/index.ts";
import { migrations } from "../../src/services/storage/migrations.ts";
import { SqliteStorage } from "../../src/services/storage/sqlite.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanStore,
  createReadiness,
  createRevision,
  nodeBaselineRevision,
  planFixtureBodies,
  planFixtureIdentities,
} from "./plan.ts";
import { createMockClock } from "./clock.ts";
import { createMockIdGenerator } from "./ids.ts";
import { createBackedExecutionFake } from "./execution.ts";
import { createBackedLeaseFake } from "./lease.ts";
import { workerRegistry } from "../../src/domain/worker-registry.ts";
import type { Storage, Transaction } from "../../src/services/storage/index.ts";

const CLOCK_START = 1700000000000;
const RELEASE_FIRST = 0;
const START_FIRST = 1;
const START_SECOND = 2;

const HARNESS_ACTOR: ActorRow = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
  kind: "harness",
  name: "harness-a",
  tokenSha256: new Uint8Array(32),
  registeredBy: "actor_00000000000000000000000000",
  createdAt: 1720000000000,
  revokedAt: null,
  revokedBy: null,
};

type WorkerRole = "claim" | "update";

type WorkerInput = Readonly<{
  databasePath: string;
  role: WorkerRole;
  first: boolean;
  control: SharedArrayBuffer;
}>;

type WorkerError = Readonly<{
  name: string;
  message: string;
  refusal?: string;
  details?: unknown;
}>;

export type ConcurrentWriteOutcome =
  | Readonly<{ status: "fulfilled"; value: unknown }>
  | Readonly<{ status: "rejected"; error: WorkerError }>;

export type ConcurrentWritePair = Readonly<{
  claim: ConcurrentWriteOutcome;
  update: ConcurrentWriteOutcome;
}>;

type WorkerMessage =
  | Readonly<{ type: "ready" }>
  | Readonly<{ type: "transaction-entered" }>
  | Readonly<{ type: "transaction-starting" }>
  | Readonly<{
      type: "result";
      outcome: ConcurrentWriteOutcome;
    }>;

const EVENTS: EventLog = {
  append(_transaction: Transaction, input): RecordedEvent {
    return {
      id: "event_worker",
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      type: input.type,
      actorKind: input.actorKind,
      actorId: input.actorId,
      payload: input.payload,
      occurredAt: CLOCK_START,
    };
  },
  list(): readonly RecordedEvent[] {
    return [];
  },
};

export async function runConcurrentClaimAndUpdate(
  databasePath: string,
  first: WorkerRole,
): Promise<ConcurrentWritePair> {
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const firstWorker = startWorker({
    databasePath,
    role: first,
    first: true,
    control,
  });
  const firstResult = observeResult(firstWorker);
  let secondWorker: Worker | undefined;

  try {
    await waitForMessage(firstWorker, "ready");

    const second = first === "claim" ? "update" : "claim";
    secondWorker = startWorker({
      databasePath,
      role: second,
      first: false,
      control,
    });
    const secondResult = observeResult(secondWorker);
    await waitForMessage(secondWorker, "ready");

    signal(control, START_FIRST);
    await waitForMessage(firstWorker, "transaction-entered");

    signal(control, START_SECOND);
    await waitForMessage(secondWorker, "transaction-starting");

    signal(control, RELEASE_FIRST);
    const [firstOutcome, secondOutcome] = await Promise.all([
      firstResult,
      secondResult,
    ]);

    return first === "claim"
      ? { claim: firstOutcome, update: secondOutcome }
      : { claim: secondOutcome, update: firstOutcome };
  } finally {
    await Promise.all(
      [firstWorker, secondWorker]
        .filter((worker): worker is Worker => worker !== undefined)
        .map((worker) => worker.terminate()),
    );
  }
}

function startWorker(input: WorkerInput): Worker {
  return new Worker(new URL(import.meta.url), {
    workerData: input,
  });
}

function signal(controlBuffer: SharedArrayBuffer, index: number): void {
  const control = new Int32Array(controlBuffer);
  Atomics.store(control, index, 1);
  Atomics.notify(control, index);
}

function waitForMessage(
  worker: Worker,
  type: WorkerMessage["type"],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish();
      reject(new Error(`worker did not send ${type}`));
    }, 10000);

    const onMessage = (message: unknown): void => {
      if (!isMessage(message) || message.type !== type) {
        return;
      }
      finish();
      resolve();
    };
    const onError = (error: Error): void => {
      finish();
      reject(error);
    };
    const onExit = (code: number): void => {
      if (code === 0) {
        return;
      }
      finish();
      reject(new Error(`worker exited with code ${code}`));
    };
    const finish = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function observeResult(worker: Worker): Promise<ConcurrentWriteOutcome> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (!isMessage(message) || message.type !== "result") {
        return;
      }
      finish();
      resolve(message.outcome);
    };
    const onError = (error: Error): void => {
      finish();
      reject(error);
    };
    const onExit = (code: number): void => {
      if (code === 0) {
        return;
      }
      finish();
      reject(new Error(`worker exited with code ${code}`));
    };
    const finish = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function isMessage(message: unknown): message is WorkerMessage {
  return (
    message !== null &&
    typeof message === "object" &&
    "type" in message &&
    typeof message.type === "string"
  );
}

async function runWorker(input: WorkerInput): Promise<void> {
  const storage = new SqliteStorage({
    path: input.databasePath,
    clock: createMockClock({ start: CLOCK_START }),
    migrations,
  });
  try {
    const plan = createPlanStore(createReadiness(EVENTS, "daemon_test"));
    const clock = input.first
      ? createFirstClock(input.control)
      : createMockClock({ start: CLOCK_START, step: 1000 });
    const blobs = createBlobStore(storage, clock);
    const graph = createPlanGraph();
    const revision = createRevision(blobs, plan);
    const commandStorage = input.first
      ? storage
      : createSignalingStorage(storage);

    post({ type: "ready" });
    waitForGate(input.control, input.first ? START_FIRST : START_SECOND);

    let outcome: ConcurrentWriteOutcome;
    try {
      outcome = {
        status: "fulfilled",
        value:
          input.role === "claim"
            ? claimNode(
                {
                  storage: commandStorage,
                  plan,
                  lease: createBackedLeaseFake().lease,
                  execution: createBackedExecutionFake({
                    ids: createMockIdGenerator({
                      ulids: [
                        "01GQZ3NDEKTSV4RRFFQ69G5FC1",
                        "01GQZ3NDEKTSV4RRFFQ69G5FC2",
                        "01GQZ3NDEKTSV4RRFFQ69G5FC3",
                      ],
                    }),
                  }).execution,
                  events: EVENTS,
                  clock,
                  ids: createMockIdGenerator({
                    ulids: ["01GQZ3NDEKTSV4RRFFQ69G5FC3"],
                  }),
                  expiry: {
                    expireRuns() {
                      return [];
                    },
                  },
                  callerRecord: {
                    worker: "claude@1",
                    authorized: ["claude@1"],
                  },
                  registry: workerRegistry,
                  attemptLimit: 3,
                  leaseTtlMs: 300000,
                  runTtlMs: 120000,
                  runMaxLifetimeMs: 900000,
                  instanceId: "daemon_test",
                },
                {
                  nodeId: planFixtureIdentities.task,
                  actorId: "actor_concurrent_claim",
                  actorKind: "harness",
                  available: true,
                },
              )
            : updateNode(
                {
                  storage: commandStorage,
                  plan,
                  blobs,
                  graph,
                  ids: createMockIdGenerator({
                    ulids: ["01BQZ3NDEKTSV4RRFFQ69G5FC2"],
                  }),
                  clock,
                  events: EVENTS,
                  revision,
                },
                {
                  id: planFixtureIdentities.task,
                  fromRevision: nodeBaselineRevision,
                  node: {
                    kind: "task",
                    title: "Concurrent title",
                    parentId: planFixtureIdentities.objective,
                    instruction: planFixtureBodies.taskInstruction,
                    acceptance: planFixtureBodies.taskAcceptance,
                    worker: null,
                    dependsOn: [],
                  },
                  actor: HARNESS_ACTOR,
                },
              ),
      };
    } catch (error) {
      outcome = { status: "rejected", error: serializeError(error) };
    }
    post({ type: "result", outcome });
  } finally {
    storage.close();
  }
}

function createSignalingStorage(storage: Storage): Storage {
  return {
    transact<T>(work: (transaction: Transaction) => T): T {
      post({ type: "transaction-starting" });
      return storage.transact(work);
    },
    migrate() {
      return storage.migrate();
    },
    status() {
      return storage.status();
    },
    close() {
      storage.close();
    },
    ping() {
      storage.ping();
    },
  };
}

function createFirstClock(controlBuffer: SharedArrayBuffer): Clock {
  let firstCall = true;
  return {
    now(): number {
      if (firstCall) {
        firstCall = false;
        post({ type: "transaction-entered" });
        waitForGate(controlBuffer, RELEASE_FIRST);
      }
      return CLOCK_START;
    },
  };
}

function waitForGate(controlBuffer: SharedArrayBuffer, index: number): void {
  const control = new Int32Array(controlBuffer);
  if (Atomics.wait(control, index, 0, 10000) === "timed-out") {
    throw new Error(`worker gate ${index} timed out`);
  }
}

function post(message: WorkerMessage): void {
  if (parentPort === null) {
    throw new Error("worker parent port is unavailable");
  }
  parentPort.postMessage(message);
}

function serializeError(error: unknown): WorkerError {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error) };
  }
  const candidate = error as Error & {
    refusal?: unknown;
    details?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    ...(typeof candidate.refusal === "string"
      ? { refusal: candidate.refusal }
      : {}),
    ...(candidate.details !== undefined ? { details: candidate.details } : {}),
  };
}

if (!isMainThread) {
  void runWorker(workerData as WorkerInput).catch((error: unknown) => {
    post({
      type: "result",
      outcome: { status: "rejected", error: serializeError(error) },
    });
  });
}
