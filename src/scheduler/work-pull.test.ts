import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { ChainLevel } from "../agent/contract.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  ClaimNodeState,
  ClaimIntent,
  WorkPullKind,
  WORK_PULL_WAIT_MS,
  AgentChoiceKind,
  type AgentPin,
  type AgentSelection,
} from "./contract.ts";
import { insertExecution, readExecution } from "./execution-store.ts";
import {
  schedulerHarness,
  executionFixture,
  transitionFixture,
} from "./test-support.ts";
import { ExecutionEnd } from "../tracking/contract.ts";
import { executionTrace } from "./telemetry.ts";
import { DEFAULT_STOP_BACKOFF_SECONDS } from "./config.ts";

const NO_COMMITS = 0;
const NO_CLAIMS = 0;
const ONE_COMMIT = 1;
const ONE_REPORT = 1;
const END_AND_TRANSITION = 2;
const TWO_CHECKS = 2;
const FIRST_ATTEMPT = 1;
const CLAIMANT_MISMATCH = "scheduler.work.claimant_mismatch";
const CANCELLED = "gateway.invocation.cancelled";
const THREE_COMMITS = 3;

function harness(t: TestContext) {
  const h = schedulerHarness(t);
  const row = executionFixture({
    created_at: Date.now(),
    expired_at: Date.now() + 10000,
  });
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      issuedAt: Date.now(),
    },
    "pull",
    row.runtime_identity,
  );
  h.dependencies.bindings.workerBindingOf = () => ({
    binding_id: row.worker_binding_id,
    worker_name: "coder@1",
    instance_count: 2,
    tags: [],
    environment: null,
    tombstone: false,
  });
  h.dependencies.declarations.declarationOf = () => ({
    declared_node_states: [ClaimNodeState.Available],
    declared_intents: Object.values(ClaimIntent),
    resource_budget: { wall_time_ms: 7200000 },
  });
  h.dependencies.transitions.claim = (tx, nodeId) => {
    h.service.delete(tx, nodeId);
    tx.database.prepare("INSERT INTO attempts VALUES (?)").run(nodeId);
    return {
      kind: "steps",
      project_id: row.project_id,
      attempt: 1,
      node_revision: 1,
    };
  };
  h.store.database.exec("CREATE TABLE attempts (node_id TEXT PRIMARY KEY)");
  let commits = 0;
  const caller: CallerContext = {
    identity,
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => {
      commits++;
      return h.store.transaction(write);
    },
  };
  const input = {
    params: {},
    query: {},
    body: {
      resource_identity: row.resource_identity,
      runtime_identity: row.runtime_identity,
    },
  };
  const pull = (context = caller.context) =>
    h.invoke("workPull", input, { ...caller, context });
  const enqueue = () =>
    h.store.transaction((tx) =>
      h.service.insert(tx, row.node_id, row.project_id, 0),
    );
  return {
    ...h,
    row,
    identity,
    caller,
    input,
    pull,
    enqueue,
    commits: () => commits,
  };
}

for (const [name, sameRuntime] of [
  ["the runtime", true],
  ["a queued node", false],
] as const) {
  test(`a pull that settles an expired execution of ${name} inline writes one lost end after its commit`, async (t) => {
    const h = harness(t);
    const expired = executionFixture({
      node_id: h.row.node_id,
      runtime_identity: sameRuntime
        ? h.row.runtime_identity
        : createIdentity("worker_registration"),
      created_at: Date.now() - TWO_CHECKS,
      expired_at: Date.now() - ONE_COMMIT,
    });
    h.store.transaction((tx) => insertExecution(tx, expired));
    if (!sameRuntime) h.enqueue();
    const result = await h.pull();
    assert.equal(result.kind, WorkPullKind.NoWork);
    const ended = h.store.transaction((tx) =>
      readExecution(tx, expired.execution_id),
    )?.ended_at;
    assert.ok(ended);
    assert.deepEqual(h.telemetry, [
      {
        method: "executionEnded",
        arguments: [
          {
            trace: executionTrace(expired),
            ended_at: ended,
            end: ExecutionEnd.Lost,
            revoke_cause: null,
            stop: null,
          },
        ],
      },
      {
        method: "executionTransition",
        arguments: [
          executionTrace(expired),
          { ...transitionFixture(), transitioned_at: ended },
        ],
      },
    ]);
    h.service.sweep();
    assert.equal(h.telemetry.length, END_AND_TRANSITION);
  });
}

