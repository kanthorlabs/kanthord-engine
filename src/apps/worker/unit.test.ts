import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import type { Context } from "../../kernel/context.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { requirePiTools, temporary } from "../../kernel/test-support.ts";
import { directories } from "../../kernel/xdg.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { packageVersion } from "../../kernel/version.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { WorkPullKind } from "../../scheduler/contract.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { WorkerUnit } from "./unit.ts";
import type { WorkerTransport } from "./transport.ts";
import { testClaim } from "./test-support.ts";
import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { hostEnvironment } from "../../kernel/test-support.ts";
import { runVerifications, WorkspaceRoot } from "../../worker/unit/index.ts";
import { spawnSync } from "node:child_process";
import { createIdentity } from "../../kernel/identity.ts";
import { InstanceCleanableKind } from "../../kernel/cleanup.ts";
import { WorkerErrorCode } from "../../worker/contract.ts";
import { simpleGit } from "simple-git";
import {
  deriveHandoverKeys,
  handoverAad,
  sealEnvelope,
} from "../../kernel/handover.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture,
  transport as localTransport,
  scriptedModelRuntime,
  scriptedProvider,
  STEPS_KEY,
  task,
} from "../../worker/unit/test-support.ts";

const CLIENT_SECRET_BYTES = 32;
const SETTLE_WAIT_MS = 50;
const PENDING = "pending";
const TOOL_DEADLINE_MS = 60000;
const PS_FOUND = 0;
const ZOMBIE = "Z";
const LINE_END = "\n";
const GONE_POLL_MS = 10;
const FIRST_PULL = 1;
const SINGLE_RELEASE = 1;
const REMOTE_ADDRESS = "git@github.com:owner/repo.git";
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
  return new Promise((resolve) => {
    if (context)
      addAbortListener(context.signal, () =>
        resolve({ type: OperationResultType.Indeterminate }),
      );
  });
}

