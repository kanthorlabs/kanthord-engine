import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import type { Context } from "../../kernel/context.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { temporary } from "../../kernel/test-support.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { packageVersion } from "../../kernel/version.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { WorkPullKind } from "../../scheduler/contract.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { WorkerUnit } from "./unit.ts";
import type { WorkerTransport } from "./transport.ts";
import { testClaim } from "./test-support.ts";

const CLIENT_SECRET_BYTES = 32;
const SETTLE_WAIT_MS = 50;
const PENDING = "pending";
const FIRST_PULL = 1;
const REGISTRATION = {
  runtime_identity: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  resource_identity: "worker:kanthord:test",
  worker_name: "coder@1",
};
const PROOF_FAILED = {
  type: OperationResultType.Failure,
  status: HttpStatus.Forbidden,
  error: {
    error: {
      code: "gateway.invocation.execution_proof_failed",
      message: "The execution is not a live claim of this registration.",
    },
    request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  },
};

function completed<T>(data: T) {
  return { type: OperationResultType.Completed, status: HttpStatus.OK, data };
}

function cancelled(context: Context | undefined) {
  return new Promise((resolve) =>
    context?.onCancel(() =>
      resolve({ type: OperationResultType.Indeterminate }),
    ),
  );
}

function scripted(options: {
  pull: (context: Context | undefined) => Promise<unknown>;
  handover?: () => Promise<unknown>;
}) {
  const deregistrations: string[] = [];
  const transport = {
    gateway: {
      openapi: async () =>
        completed(stringify({ info: { version: packageVersion() } })),
    },
    worker: {
      register: async () => completed(REGISTRATION),
      heartbeat: async () => completed(null),
      handover: options.handover,
      "instance.deregister": async (input: {
        params: { runtime_identity: string };
      }) => {
        deregistrations.push(input.params.runtime_identity);
        return completed({
          runtime_identity: input.params.runtime_identity,
          registered: false,
        });
      },
    },
    scheduler: {
      workPull: (_input: unknown, call: { context?: Context }) =>
        options.pull(call.context),
    },
    mission: {},
    tracking: {},
  } as unknown as WorkerTransport;
  return { transport, deregistrations };
}

function environmentOf(t: TestContext): NodeJS.ProcessEnv {
  const env = { XDG_CONFIG_HOME: temporary(t), XDG_STATE_HOME: temporary(t) };
  try {
    installPiTools({ env });
  } catch (error) {
    assert.fail(
      `${(error as Error).message} Run pnpm run pi-tools:fetch before this test.`,
    );
  }
  return env;
}

function unitOf(t: TestContext, transport: WorkerTransport) {
  return new WorkerUnit({
    transport,
    client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
    env: environmentOf(t),
    log: () => {},
  });
}

async function state(task: Promise<unknown>): Promise<string> {
  return Promise.race([
    task.then(() => "settled"),
    delay(SETTLE_WAIT_MS).then(() => PENDING),
  ]);
}

test("an idle unit deregisters and ends run at a drain", async (t) => {
  const pulled = Promise.withResolvers<void>();
  const { transport, deregistrations } = scripted({
    pull: (context) => {
      pulled.resolve();
      return cancelled(context);
    },
  });
  const unit = unitOf(t, transport);
  const running = unit.run();
  await pulled.promise;
  assert.deepEqual(await unit.healthcheck(), { client: HealthStatus.Healthy });
  assert.equal(await unit.drain(), null);
  assert.equal(await running, null);
  assert.deepEqual(deregistrations, [REGISTRATION.runtime_identity]);
  assert.deepEqual(await unit.healthcheck(), {
    client: HealthStatus.Unavailable,
  });
});

test("a busy unit ends its execution before it deregisters at a drain", async (t) => {
  const handover = Promise.withResolvers<unknown>();
  let pulls = 0;
  const { transport, deregistrations } = scripted({
    pull: async (context) => {
      if (++pulls > FIRST_PULL) return cancelled(context);
      return completed({ kind: WorkPullKind.Claimed, execution: testClaim() });
    },
    handover: () => handover.promise,
  });
  const unit = unitOf(t, transport);
  const running = unit.run();
  while (!pulls) await delay(1);
  const draining = unit.drain();
  assert.equal(await state(running), PENDING);
  assert.deepEqual(deregistrations, []);
  handover.resolve(PROOF_FAILED);
  assert.equal(await draining, null);
  assert.equal(await running, null);
  assert.equal(pulls, FIRST_PULL);
  assert.deepEqual(deregistrations, [REGISTRATION.runtime_identity]);
});

test("a unit that drains before its first pull resumes its running execution and then ends", async (t) => {
  const handover = Promise.withResolvers<unknown>();
  let pulls = 0;
  const { transport, deregistrations } = scripted({
    pull: async () => {
      pulls++;
      return completed({ kind: WorkPullKind.Claimed, execution: testClaim() });
    },
    handover: () => handover.promise,
  });
  const unit = unitOf(t, transport);
  const running = unit.run();
  const draining = unit.drain();
  while (!pulls) await delay(1);
  assert.equal(await state(running), PENDING);
  assert.deepEqual(deregistrations, []);
  handover.resolve(PROOF_FAILED);
  assert.equal(await running, null);
  assert.equal(await draining, null);
  assert.equal(pulls, FIRST_PULL);
  assert.deepEqual(deregistrations, [REGISTRATION.runtime_identity]);
});

test("a unit that drains before its first pull ends after one pull that finds no execution", async (t) => {
  let pulls = 0;
  const { transport, deregistrations } = scripted({
    pull: async () => {
      pulls++;
      return completed({ kind: WorkPullKind.NoWork });
    },
  });
  const unit = unitOf(t, transport);
  const running = unit.run();
  void unit.drain();
  assert.equal(await running, null);
  assert.equal(pulls, FIRST_PULL);
  assert.deepEqual(deregistrations, [REGISTRATION.runtime_identity]);
});

test("a unit that drains before its first pull cancels a pull that waits for work", async (t) => {
  let pulls = 0;
  const { transport, deregistrations } = scripted({
    pull: (context) => {
      pulls++;
      return cancelled(context);
    },
  });
  const unit = new WorkerUnit({
    transport,
    client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
    env: environmentOf(t),
    log: () => {},
    resume_pull_wait_ms: SETTLE_WAIT_MS,
  });
  const running = unit.run();
  void unit.drain();
  assert.equal(await running, null);
  assert.equal(pulls, FIRST_PULL);
  assert.deepEqual(deregistrations, [REGISTRATION.runtime_identity]);
});