test("pull rolls back its probe, rechecks health, and commits exactly one claim", async (t) => {
  const h = harness(t);
  h.enqueue();
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.equal(
    h.calls.filter((call) => call.method === HEALTHCHECK).length,
    TWO_CHECKS,
  );
  assert.equal(
    Number(
      h.store.database.prepare("SELECT count(*) AS count FROM attempts").get()!
        .count,
    ),
    FIRST_ATTEMPT,
  );
  assert.equal(
    Number(
      h.store.database
        .prepare("SELECT count(*) AS count FROM scheduler_execution")
        .get()!.count,
    ),
    FIRST_ATTEMPT,
  );
  const repeat = await h.pull();
  assert.deepEqual(repeat, result);
  assert.equal(
    h.calls.filter((call) => call.method === HEALTHCHECK).length,
    TWO_CHECKS,
  );
});

const SELECTION: AgentSelection = {
  agent_name: "swe@1",
  position: 1,
  level: ChainLevel.Binding,
  agent_provider: "qwen",
  provider: "openai-compatible",
  credential: "qwen-key",
  model_identifier: "qwen3.6-plus",
  reasoning_effort: "high",
};

const PIN: AgentPin = {
  agent_name: SELECTION.agent_name,
  enablement_id: createIdentity("agent_enablement"),
  position: SELECTION.position,
};

function selectionHarness(t: TestContext) {
  const h = harness(t);
  const reported: {
    selections: readonly AgentSelection[];
    executionId: string;
    stored: boolean;
  }[] = [];
  h.dependencies.agentChains.select = () => ({
    kind: AgentChoiceKind.Selected,
    selections: [SELECTION],
    pins: [PIN],
  });
  h.dependencies.agentChains.resolve = () => [SELECTION];
  h.dependencies.agentChains.selected = (selections, executionId) => {
    reported.push({
      selections,
      executionId,
      stored:
        h.store.transaction((tx) => readExecution(tx, executionId)) !==
        undefined,
    });
  };
  return { ...h, reported };
}

test("a claim reports its selections to the agent chain once, after the commit, with the execution id", async (t) => {
  const h = selectionHarness(t);
  h.enqueue();
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.deepEqual(h.reported, [
    {
      selections: [SELECTION],
      executionId: result.execution.execution_id,
      stored: true,
    },
  ]);
});

test("a pull without work reports no selection", async (t) => {
  const h = selectionHarness(t);
  await h.service.quiesce();
  h.enqueue();
  assert.deepEqual(await h.pull(), { kind: WorkPullKind.NoWork });
  assert.deepEqual(h.reported, []);
});

test("a re-pull that answers the running execution reports no selection", async (t) => {
  const h = selectionHarness(t);
  h.enqueue();
  const claim = await h.pull();
  assert.equal(claim.kind, WorkPullKind.Claimed);
  assert.deepEqual(await h.pull(), claim);
  assert.equal(h.reported.length, ONE_REPORT);
});

const HEALTHCHECK = "registrationHealthcheck";
const MARKER_BRANCH = "kanthord/marker";

test("the work pull answer derives node_branch from the Mission branches", async (t) => {
  const h = harness(t);
  const requests: { node_id: string; attempt: number }[][] = [];
  h.dependencies.branches = {
    nodeBranchesOf: (_tx, keys) => {
      requests.push([...keys]);
      return keys.map(() => MARKER_BRANCH);
    },
  };
  h.enqueue();
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(result.execution.node_branch, MARKER_BRANCH);
  assert.deepEqual(requests, [
    [{ node_id: h.row.node_id, attempt: FIRST_ATTEMPT }],
  ]);
});