function scripted(options: {
  pull: (context: Context | undefined) => Promise<unknown>;
  handover?: () => Promise<unknown>;
  deregister?: () => unknown;
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
        if (options.deregister) return options.deregister();
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
  requirePiTools();
  installPiTools({ env });
  return env;
}

function directoriesOf(env: NodeJS.ProcessEnv) {
  const state = directories(env).state;
  return { data: state, log: state };
}

function unitOf(
  t: TestContext,
  transport: WorkerTransport,
  env: NodeJS.ProcessEnv = environmentOf(t),
) {
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

test("a unit run keeps an idle node workspace and starts no sweep", async (t) => {
  const env = environmentOf(t);
  const idle = WorkspaceRoot.open(directoriesOf(env).data).nodeKey(
    createIdentity("node"),
  );
  mkdirSync(idle, { mode: 0o700 });
  const idleSince = new Date(Date.now() - 365 * 86400000);
  utimesSync(idle, idleSince, idleSince);
  const pulled = Promise.withResolvers<void>();
  const { transport } = scripted({
    pull: (context) => {
      pulled.resolve();
      return cancelled(context);
    },
  });
  const unit = unitOf(t, transport, env);
  const running = unit.run();
  await pulled.promise;
  assert.equal(existsSync(idle), true);
  assert.equal(await unit.drain(), null);
  assert.equal(await running, null);
  assert.equal(existsSync(idle), true);
});

function deregisterFailure(status: number, code: string) {
  return {
    type: OperationResultType.Failure,
    status,
    error: {
      error: { code, message: "test refusal", details: null },
      request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    },
  };
}

async function drainedWith(t: TestContext, deregister: () => unknown) {
  const pulled = Promise.withResolvers<void>();
  const { transport, deregistrations } = scripted({
    pull: (context) => {
      pulled.resolve();
      return cancelled(context);
    },
    deregister,
  });
  const unit = unitOf(t, transport);
  const running = unit.run();
  await pulled.promise;
  const drained = await unit.drain();
  await running;
  assert.deepEqual(deregistrations, [REGISTRATION.runtime_identity]);
  return drained;
}

test("a drain of an ended worker group answers null", async (t) => {
  const drained = await drainedWith(t, () =>
    deregisterFailure(HttpStatus.NotFound, "worker.registration.ended"),
  );
  assert.equal(drained, null);
});

test("a drain whose deregistration answers 401 answers the failure", async (t) => {
  const code = "gateway.authentication.unauthorized";
  const drained = await drainedWith(t, () =>
    deregisterFailure(HttpStatus.Unauthorized, code),
  );
  assert.equal((drained as { code?: string } | null)?.code, code);
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
  while (!pulls) await delay(1, undefined, { signal: t.signal });
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
  while (!pulls) await delay(1, undefined, { signal: t.signal });
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
      if (context)
        addAbortListener(context.signal, () => otherAborted.resolve());
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
  while (otherPulls === FIRST_PULL)
    await delay(1, undefined, { signal: t.signal });
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
  while (!pulls) await delay(1, undefined, { signal: t.signal });
  const execution = (unit as unknown as { execution?: { context: Context } })
    .execution;
  if (execution)
    addAbortListener(execution.context.signal, () =>
      cancelledExecution.resolve(),
    );
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
  await gone(grandchild, t.signal);
  assert.deepEqual(deregistrations, []);
});

function alive(pid: number): boolean {
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return ps.status === PS_FOUND && !ps.stdout.trim().startsWith(ZOMBIE);
}

async function gone(pid: number, signal: AbortSignal): Promise<void> {
  while (alive(pid)) await delay(GONE_POLL_MS, undefined, { signal });
}

async function pidOf(file: string, signal: AbortSignal): Promise<number> {
  for (;;) {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (text.endsWith(LINE_END)) return Number(text);
    await delay(1, undefined, { signal });
  }
}

async function footprintUnit(t: TestContext, answers: unknown[]) {
  const reports: { results: { cleanup_id: string }[] }[] = [];
  const { transport } = scripted({ pull: cancelled });
  const worker = transport.worker as unknown as Record<string, unknown>;
  worker["footprint.report"] = async (input: {
    body: { results: { cleanup_id: string }[] };
  }) => {
    reports.push(input.body);
    return answers.shift();
  };
  const env = environmentOf(t);
  const unit = new WorkerUnit({
    bindings: [
      {
        transport,
        client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
      },
    ],
    directories: directoriesOf(env),
    env: { ...env, TMPDIR: temporary(t) },
    log: () => {},
    footprint: { residue_root: temporary(t), worker_placement: false },
  });
  const running = unit.run();
  t.after(async () => {
    await unit.stop();
    await running;
  });
  while (!reports.length) await delay(GONE_POLL_MS);
  return {
    unit,
    reported: () =>
      reports.map((report) =>
        report.results.map((result) => result.cleanup_id),
      ),
  };
}

function toolOutputOrder(cleanupId: string) {
  return {
    cleanup_id: cleanupId,
    kind: InstanceCleanableKind.ToolOutput,
    keys: ["pi-bash-0123456789abcdef.log"],
  };
}

test("a lost footprint report answer keeps the result, the order does not run again and the next report sends it", async (t) => {
  const { unit, reported } = await footprintUnit(t, [
    completed({ orders: [] }),
    { type: OperationResultType.Indeterminate },
    completed({ orders: [] }),
    completed({ orders: [] }),
  ]);
  const lost = createIdentity("cleanup");
  await unit.footprintOrders([toolOutputOrder(lost)]);
  await unit.footprintOrders([toolOutputOrder(lost)]);
  const next = createIdentity("cleanup");
  await unit.footprintOrders([toolOutputOrder(next)]);
  assert.deepEqual(reported(), [[], [lost], [lost], [next]]);
});

test("an order_unknown answer drops only its own result and the other result reaches the server", async (t) => {
  const { unit, reported } = await footprintUnit(t, [
    completed({ orders: [] }),
    {
      type: OperationResultType.Failure,
      status: HttpStatus.NotFound,
      error: {
        error: {
          code: WorkerErrorCode.FootprintOrderUnknown,
          message:
            "A result names a cleanup that is not an order of the instance.",
        },
        request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      },
    },
    completed({ orders: [] }),
  ]);
  const unknown = createIdentity("cleanup");
  const known = createIdentity("cleanup");
  await unit.footprintOrders([
    toolOutputOrder(unknown),
    toolOutputOrder(known),
  ]);
  assert.deepEqual(reported(), [[], [unknown], [known]]);
});

const STOPPED_FILE = "stopped.txt";
const STOPPED_CONTENT = "stopped";
const WORKER_STOPPED = "worker_stopped";
const INSTANCE_ARCHIVED = "instance_archived";
const HUMAN_PAUSED = "human_paused";
const RELEASE_WAIT_MS = 30000;
const LIVE_STOP = "worker.stop.execution_live";
const REVIEWER = "reviewer@1";
const RELEASE_FAILED = {
  type: OperationResultType.Failure,
  status: HttpStatus.InternalServerError,
  error: {
    error: { code: "scheduler.release.failed", message: "Release failed." },
    request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  },
};

async function liveStopUnit(
  t: TestContext,
  options: { evaluation: boolean; release?: unknown },
) {
  const h = await implementFixture(t, [task("a", "true")], []);
  const repository = h.input.setup.repositories[0]!;
  const snapshot = (
    await simpleGit(h.bare).revparse(["refs/heads/main"])
  ).trim();
  const setup = {
    ...h.input.setup,
    worker_name: options.evaluation ? REVIEWER : h.input.setup.worker_name,
    repositories: [{ ...repository, address: REMOTE_ADDRESS }],
  };
  const claim = {
    ...testClaim(),
    execution_id: setup.execution_id,
    node_id: h.input.claim.node_id,
    node_branch: h.input.claim.node_branch,
  };
  const secret = randomBytes(CLIENT_SECRET_BYTES).toString("base64");
  const credential = {
    credential_id: setup.agents[0]!.credential_id,
    provider_id: "anthropic",
    credential: { type: "api_key", key: STEPS_KEY },
  };
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const blocked = async () => {
    entered.resolve();
    await resume.promise;
    return fauxAssistantMessage("stopped");
  };
  const provider = scriptedProvider(
    options.evaluation
      ? [blocked]
      : [
          fauxAssistantMessage(
            fauxToolCall("bash", {
              command: `printf ${STOPPED_CONTENT} > ${STOPPED_FILE}`,
            }),
            { stopReason: "toolUse" },
          ),
          blocked,
        ],
  );
  const events: string[] = [];
  const releases: unknown[] = [];
  const released = Promise.withResolvers<void>();
  const assessments: unknown[] = [];
  let pulls = 0;
  const content = {
    name: "node",
    requirement: "work",
    criterion: "met",
    verifications: ["true"],
    bindings: [repository.binding_id],
  };
  const assetId = "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA";
  const address = { kind: "produced", sha256: "a".repeat(64) };
  const transport = {
    gateway: {
      openapi: async () =>
        completed(stringify({ info: { version: packageVersion() } })),
    },
    worker: {
      register: async () => completed(REGISTRATION),
      heartbeat: async () => completed(null),
      handover: async () =>
        completed(
          sealEnvelope(
            deriveHandoverKeys(secret).handover,
            handoverAad(claim.execution_id, claim.claimant.runtime_identity),
            { items: [credential], ssh_identities: [] },
          ),
        ),
      "execution.setup.get": async () => completed(setup),
      "action.request": async () => completed({ items: [] }),
      "execution.failed_check.get": async () => completed({ items: [] }),
      "execution.link_update.get": async () =>
        completed({ items: [], next_cursor: null, total: 0 }),
      credential: async () => completed({}),
      "registration.deregister": async (input: {
        params: { runtime_identity: string };
      }) => {
        events.push("deregister");
        return completed({
          runtime_identity: input.params.runtime_identity,
          registered: false,
        });
      },
    },
    scheduler: {
      workPull: async (_input: unknown, call: { context?: Context }) => {
        if (++pulls > FIRST_PULL) return cancelled(call.context);
        return completed({ kind: WorkPullKind.Claimed, execution: claim });
      },
      claimGet: async () => completed({ claim_state: "running" }),
      executionRelease: async (input: { body: unknown }) => {
        events.push("release");
        releases.push(input.body);
        released.resolve();
        return options.release ?? completed({});
      },
    },
    mission: {
      "execution.pinnedRevision.get": async () =>
        completed({ content, tasks: h.revision.tasks }),
      "execution.evidence.list": async () =>
        completed({
          items: options.evaluation
            ? [
                {
                  id: "placed",
                  assets: [{ id: assetId, kind: "produced", address }],
                },
                {
                  id: "snapshot",
                  assets: [
                    {
                      id: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAB",
                      kind: "repository",
                      address: {
                        kind: "repository",
                        binding_id: repository.binding_id,
                        commit: snapshot,
                      },
                    },
                  ],
                },
              ]
            : [],
          next_cursor: null,
        }),
      "execution.evidence.asset.content.get": async () =>
        completed({
          asset_id: assetId,
          address,
          data: Buffer.from("report").toString("base64"),
          encoding: "base64",
          media_type: "text/markdown",
        }),
      "execution.rework_assessment.get": async () => completed(null),
      "execution.review_round.get": async () =>
        completed({ round: 1, final: false, review_base: null, findings: [] }),
      "evidence.submit": async () =>
        completed({ evidence: { id: "verification" } }),
      "assessment.submit": async (input: { body: unknown }) => {
        assessments.push(input.body);
        return completed({ outcome: { id: "outcome" } });
      },
    },
    tracking: { telemetryWrite: async () => completed({}) },
  } as unknown as WorkerTransport;
  const env = environmentOf(t);
  const unit = new WorkerUnit({
    bindings: [{ transport, client_secret: secret }],
    directories: directoriesOf(env),
    env,
    log: () => {},
    model_runtime_factory: scriptedModelRuntime(provider),
    repository_transport: {
      ...localTransport,
      clone: (_address, ...input) => localTransport.clone(h.bare, ...input),
      cloneSnapshot: (_address, ...input) =>
        localTransport.cloneSnapshot(h.bare, ...input),
      pushNodeBranch: async (...input) => {
        events.push("push");
        return localTransport.pushNodeBranch(...input);
      },
    },
  });
  const running = unit.run();
  t.after(async () => {
    resume.resolve();
    await unit.abandon();
  });
  await Promise.race([
    entered.promise,
    running.then((error) => {
      throw error ?? new Error("Unit ended before the execution blocked");
    }),
  ]);
  return {
    unit,
    running,
    resume: () => resume.resolve(),
    bare: h.bare,
    claim,
    events,
    releases,
    released: released.promise,
    assessments,
  };
}

test("a stop during a live steps execution pushes the checkpoint, releases with worker_stopped and then deregisters", async (t) => {
  const live = await liveStopUnit(t, { evaluation: false });
  const stopping = live.unit.stop();
  live.resume();
  assert.equal(await stopping, null);
  assert.equal(await live.running, null);
  assert.deepEqual(live.events, ["push", "release", "deregister"]);
  assert.equal(live.releases.length, SINGLE_RELEASE);
  assert.deepEqual(live.releases[0], {
    further_work: true,
    stop: {
      reason: WORKER_STOPPED,
      code: null,
      cause: (live.releases[0] as { stop: { cause: unknown } }).stop.cause,
    },
  });
  assert.equal(
    await simpleGit(live.bare).show([
      `refs/heads/${live.claim.node_branch}:${STOPPED_FILE}`,
    ]),
    STOPPED_CONTENT,
  );
});

test(
  "an instance_archived stop order pushes the checkpoint and releases with instance_archived",
  { timeout: RELEASE_WAIT_MS * 2 },
  async (t) => {
    const live = await liveStopUnit(t, { evaluation: false });
    live.unit.stopOrders([
      { execution_id: live.claim.execution_id, reason: INSTANCE_ARCHIVED },
    ]);
    live.resume();
    await live.released;
    assert.deepEqual(live.events, ["push", "release"]);
    assert.deepEqual(live.releases[0], {
      further_work: true,
      stop: {
        reason: INSTANCE_ARCHIVED,
        code: null,
        cause: (live.releases[0] as { stop: { cause: unknown } }).stop.cause,
      },
    });
    assert.equal(
      await simpleGit(live.bare).show([
        `refs/heads/${live.claim.node_branch}:${STOPPED_FILE}`,
      ]),
      STOPPED_CONTENT,
    );
    assert.equal(await live.unit.stop(), null);
    assert.equal(await live.running, null);
  },
);

test(
  "a human_paused stop order pushes the checkpoint and releases with human_paused",
  { timeout: RELEASE_WAIT_MS * 2 },
  async (t) => {
    const live = await liveStopUnit(t, { evaluation: false });
    live.unit.stopOrders([
      { execution_id: live.claim.execution_id, reason: HUMAN_PAUSED },
    ]);
    live.resume();
    await live.released;
    assert.deepEqual(live.events, ["push", "release"]);
    assert.deepEqual(live.releases[0], {
      further_work: true,
      stop: {
        reason: HUMAN_PAUSED,
        code: null,
        cause: (live.releases[0] as { stop: { cause: unknown } }).stop.cause,
      },
    });
    assert.equal(
      await simpleGit(live.bare).show([
        `refs/heads/${live.claim.node_branch}:${STOPPED_FILE}`,
      ]),
      STOPPED_CONTENT,
    );
    assert.equal(await live.unit.stop(), null);
    assert.equal(await live.running, null);
  },
);

test("a stop order of another execution leaves the live execution running", async (t) => {
  const live = await liveStopUnit(t, { evaluation: false });
  live.unit.stopOrders([
    { execution_id: createIdentity("execution"), reason: INSTANCE_ARCHIVED },
  ]);
  live.resume();
  assert.equal(await live.unit.stop(), null);
  assert.equal(await live.running, null);
  assert.equal(
    (live.releases[0] as { stop: { reason: string } }).stop.reason,
    WORKER_STOPPED,
  );
});

test("a stop during a live evaluation releases with worker_stopped and submits no assessment", async (t) => {
  const live = await liveStopUnit(t, { evaluation: true });
  const stopping = live.unit.stop();
  live.resume();
  assert.equal(await stopping, null);
  assert.equal(await live.running, null);
  assert.deepEqual(live.events, ["release", "deregister"]);
  assert.equal(
    (live.releases[0] as { stop: { reason: string } }).stop.reason,
    WORKER_STOPPED,
  );
  assert.deepEqual(live.assessments, []);
});

test("a stop whose release fails answers worker.stop.execution_live with the execution id and deregisters nothing", async (t) => {
  const live = await liveStopUnit(t, {
    evaluation: false,
    release: RELEASE_FAILED,
  });
  const stopping = live.unit.stop();
  live.resume();
  const error = await stopping;
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, LIVE_STOP);
  assert.ok(error.message.includes(live.claim.execution_id));
  await live.running;
  assert.deepEqual(live.events, ["push", "release"]);
});
