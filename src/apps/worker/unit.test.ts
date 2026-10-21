import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import type { Context } from "../../kernel/context.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { temporary } from "../../kernel/test-support.ts";
import { directories } from "../../kernel/xdg.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { packageVersion } from "../../kernel/version.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { WorkPullKind } from "../../scheduler/contract.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { WorkerUnit } from "./unit.ts";
import type { WorkerTransport } from "./transport.ts";
import { testClaim } from "./test-support.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostEnvironment } from "../../kernel/test-support.ts";
import { runVerifications } from "../../worker/unit/index.ts";
import { spawnSync } from "node:child_process";

const CLIENT_SECRET_BYTES = 32;
const SETTLE_WAIT_MS = 50;
const PENDING = "pending";
const TOOL_DEADLINE_MS = 60000;
const PS_FOUND = 0;
const ZOMBIE = "Z";
const LINE_END = "\n";
const FIRST_PULL = 1;
const REGISTRATION = {
  runtime_identity: "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAA",
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
      "registration.deregister": async (input: {
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

function directoriesOf(env: NodeJS.ProcessEnv) {
  const state = directories(env).state;
  return { data: state, log: state };
}

function unitOf(t: TestContext, transport: WorkerTransport) {
  const env = environmentOf(t);
  return new WorkerUnit({
    bindings: [
      {
        transport,
        client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
      },
    ],
    directories: directoriesOf(env),
    env,
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
  const env = environmentOf(t);
  const unit = new WorkerUnit({
    bindings: [
      {
        transport,
        client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
      },
    ],
    directories: directoriesOf(env),
    env,
    log: () => {},
    resume_pull_wait_ms: SETTLE_WAIT_MS,
  });
  const running = unit.run();
  void unit.drain();
  assert.equal(await running, null);
  assert.equal(pulls, FIRST_PULL);
  assert.deepEqual(deregistrations, [REGISTRATION.runtime_identity]);
});

function multiUnit(t: TestContext, bindings: WorkerTransport[]) {
  const env = environmentOf(t);
  return new WorkerUnit({
    bindings: bindings.map((transport) => ({
      transport,
      client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
    })),
    directories: directoriesOf(env),
    env,
    log: () => {},
  });
}

test("a claim on one binding aborts the pull of the other binding until the execution ends", async (t) => {
  const handover = Promise.withResolvers<unknown>();
  const otherAborted = Promise.withResolvers<void>();
  let claims = 0;
  let otherPulls = 0;
  const claiming = scripted({
    pull: async (context) => {
      if (++claims > FIRST_PULL) return cancelled(context);
      await delay(SETTLE_WAIT_MS);
      return completed({ kind: WorkPullKind.Claimed, execution: testClaim() });
    },
    handover: () => handover.promise,
  });
  const other = scripted({
    pull: (context) => {
      otherPulls++;
      context?.onCancel(() => otherAborted.resolve());
      return cancelled(context);
    },
  });
  const unit = multiUnit(t, [claiming.transport, other.transport]);
  const running = unit.run();
  await otherAborted.promise;
  assert.equal(otherPulls, FIRST_PULL);
  await delay(SETTLE_WAIT_MS);
  assert.equal(otherPulls, FIRST_PULL);
  handover.resolve(PROOF_FAILED);
  while (otherPulls === FIRST_PULL) await delay(1);
  assert.equal(await unit.drain(), null);
  assert.equal(await running, null);
  assert.deepEqual(claiming.deregistrations, [REGISTRATION.runtime_identity]);
  assert.deepEqual(other.deregistrations, [REGISTRATION.runtime_identity]);
});

test("remove ends the pulls of one binding and deregisters it while the unit runs", async (t) => {
  const first = scripted({ pull: (context) => cancelled(context) });
  const second = scripted({ pull: (context) => cancelled(context) });
  const env = environmentOf(t);
  const kept = {
    transport: first.transport,
    client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
  };
  const dropped = {
    transport: second.transport,
    client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
  };
  const unit = new WorkerUnit({
    bindings: [kept],
    directories: directoriesOf(env),
    env,
    log: () => {},
  });
  const running = unit.run();
  assert.equal(await unit.start(), null);
  assert.equal(await unit.add(dropped), null);
  assert.equal(await unit.remove(dropped), null);
  assert.deepEqual(second.deregistrations, [REGISTRATION.runtime_identity]);
  assert.deepEqual(first.deregistrations, []);
  assert.equal(await unit.drain(), null);
  assert.equal(await running, null);
  assert.deepEqual(first.deregistrations, [REGISTRATION.runtime_identity]);
});

test("abandon cancels the live execution and keeps every registration", async (t) => {
  const cancelledExecution = Promise.withResolvers<void>();
  let pulls = 0;
  const { transport, deregistrations } = scripted({
    pull: async (context) => {
      if (++pulls > FIRST_PULL) return cancelled(context);
      return completed({ kind: WorkPullKind.Claimed, execution: testClaim() });
    },
    handover: ((_input: unknown, call?: { context?: Context }) =>
      cancelled(call?.context)) as () => Promise<unknown>,
  });
  const unit = multiUnit(t, [transport]);
  const running = unit.run();
  while (!pulls) await delay(1);
  const execution = (unit as unknown as { execution?: { context: Context } })
    .execution;
  execution?.context.onCancel(() => cancelledExecution.resolve());
  const abandoned = unit.abandon();
  await cancelledExecution.promise;
  const error = await abandoned;
  assert.ok(error);
  await running;
  assert.deepEqual(deregistrations, []);
});

test("abandon kills the tool process group of the live execution", async (t) => {
  const directory = temporary(t);
  const pidFile = join(directory, "grandchild.pid");
  let pulls = 0;
  const tool = Promise.withResolvers<{ run: Promise<unknown> }>();
  const { transport, deregistrations } = scripted({
    pull: async (context) => {
      if (++pulls > FIRST_PULL) return cancelled(context);
      return completed({ kind: WorkPullKind.Claimed, execution: testClaim() });
    },
    handover: ((_input: unknown, call?: { context?: Context }) => {
      tool.resolve({
        run: delay(0).then(() =>
          runVerifications({
            directory,
            commands: [`sleep 30 & echo $! > ${pidFile}; wait`],
            tested_input: { kind: "produced", sha256: "hash" },
            deadline: Date.now() + TOOL_DEADLINE_MS,
            context: (unit as unknown as { execution: { context: Context } })
              .execution.context,
            env: hostEnvironment(),
          }),
        ),
      });
      return cancelled(call?.context);
    }) as () => Promise<unknown>,
  });
  const unit = multiUnit(t, [transport]);
  const running = unit.run();
  const verification = (await tool.promise).run;
  const grandchild = await pidOf(pidFile, t.signal);
  assert.ok(alive(grandchild));
  const abandoned = unit.abandon();
  await verification;
  assert.ok(await abandoned);
  await running;
  assert.equal(alive(grandchild), false);
  assert.deepEqual(deregistrations, []);
});

function alive(pid: number): boolean {
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return ps.status === PS_FOUND && !ps.stdout.trim().startsWith(ZOMBIE);
}

async function pidOf(file: string, signal: AbortSignal): Promise<number> {
  for (;;) {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (text.endsWith(LINE_END)) return Number(text);
    await delay(1, undefined, { signal });
  }
}