test("project wake serves parked pulls in arrival order and another project does not", async (t) => {
  const h = harness(t);
  const first = h.pull();
  assert.equal(h.service.pulling(h.row.runtime_identity), true);
  const otherRuntime = createIdentity("worker_registration");
  const otherIdentity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "other",
      projectId: h.identity.projectId,
      resourceIdentity: h.identity.resourceIdentity,
      issuedAt: Date.now(),
    },
    "other",
    otherRuntime,
  );
  const context = new CancellationContext();
  const second = h.invoke(
    "workPull",
    { ...h.input, body: { ...h.input.body, runtime_identity: otherRuntime } },
    { ...h.caller, identity: otherIdentity, context },
  );
  const secondRejected = assert.rejects(second, { code: CANCELLED });
  h.service.wake(createIdentity("project"));
  await turn();
  assert.equal(h.commits(), NO_COMMITS);
  h.enqueue();
  h.service.wake(h.row.project_id);
  const result = await first;
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.equal(h.service.pulling(otherRuntime), true);
  context.cancel();
  await secondRejected;
  assert.equal(h.commits(), ONE_COMMIT);
});

test("concurrent empty pulls of one runtime retain one waiter and each duplicate commits once", async (t) => {
  const h = harness(t);
  const context = new CancellationContext();
  const first = h.pull(context);
  const cancelled = assert.rejects(first, { code: CANCELLED });
  assert.equal(h.service.pulling(h.row.runtime_identity), true);
  const duplicates = await Promise.all([h.pull(), h.pull(), h.pull()]);
  assert.deepEqual(
    duplicates,
    Array.from({ length: THREE_COMMITS }, () => ({
      kind: WorkPullKind.NoWork,
    })),
  );
  assert.equal(h.commits(), THREE_COMMITS);
  assert.equal(h.service.pulling(h.row.runtime_identity), true);
  context.cancel();
  await cancelled;
  assert.equal(h.commits(), THREE_COMMITS);
  assert.equal(h.service.pulling(h.row.runtime_identity), false);
  h.enqueue();
  const claim = await h.pull();
  assert.equal(claim.kind, WorkPullKind.Claimed);
});

test("woken health failure and quiescence answer no-work once without claims", async (t) => {
  const h = harness(t);
  const waiting = h.pull();
  h.dependencies.registrations.registrationHealthcheck = () => false;
  h.service.wake(h.row.project_id);
  assert.deepEqual(await waiting, { kind: WorkPullKind.NoWork });
  assert.equal(h.commits(), ONE_COMMIT);
  const stopped = harness(t);
  const parked = stopped.pull();
  await stopped.service.quiesce();
  assert.deepEqual(await parked, { kind: WorkPullKind.NoWork });
  stopped.enqueue();
  assert.deepEqual(await stopped.pull(), { kind: WorkPullKind.NoWork });
  assert.deepEqual(
    stopped.store.database.prepare("SELECT * FROM scheduler_execution").all(),
    [],
  );
});

test("window expiry commits no-work and cancellation commits nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let monotonic = 0;
  t.mock.method(performance, "now", () => monotonic);
  const h = harness(t);
  const waiting = h.pull();
  monotonic = WORK_PULL_WAIT_MS;
  t.mock.timers.tick(WORK_PULL_WAIT_MS);
  assert.deepEqual(await waiting, { kind: WorkPullKind.NoWork });
  assert.equal(h.commits(), ONE_COMMIT);
  const cancelled = harness(t);
  const context = new CancellationContext();
  const pending = cancelled.pull(context);
  context.cancel();
  await assert.rejects(pending, { code: CANCELLED });
  assert.equal(cancelled.commits(), NO_COMMITS);
});

test("a pull of a worker with no declaration answers no-work and claims nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let monotonic = 0;
  t.mock.method(performance, "now", () => monotonic);
  const h = harness(t);
  h.dependencies.declarations.declarationOf = () => null;
  let claims = 0;
  h.dependencies.transitions.claim = () => {
    claims++;
    return assert.fail("A pull without a declaration claims no node.");
  };
  h.enqueue();
  const waiting = h.pull();
  monotonic = WORK_PULL_WAIT_MS;
  t.mock.timers.tick(WORK_PULL_WAIT_MS);
  assert.deepEqual(await waiting, { kind: WorkPullKind.NoWork });
  assert.equal(claims, NO_CLAIMS);
  assert.deepEqual(
    h.store.database.prepare("SELECT * FROM scheduler_execution").all(),
    [],
  );
});

test("mismatches and unexpected probe errors propagate without a commit", async (t) => {
  const h = harness(t);
  for (const body of [
    {
      ...h.input.body,
      runtime_identity: createIdentity("worker_registration"),
    },
    { ...h.input.body, resource_identity: "another-binding" },
  ])
    await assert.rejects(h.invoke("workPull", { ...h.input, body }, h.caller), {
      code: CLAIMANT_MISMATCH,
    });
  const failure = new Error("health probe failed");
  h.dependencies.registrations.registrationHealthcheck = () => {
    throw failure;
  };
  await assert.rejects(h.pull(), failure);
  assert.equal(h.commits(), NO_COMMITS);
});

test("loss probes commit settlement at once and claim the node after the stop backoff", async (t) => {
  const h = harness(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const expired = { ...h.row, created_at: now - 1000, expired_at: now };
  h.store.transaction((tx) => insertExecution(tx, expired));
  h.dependencies.transitions.failure = (tx, nodeId) => {
    h.service.insert(tx, nodeId, h.row.project_id, 0);
    return transitionFixture();
  };
  const settledAt = now;
  assert.equal((await h.pull()).kind, WorkPullKind.NoWork);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.equal(
    h.store.transaction((tx) => readExecution(tx, expired.execution_id))!
      .ended_at,
    settledAt,
  );
  now = settledAt + DEFAULT_STOP_BACKOFF_SECONDS * 1000;
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  if (result.kind === WorkPullKind.Claimed)
    assert.notEqual(result.execution.execution_id, expired.execution_id);
});

test("the deciding probe and commit share one clock reading", async (t) => {
  const h = harness(t);
  let now = h.row.expired_at - 1;
  t.mock.method(Date, "now", () => now);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  const original = h.caller.commit;
  h.caller.commit = (write) => {
    now = h.row.expired_at;
    return original(write);
  };
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.deepEqual(
    h.calls.filter((call) => call.method === HEALTHCHECK),
    [],
  );
});

test("a pull that waits under a project pause claims after the resume inside its window", async (t) => {
  const h = harness(t);
  let paused = true;
  h.dependencies.projects.projectPaused = () => paused;
  h.enqueue();
  const waiting = h.pull();
  assert.equal(h.service.pulling(h.row.runtime_identity), true);
  h.service.wake(h.row.project_id);
  await turn();
  assert.equal(h.commits(), NO_COMMITS);
  assert.equal(h.service.pulling(h.row.runtime_identity), true);
  paused = false;
  h.service.wake(h.row.project_id);
  const result = await waiting;
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
});

test("a pull under a project pause answers no work at the end of its window and claims nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let monotonic = 0;
  t.mock.method(performance, "now", () => monotonic);
  const h = harness(t);
  h.dependencies.projects.projectPaused = () => true;
  h.enqueue();
  const waiting = h.pull();
  monotonic = WORK_PULL_WAIT_MS;
  t.mock.timers.tick(WORK_PULL_WAIT_MS);
  assert.deepEqual(await waiting, { kind: WorkPullKind.NoWork });
  assert.equal(h.commits(), ONE_COMMIT);
  assert.deepEqual(
    h.store.database.prepare("SELECT * FROM scheduler_execution").all(),
    [],
  );
  assert.equal(
    Number(
      h.store.database
        .prepare("SELECT count(*) AS count FROM scheduler_job")
        .get()!.count,
    ),
    ONE_COMMIT,
  );
});

test("a waiting pull claims a held job when its stop backoff ends inside the window", async (t) => {
  const h = harness(t);
  const heldMs = 50;
  h.enqueue();
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE scheduler_job SET available_at = ? WHERE node_id = ?")
      .run(Date.now() + heldMs, h.row.node_id),
  );
  const started = performance.now();
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.ok(performance.now() - started < 10 * heldMs);
});

function instanceHarness(t: TestContext, siblingListed = true) {
  const h = harness(t);
  const projectOf = new Map<string, string>();
  h.dependencies.transitions.claim = (tx, nodeId) => {
    h.service.delete(tx, nodeId);
    return {
      kind: "steps",
      project_id: projectOf.get(nodeId)!,
      attempt: FIRST_ATTEMPT,
      node_revision: FIRST_ATTEMPT,
    };
  };
  const bindingOf = (runtime: string, projectId: string) => {
    const identity = testMachineIdentity(
      {
        clientId: createIdentity("client_identity"),
        name: "worker",
        projectId,
        resourceIdentity: h.row.resource_identity,
        issuedAt: Date.now(),
      },
      "pull",
      runtime,
    );
    const enqueue = (count: number) =>
      h.store.transaction((tx) => {
        for (let index = 0; index < count; index++) {
          const nodeId = createIdentity("node");
          projectOf.set(nodeId, projectId);
          h.service.insert(tx, nodeId, projectId, 0);
        }
      });
    const pull = (
      context: CancellationContext | typeof background = background,
    ) =>
      h.invoke(
        "workPull",
        {
          ...h.input,
          body: { ...h.input.body, runtime_identity: runtime },
        },
        { ...h.caller, identity, context },
      );
    const release = (executionId: string) =>
      h.invoke(
        "executionRelease",
        {
          params: { execution_id: executionId },
          query: {},
          body: { further_work: false },
        },
        {
          ...h.caller,
          identity,
          execution: {
            executionId,
            projectId,
            nodeId: createIdentity("node"),
            attempt: FIRST_ATTEMPT,
            pinnedRevision: FIRST_ATTEMPT,
            nodeBranch: "kanthord/node",
            runtimeIdentity: runtime,
            workerBindingId: h.row.worker_binding_id,
          },
        },
      );
    return { runtime, projectId, enqueue, pull, release };
  };
  const first = bindingOf(h.row.runtime_identity, h.row.project_id);
  const second = bindingOf(
    createIdentity("worker_registration"),
    createIdentity("project"),
  );
  const siblings: Record<string, string[]> = siblingListed
    ? {
        [first.runtime]: [second.runtime],
        [second.runtime]: [first.runtime],
      }
    : {};
  h.dependencies.registrations.registrationsOfInstance = (_tx, runtime) =>
    siblings[runtime] ?? [];
  return { ...h, first, second };
}

function claimantOf(result: {
  kind: string;
  execution?: { claimant: { runtime_identity: string } };
}) {
  assert.equal(result.kind, WorkPullKind.Claimed);
  return result.execution!.claimant.runtime_identity;
}

test("two bindings on one instance alternate their claims when the releaser pulls first", async (t) => {
  const h = instanceHarness(t);
  const { first, second } = h;
  first.enqueue(THREE_COMMITS);
  second.enqueue(THREE_COMMITS);
  const claimants: string[] = [];
  let running = await first.pull();
  claimants.push(claimantOf(running));
  for (let round = 0; round < THREE_COMMITS; round++) {
    const [ended, next] =
      claimants.at(-1) === first.runtime ? [first, second] : [second, first];
    assert.equal(running.kind, WorkPullKind.Claimed);
    await ended.release(running.execution.execution_id);
    const context = new CancellationContext();
    const refused = ended.pull(context);
    const cancelled = assert.rejects(refused, { code: CANCELLED });
    await turn();
    assert.equal(h.service.pulling(ended.runtime), true);
    running = await next.pull();
    claimants.push(claimantOf(running));
    context.cancel();
    await cancelled;
  }
  assert.deepEqual(claimants, [
    first.runtime,
    second.runtime,
    first.runtime,
    second.runtime,
  ]);
});

test("a parked pull of a sibling takes the slot when the execution of its instance ends", async (t) => {
  const h = instanceHarness(t);
  const { first, second } = h;
  first.enqueue(TWO_CHECKS);
  second.enqueue(ONE_COMMIT);
  const running = await first.pull();
  assert.equal(claimantOf(running), first.runtime);
  const parked = second.pull();
  await turn();
  assert.equal(h.service.pulling(second.runtime), true);
  assert.equal(running.kind, WorkPullKind.Claimed);
  await first.release(running.execution.execution_id);
  assert.equal(claimantOf(await parked), second.runtime);
  const context = new CancellationContext();
  const refused = first.pull(context);
  const cancelled = assert.rejects(refused, { code: CANCELLED });
  await turn();
  assert.equal(h.service.pulling(first.runtime), true);
  context.cancel();
  await cancelled;
});

test("a sibling turn that finds no work passes the slot to the parked pull at once", async (t) => {
  const h = instanceHarness(t);
  const { first, second } = h;
  first.enqueue(TWO_CHECKS);
  const running = await first.pull();
  assert.equal(running.kind, WorkPullKind.Claimed);
  await first.release(running.execution.execution_id);
  const waiting = first.pull();
  await turn();
  assert.equal(h.service.pulling(first.runtime), true);
  const context = new CancellationContext();
  const idle = second.pull(context);
  const cancelled = assert.rejects(idle, { code: CANCELLED });
  assert.equal(claimantOf(await waiting), first.runtime);
  context.cancel();
  await cancelled;
});

test("one binding keeps its speed when no other binding of its instance waits", async (t) => {
  const h = instanceHarness(t, false);
  const { first } = h;
  first.enqueue(THREE_COMMITS);
  for (let round = 0; round < THREE_COMMITS; round++) {
    const commits = h.commits();
    const result = await first.pull();
    assert.equal(claimantOf(result), first.runtime);
    assert.equal(h.commits(), commits + ONE_COMMIT);
    assert.equal(h.service.pulling(first.runtime), false);
    assert.equal(result.kind, WorkPullKind.Claimed);
    await first.release(result.execution.execution_id);
  }
});

test("one binding keeps its claims when its sibling pulls with no work", async (t) => {
  const h = instanceHarness(t);
  const { first, second } = h;
  first.enqueue(THREE_COMMITS);
  let running = await first.pull();
  for (let round = 0; round < THREE_COMMITS - 1; round++) {
    assert.equal(running.kind, WorkPullKind.Claimed);
    await first.release(running.execution.execution_id);
    const waiting = first.pull();
    await turn();
    const context = new CancellationContext();
    const idle = assert.rejects(second.pull(context), { code: CANCELLED });
    running = await waiting;
    assert.equal(claimantOf(running), first.runtime);
    assert.equal(h.service.pulling(first.runtime), false);
    context.cancel();
    await idle;
  }
});

test("the instance guard still allows one execution per instance", async (t) => {
  const h = instanceHarness(t);
  const { first, second } = h;
  first.enqueue(ONE_COMMIT);
  second.enqueue(ONE_COMMIT);
  assert.equal(claimantOf(await first.pull()), first.runtime);
  const context = new CancellationContext();
  const refused = second.pull(context);
  const cancelled = assert.rejects(refused, { code: CANCELLED });
  h.service.wake(second.projectId);
  await turn();
  assert.equal(h.service.pulling(second.runtime), true);
  context.cancel();
  await cancelled;
  assert.equal(
    Number(
      h.store.database
        .prepare(
          "SELECT count(*) AS count FROM scheduler_execution WHERE ended_at IS NULL",
        )
        .get()!.count,
    ),
    ONE_COMMIT,
  );
});

const QUEUED_AT = 1700000000000;
const WAITED_MS = 4200;
const CLAIMED_AT = QUEUED_AT + WAITED_MS;
const ONE_ROOT_START = 1;

const OPENED = "executionOpened";

function setQueuedAt(h: ReturnType<typeof harness>, queuedAt: number) {
  h.store.database
    .prepare("UPDATE scheduler_job SET queued_at = ? WHERE node_id = ?")
    .run(queuedAt, h.row.node_id);
}

test("a pull that claims an Available node opens the execution with steps, the worker name and the queue wait", async (t) => {
  const h = harness(t);
  h.enqueue();
  setQueuedAt(h, QUEUED_AT);
  t.mock.method(Date, "now", () => CLAIMED_AT);
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  const opened = h.telemetry.filter((call) => call.method === OPENED);
  assert.equal(opened.length, ONE_ROOT_START);
  assert.equal(opened[0]!.arguments[1], result.execution!.created_at);
  assert.deepEqual(opened[0]!.arguments[2], {
    kind: "steps",
    worker_name: "coder@1",
    queue_wait_ms: WAITED_MS,
  });
});

test("a repeat pull that answers the existing claim writes no second root start", async (t) => {
  const h = harness(t);
  h.enqueue();
  setQueuedAt(h, QUEUED_AT);
  t.mock.method(Date, "now", () => CLAIMED_AT);
  const first = await h.pull();
  const repeat = await h.pull();
  assert.deepEqual(repeat, first);
  assert.equal(
    h.telemetry.filter((call) => call.method === OPENED).length,
    ONE_ROOT_START,
  );
});
