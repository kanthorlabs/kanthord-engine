import { ExecutionKind } from "../tracking/contract.ts";
import assert from "node:assert/strict";
import {
  setTimeout as sleep,
  setImmediate as turn,
} from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { AgentChoiceKind, ClaimIntent, ClaimNodeState } from "./contract.ts";
import { claimOnce, ClaimOutcome, instanceKeyOf } from "./claim.ts";
import { InstanceQueue } from "./instance-queue.ts";
import {
  endExecution,
  insertExecution,
  readExecution,
} from "./execution-store.ts";
import {
  executionFixture,
  FIRST_LOSS_WITHOUT_JOB,
  FIXTURE_DEADLINE,
  FIXTURE_NOW,
  schedulerHarness,
  transitionFixture,
} from "./test-support.ts";
import { DEFAULT_STOP_BACKOFF_SECONDS } from "./config.ts";
import { executionTrace, reportLost } from "./telemetry.ts";
import {
  attributed,
  CauseCategory,
  CauseSubcategory,
} from "../kernel/cause.ts";
import {
  Onboarding,
  type OnboardingDependencies,
} from "../project/onboarding.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const WALL_TIME = 7200000;
const RESERVE_MS = 600000;
const PIN = 3;
const ONE_CALL = 1;
const NO_CALLS = 0;
const PLACEMENT = "container";
const DEPENDENCIES = 3;
const NODE_NAME = "Write the report";
const CLAIM_METHOD = "claim";
const FIRST_JOB = 0;
const DEFAULT_INSTANCE_KEY = "general/worker";
const HARNESS_INSTANCE_KEY = "coder/harness-1";
const INSTANCE_NAME = "coder-1";
const QUEUE_TICK_MS = 2;
const BACKOFF_MS = DEFAULT_STOP_BACKOFF_SECONDS * 1000;

export function claimHarness(
  t: TestContext,
  states: readonly string[] = [ClaimNodeState.Available],
) {
  const row = executionFixture();
  const h = schedulerHarness(t);
  const woken: string[][] = [];
  const dependencies = {
    ...h.dependencies,
    instances: new InstanceQueue((runtimes) => woken.push(runtimes)),
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      issuedAt: FIXTURE_NOW,
    },
    "claim",
    row.runtime_identity,
  );
  const pull = {
    resource_identity: row.resource_identity,
    runtime_identity: row.runtime_identity,
  };
  const binding = {
    binding_id: row.worker_binding_id,
    worker_name: "coder@1",
    instance_count: 1,
    tags: [] as string[],
    environment: null as string | null,
    tombstone: false,
    resource_budget: null as { wall_time_ms: number } | null,
  };
  h.dependencies.bindings.workerBindingOf = () => binding;
  h.dependencies.declarations.declarationOf = () => ({
    declared_node_states: states,
    declared_intents: Object.values(ClaimIntent),
    resource_budget: { wall_time_ms: WALL_TIME },
  });
  h.dependencies.transitions.claim = (
    tx,
    nodeId,
    declaredStates,
    opener,
    now,
  ) => {
    h.calls.push({
      method: "claim",
      arguments: [nodeId, declaredStates, opener, now],
    });
    h.service.delete(tx, nodeId);
    return {
      kind: ExecutionKind.Steps,
      project_id: row.project_id,
      attempt: 1,
      node_revision: PIN,
    };
  };
  const claim = (now = FIXTURE_NOW) =>
    h.store.transaction((tx) =>
      claimOnce(tx, dependencies, identity, pull, now),
    );
  return { ...h, dependencies, woken, row, identity, pull, binding, claim };
}

test("claim pins binding, attempt, revision, trace and the fixed effective deadline", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  const first = h.claim();
  assert.equal(first.outcome, ClaimOutcome.Claimed);
  assert.equal(first.row!.expired_at, FIXTURE_NOW + WALL_TIME + RESERVE_MS);
  assert.equal(first.row!.pinned_revision, PIN);
  assert.equal(Object.hasOwn(first.row!, "node_branch"), false);
  assert.equal(
    Object.hasOwn(
      h.store.transaction((tx) => readExecution(tx, first.row!.execution_id))!,
      "node_branch",
    ),
    false,
  );
  assert.equal(first.row!.worker_binding_id, h.binding.binding_id);
  assert.deepEqual(first.row!.credentials, []);
  assert.equal(Object.hasOwn(first.row!, "kind"), false);
  h.binding.resource_budget = { wall_time_ms: 1 };
  h.dependencies.config.release_reserve = 1;
  const repeat = h.claim();
  assert.equal(repeat.outcome, ClaimOutcome.Running);
  assert.deepEqual(repeat.row, first.row);
  assert.equal(
    h.calls.filter((call) => call.method === CLAIM_METHOD).length,
    ONE_CALL,
  );
  h.store.transaction((tx) => h.service.revoke(tx, h.row.node_id, FIXTURE_NOW));
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  assert.equal(h.claim().row!.expired_at, FIXTURE_NOW + 1001);
});

test("selection preserves priority and age while skipping a stale job", (t) => {
  const h = claimHarness(t, [
    ClaimNodeState.Waiting,
    ClaimNodeState.ExternalRequested,
  ]);
  const nodes = [
    createIdentity("node"),
    createIdentity("node"),
    createIdentity("node"),
  ];
  const jobs = [
    "job_00000000000000000000000001",
    "job_00000000000000000000000002",
    "job_00000000000000000000000003",
  ];
  h.store.transaction((tx) => {
    for (let i = 0; i < nodes.length; i++)
      tx.database
        .prepare(
          "INSERT INTO scheduler_job (id, project_id, node_id, priority, queued_at) VALUES (?, ?, ?, ?, 0)",
        )
        .run(jobs[i]!, h.row.project_id, nodes[i]!, i === FIRST_JOB ? 0 : 1);
  });
  const visited: string[] = [];
  h.dependencies.transitions.claim = (tx, nodeId, states) => {
    visited.push(nodeId);
    assert.deepEqual(states, [
      ClaimNodeState.Waiting,
      ClaimNodeState.ExternalRequested,
    ]);
    if (nodeId === nodes[1]) return null;
    h.service.delete(tx, nodeId);
    return {
      kind: "evaluation",
      project_id: h.row.project_id,
      attempt: 1,
      node_revision: PIN,
    };
  };
  assert.equal(h.claim().row!.node_id, nodes[2]);
  assert.deepEqual(visited, [nodes[1], nodes[2]]);
});

test("a node that returns to the queue keeps the queue place of its first job", async (t) => {
  const h = claimHarness(t);
  const newer = createIdentity("node");
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  await sleep(QUEUE_TICK_MS);
  h.store.transaction((tx) => h.service.insert(tx, newer, h.row.project_id, 0));
  assert.equal(h.claim().row!.node_id, h.row.node_id);
  h.store.transaction((tx) => h.service.revoke(tx, h.row.node_id, FIXTURE_NOW));
  await sleep(QUEUE_TICK_MS);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  assert.equal(h.claim().row!.node_id, h.row.node_id);
});

test("health, tombstones, zero counts and occupied binding counts refuse admission", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  h.dependencies.registrations.registrationHealthcheck = () => false;
  assert.equal(h.claim().outcome, ClaimOutcome.Refused);
  h.dependencies.registrations.registrationHealthcheck = () => true;
  h.binding.tombstone = true;
  assert.equal(h.claim().outcome, ClaimOutcome.None);
  h.binding.tombstone = false;
  h.binding.instance_count = 0;
  assert.equal(h.claim().outcome, ClaimOutcome.None);
  h.binding.instance_count = 1;
  h.store.transaction((tx) =>
    insertExecution(tx, executionFixture({ project_id: h.row.project_id })),
  );
  assert.equal(h.claim().outcome, ClaimOutcome.None);
  assert.deepEqual(
    h.calls.filter((call) => call.method === CLAIM_METHOD),
    [],
  );
});

test("the claim walk skips a job that the claimant does not admit and claims the next admitted job", (t) => {
  const h = claimHarness(t);
  const macos = createIdentity("node");
  const examine = createIdentity("node");
  const plain = createIdentity("node");
  h.store.transaction((tx) => {
    h.service.insert(tx, macos, h.row.project_id, 3);
    h.service.insert(tx, examine, h.row.project_id, 2);
    h.service.insert(tx, plain, h.row.project_id, 1);
  });
  const facts = new Map([
    [
      macos,
      {
        intent: ClaimIntent.Implement,
        tags: ["platform.macos"],
        repositories: [],
      },
    ],
    [examine, { intent: ClaimIntent.Examine, tags: [], repositories: [] }],
    [plain, { intent: ClaimIntent.Implement, tags: [], repositories: [] }],
  ]);
  const read: string[] = [];
  h.dependencies.facts.claimFacts = (_tx, nodeId) => {
    read.push(nodeId);
    return facts.get(nodeId) ?? null;
  };
  h.dependencies.declarations.declarationOf = () => ({
    declared_node_states: [ClaimNodeState.Available],
    declared_intents: [ClaimIntent.Implement],
    resource_budget: { wall_time_ms: WALL_TIME },
  });
  const first = h.claim();
  assert.equal(first.row!.node_id, plain);
  assert.deepEqual(read, [macos, examine, plain]);
  assert.deepEqual(
    h.calls
      .filter((call) => call.method === CLAIM_METHOD)
      .map((call) => call.arguments[0]),
    [plain],
  );
  h.store.transaction((tx) => h.service.revoke(tx, plain, FIXTURE_NOW));
  h.binding.tags = ["platform.macos"];
  assert.equal(h.claim().row!.node_id, macos);
});

test("the claim walk of a container slot skips a job of another repository and claims the next job of its repository", (t) => {
  const h = claimHarness(t);
  const api = "repository:github:acme/api";
  const web = "repository:github:acme/web";
  const webNode = createIdentity("node");
  const apiNode = createIdentity("node");
  h.store.transaction((tx) => {
    h.service.insert(tx, webNode, h.row.project_id, 2);
    h.service.insert(tx, apiNode, h.row.project_id, 1);
  });
  const facts = new Map([
    [webNode, { intent: ClaimIntent.Implement, tags: [], repositories: [web] }],
    [apiNode, { intent: ClaimIntent.Implement, tags: [], repositories: [api] }],
  ]);
  h.dependencies.facts.claimFacts = (_tx, nodeId) => facts.get(nodeId) ?? null;
  h.binding.environment = api;
  const result = h.claim();
  assert.equal(result.row!.node_id, apiNode);
  assert.deepEqual(
    h.calls
      .filter((call) => call.method === CLAIM_METHOD)
      .map((call) => call.arguments[0]),
    [apiNode],
  );
});

test("a worker name with no declaration answers no work and asserts nothing", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  h.dependencies.declarations.declarationOf = () => null;
  const result = h.claim();
  assert.equal(result.outcome, ClaimOutcome.None);
  assert.equal(result.row, null);
  assert.deepEqual(
    h.calls.filter((call) => call.method === CLAIM_METHOD),
    [],
  );
});

test("a claim walk answers each execution that it settles with its trace", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  const runtime = h.claim(FIXTURE_DEADLINE);
  assert.deepEqual(runtime.lost, [
    {
      execution_id: h.row.execution_id,
      trace: executionTrace(h.row),
      ended_at: FIXTURE_DEADLINE,
      transition: transitionFixture(),
      hold: FIRST_LOSS_WITHOUT_JOB,
    },
  ]);
  const other = executionFixture({
    project_id: h.row.project_id,
    node_id: createIdentity("node"),
    runtime_identity: createIdentity("worker_registration"),
  });
  h.store.transaction((tx) => {
    insertExecution(tx, other);
    h.service.insert(tx, other.node_id, other.project_id, 0);
  });
  const node = h.claim(FIXTURE_DEADLINE);
  assert.deepEqual(
    node.lost.map((ended) => ended.execution_id),
    [other.execution_id],
  );
  assert.equal(node.settled, true);
  assert.deepEqual(h.claim(FIXTURE_DEADLINE).lost, []);
});

test("an inline loss of a claim walk writes one transition span after its commit", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  const result = h.claim(FIXTURE_DEADLINE);
  assert.equal(h.telemetry.length, NO_CALLS);
  reportLost(h.dependencies.telemetry, result.lost);
  assert.deepEqual(
    h.telemetry.map((entry) => entry.method),
    ["executionEnded", "executionTransition"],
  );
  assert.deepEqual(h.telemetry[1]!.arguments, [
    executionTrace(h.row),
    {
      from: "Executing",
      to: "Available",
      rule: "none",
      count: null,
      limit: null,
      lead_time_ms: null,
      ...FIRST_LOSS_WITHOUT_JOB,
      transitioned_at: FIXTURE_DEADLINE,
    },
  ]);
  assert.deepEqual(
    (h.telemetry[0]!.arguments[0] as { cause: unknown }).cause,
    attributed(CauseCategory.Infrastructure, CauseSubcategory.ExecutionLost),
  );
});

test("runtime and node expiry settle before admission; rollback undoes all claim writes", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  h.dependencies.transitions.failure = (tx, nodeId, count, now) => {
    assert.equal(count, ONE_CALL);
    assert.equal(now, FIXTURE_DEADLINE);
    h.service.insert(tx, nodeId, h.row.project_id, 0);
    return transitionFixture();
  };
  const held = h.claim(FIXTURE_DEADLINE);
  assert.equal(held.settled, true);
  assert.equal(held.outcome, ClaimOutcome.None);
  const next = h.claim(FIXTURE_DEADLINE + BACKOFF_MS);
  assert.equal(next.outcome, ClaimOutcome.Claimed);
  assert.notEqual(next.row!.execution_id, h.row.execution_id);
  assert.equal(
    h.store.transaction((tx) => readExecution(tx, h.row.execution_id))
      ?.ended_at,
    FIXTURE_DEADLINE,
  );
  const fresh = claimHarness(t);
  const expired = executionFixture({
    project_id: fresh.row.project_id,
    node_id: fresh.row.node_id,
  });
  fresh.store.transaction((tx) => {
    insertExecution(tx, expired);
    fresh.service.insert(tx, expired.node_id, expired.project_id, 0);
  });
  const failure = new Error("probe rollback");
  assert.throws(
    () =>
      fresh.store.transaction((tx) => {
        const result = claimOnce(
          tx,
          fresh.dependencies,
          fresh.identity,
          fresh.pull,
          FIXTURE_DEADLINE,
        );
        assert.equal(result.settled, true);
        assert.equal(result.outcome, ClaimOutcome.None);
        throw failure;
      }),
    failure,
  );
  assert.deepEqual(
    fresh.store.transaction((tx) => readExecution(tx, expired.execution_id)),
    expired,
  );
  assert.equal(fresh.claim(FIXTURE_DEADLINE).outcome, ClaimOutcome.None);
  assert.equal(
    fresh.claim(FIXTURE_DEADLINE + BACKOFF_MS).outcome,
    ClaimOutcome.Claimed,
  );
});

const NO_CLAIMS = 0;
const pinnedSelection = {
  agent_name: "swe@1",
  position: 1,
  level: "enablement" as const,
  agent_provider: "qwen",
  provider: "openai-compatible",
  credential: "qwen-key",
  model_identifier: "qwen3.6-plus",
  reasoning_effort: "high",
};
const pin = {
  agent_name: "swe@1",
  enablement_id: createIdentity("agent_enablement"),
  position: 1,
};

test("the claim pins the chain positions and answers no work when a chain cools down", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  h.dependencies.agentChains.select = () => ({
    kind: AgentChoiceKind.Cooling,
    available_at: FIXTURE_NOW + 1,
  });
  const cooling = h.claim();
  assert.equal(cooling.outcome, ClaimOutcome.None);
  assert.equal(
    h.calls.filter((call) => call.method === CLAIM_METHOD).length,
    NO_CLAIMS,
  );
  h.dependencies.agentChains.select = (_tx, workerBindingId) => {
    assert.equal(workerBindingId, h.binding.binding_id);
    return {
      kind: AgentChoiceKind.Selected,
      selections: [pinnedSelection],
      pins: [pin],
    };
  };
  const claimed = h.claim();
  assert.equal(claimed.outcome, ClaimOutcome.Claimed);
  assert.deepEqual(claimed.row?.agent_pins, [pin]);
  assert.deepEqual(
    h.store.transaction((tx) => readExecution(tx, claimed.row!.execution_id))
      ?.agent_pins,
    [pin],
  );
});

test("a paused project answers no work before the healthcheck, and keeps the job and the executions", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  const countRows = (table: string) =>
    Number(
      h.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
    );
  let paused = true;
  h.dependencies.projects.projectPaused = (_tx, projectId) => {
    assert.equal(projectId, h.row.project_id);
    return paused;
  };
  h.dependencies.registrations.registrationHealthcheck = () => false;
  const result = h.claim();
  assert.equal(result.outcome, ClaimOutcome.None);
  assert.equal(result.row, null);
  assert.equal(countRows("scheduler_execution"), NO_CLAIMS);
  assert.equal(countRows("scheduler_job"), ONE_CALL);
  assert.deepEqual(
    h.calls.filter((call) => call.method === CLAIM_METHOD),
    [],
  );
  h.dependencies.registrations.registrationHealthcheck = () => true;
  paused = false;
  assert.equal(h.claim().outcome, ClaimOutcome.Claimed);
});

test("a paused project still answers the running execution of the runtime", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  h.dependencies.projects.projectPaused = () => true;
  const result = h.claim();
  assert.equal(result.outcome, ClaimOutcome.Running);
  assert.deepEqual(result.row, h.row);
});

test("a refused healthcheck still answers the running execution of the runtime", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  h.dependencies.registrations.registrationHealthcheck = () => false;
  const result = h.claim();
  assert.equal(result.outcome, ClaimOutcome.Running);
  assert.deepEqual(result.row, h.row);
});

test("selection skips a job until its stop backoff ends", (t) => {
  const h = claimHarness(t);
  const heldAt = FIXTURE_NOW + 1;
  h.store.transaction((tx) => {
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0);
    tx.database
      .prepare("UPDATE scheduler_job SET available_at = ? WHERE node_id = ?")
      .run(heldAt, h.row.node_id);
  });
  assert.equal(h.claim().outcome, ClaimOutcome.None);
  assert.equal(
    h.calls.filter((call) => call.method === CLAIM_METHOD).length,
    NO_CLAIMS,
  );
  assert.equal(h.claim(heldAt).outcome, ClaimOutcome.Claimed);
});

function instanceSibling(h: ReturnType<typeof claimHarness>) {
  const otherRuntime = createIdentity("worker_registration");
  const otherResource = "worker:kanthord:review";
  const otherIdentity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: h.row.project_id,
      resourceIdentity: otherResource,
      issuedAt: FIXTURE_NOW,
    },
    "claim",
    otherRuntime,
  );
  const siblings: Record<string, string[]> = {
    [h.row.runtime_identity]: [otherRuntime],
    [otherRuntime]: [h.row.runtime_identity],
  };
  h.dependencies.registrations.registrationsOfInstance = (_tx, runtime) =>
    siblings[runtime] ?? [];
  const otherNode = createIdentity("node");
  h.store.transaction((tx) => {
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0);
    h.service.insert(tx, otherNode, h.row.project_id, 0);
  });
  return (now: number) =>
    h.store.transaction((tx) =>
      claimOnce(
        tx,
        h.dependencies,
        otherIdentity,
        { resource_identity: otherResource, runtime_identity: otherRuntime },
        now,
      ),
    );
}

test("two pulls of one instance on two bindings commit one claim", (t) => {
  const h = claimHarness(t);
  const claimOther = instanceSibling(h);
  assert.equal(h.claim().outcome, ClaimOutcome.Claimed);
  assert.equal(claimOther(FIXTURE_NOW).outcome, ClaimOutcome.Queued);
  assert.equal(
    h.calls.filter((call) => call.method === CLAIM_METHOD).length,
    ONE_CALL,
  );
});

test("an expired execution of a sibling registration blocks no claim of its instance", (t) => {
  const h = claimHarness(t);
  const claimOther = instanceSibling(h);
  const first = h.claim();
  assert.equal(first.outcome, ClaimOutcome.Claimed);
  assert.equal(
    claimOther(first.row!.expired_at - 1).outcome,
    ClaimOutcome.Queued,
  );
  assert.equal(claimOther(first.row!.expired_at).outcome, ClaimOutcome.Claimed);
});

test("a free instance goes to the sibling that waited longest and a newer pull is queued", (t) => {
  const h = claimHarness(t);
  const claimOther = instanceSibling(h);
  const first = h.claim();
  assert.equal(first.outcome, ClaimOutcome.Claimed);
  assert.equal(claimOther(FIXTURE_NOW).outcome, ClaimOutcome.Queued);
  h.store.transaction((tx) =>
    endExecution(tx, first.row!.execution_id, FIXTURE_NOW, null),
  );
  assert.equal(h.claim().outcome, ClaimOutcome.Queued);
  assert.equal(claimOther(FIXTURE_NOW).outcome, ClaimOutcome.Claimed);
  assert.deepEqual(h.woken, []);
});

test("a sibling turn without a claim passes the slot and wakes the queued pull", (t) => {
  const h = claimHarness(t);
  const claimOther = instanceSibling(h);
  const first = h.claim();
  assert.equal(claimOther(FIXTURE_NOW).outcome, ClaimOutcome.Queued);
  h.store.transaction((tx) =>
    endExecution(tx, first.row!.execution_id, FIXTURE_NOW, null),
  );
  assert.equal(h.claim().outcome, ClaimOutcome.Queued);
  h.dependencies.registrations.registrationHealthcheck = (_tx, runtime) =>
    runtime === h.row.runtime_identity;
  assert.equal(claimOther(FIXTURE_NOW).outcome, ClaimOutcome.Refused);
  assert.deepEqual(h.woken, [[h.row.runtime_identity]]);
  assert.equal(h.claim().outcome, ClaimOutcome.Claimed);
});

test("a pruned registration that is no longer live holds no place in the order", (t) => {
  const h = claimHarness(t);
  const claimOther = instanceSibling(h);
  const first = h.claim();
  assert.equal(claimOther(FIXTURE_NOW).outcome, ClaimOutcome.Queued);
  h.store.transaction((tx) =>
    endExecution(tx, first.row!.execution_id, FIXTURE_NOW, null),
  );
  assert.equal(h.claim().outcome, ClaimOutcome.Queued);
  h.dependencies.instances.prune(
    (runtime) => runtime === h.row.runtime_identity,
  );
  assert.equal(h.claim().outcome, ClaimOutcome.Claimed);
});

function jobRows(h: ReturnType<typeof claimHarness>) {
  return h.store.transaction((tx) =>
    tx.database.prepare("SELECT * FROM scheduler_job ORDER BY node_id").all(),
  );
}

test("the claim walk skips a job of a node whose repositories are not claimable and leaves its rows unchanged", (t) => {
  const h = claimHarness(t);
  const blocked = "repository:github:acme/blocked";
  const open = "repository:github:acme/open";
  const blockedNode = createIdentity("node");
  const openNode = createIdentity("node");
  h.store.transaction((tx) => {
    h.service.insert(tx, blockedNode, h.row.project_id, 2);
    h.service.insert(tx, openNode, h.row.project_id, 1);
  });
  const facts = new Map([
    [
      blockedNode,
      { intent: ClaimIntent.Implement, tags: [], repositories: [blocked] },
    ],
    [
      openNode,
      { intent: ClaimIntent.Implement, tags: [], repositories: [open] },
    ],
  ]);
  h.dependencies.facts.claimFacts = (_tx, nodeId) => facts.get(nodeId) ?? null;
  h.dependencies.environments.environmentsClaimable = (_projectId, ids) =>
    !ids.includes(blocked);
  const blockedBefore = h.store.transaction((tx) =>
    tx.database
      .prepare("SELECT * FROM scheduler_job WHERE node_id = ?")
      .get(blockedNode),
  );
  const result = h.claim();
  assert.equal(result.outcome, ClaimOutcome.Claimed);
  assert.equal(result.row!.node_id, openNode);
  assert.deepEqual(
    h.calls
      .filter((call) => call.method === CLAIM_METHOD)
      .map((call) => call.arguments[0]),
    [openNode],
  );
  const blockedAfter = h.store.transaction((tx) =>
    tx.database
      .prepare("SELECT * FROM scheduler_job WHERE node_id = ?")
      .get(blockedNode),
  );
  assert.deepEqual(blockedAfter, blockedBefore);
  assert.equal(blockedAfter!.available_at, null);
  assert.equal(h.claim().outcome, ClaimOutcome.Running);
  assert.equal(jobRows(h).length, ONE_CALL);
});

test("the claim answers no work while every node has a repository that is not claimable", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  h.dependencies.environments.environmentsClaimable = () => false;
  const result = h.claim();
  assert.equal(result.outcome, ClaimOutcome.None);
  assert.equal(result.row, null);
  assert.equal(jobRows(h).length, ONE_CALL);
  assert.deepEqual(
    h.calls.filter((call) => call.method === CLAIM_METHOD),
    [],
  );
});

test("the environment gate receives the project id and the repositories of the node", (t) => {
  const h = claimHarness(t);
  const api = "repository:github:acme/api";
  const web = "repository:github:acme/web";
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  h.dependencies.facts.claimFacts = () => ({
    intent: ClaimIntent.Implement,
    tags: [],
    repositories: [api, web],
  });
  const asked: { projectId: string; ids: readonly string[] }[] = [];
  h.dependencies.environments.environmentsClaimable = (projectId, ids) => {
    asked.push({ projectId, ids });
    return true;
  };
  assert.equal(h.claim().outcome, ClaimOutcome.Claimed);
  assert.deepEqual(asked, [{ projectId: h.row.project_id, ids: [api, web] }]);
});

test("a node with no repository binding is claimed with an empty identity list", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  const asked: (readonly string[])[] = [];
  h.dependencies.environments.environmentsClaimable = (_projectId, ids) => {
    asked.push(ids);
    return true;
  };
  assert.equal(h.claim().outcome, ClaimOutcome.Claimed);
  assert.deepEqual(asked, [[]]);
});

test("the gate holds for a claimant of a server binding with no environment", (t) => {
  const h = claimHarness(t);
  h.binding.environment = null;
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  h.dependencies.facts.claimFacts = () => ({
    intent: ClaimIntent.Implement,
    tags: [],
    repositories: ["repository:github:acme/api"],
  });
  h.dependencies.environments.environmentsClaimable = () => false;
  assert.equal(h.claim().outcome, ClaimOutcome.None);
  h.dependencies.environments.environmentsClaimable = () => true;
  assert.equal(h.claim().outcome, ClaimOutcome.Claimed);
});

test("a claim whose repository group has no record answers no claim and starts one compute after the transaction commits", async (t) => {
  const h = claimHarness(t);
  const identity = "repository:github:acme/api";
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  h.dependencies.facts.claimFacts = () => ({
    intent: ClaimIntent.Implement,
    tags: [],
    repositories: [identity],
  });
  const failures: unknown[] = [];
  let reads = 0;
  const onboarding = new Onboarding({
    bindingsOf: () => {
      reads++;
      return h.store.transaction(() => ({ repositories: [], workers: [] }));
    },
    logger: { error: (failure: unknown) => failures.push(failure) },
  } as unknown as OnboardingDependencies);
  stopAfter(t, () => onboarding.stop());
  h.dependencies.environments.environmentsClaimable = (projectId, ids) =>
    onboarding.environmentsClaimable(projectId, ids);
  const result = h.claim();
  assert.equal(result.outcome, ClaimOutcome.None);
  assert.equal(result.row, null);
  assert.equal(reads, NO_CALLS);
  await turn();
  assert.equal(reads, ONE_CALL);
  assert.deepEqual(failures, []);
});

const QUEUED_AT = 500;
const WAITED_MS = FIXTURE_NOW - QUEUED_AT;
const REVISION_QUEUED_AT = 900;

function setQueuedAt(h: ReturnType<typeof claimHarness>, queuedAt: number) {
  h.store.database
    .prepare("UPDATE scheduler_job SET queued_at = ? WHERE node_id = ?")
    .run(queuedAt, h.row.node_id);
}

test("a claim of a Waiting node opens the execution with evaluation and the wait of its job", (t) => {
  const h = claimHarness(t, [ClaimNodeState.Waiting]);
  const claimed = h.dependencies.transitions.claim;
  h.dependencies.transitions.claim = (...args) => ({
    ...claimed(...args)!,
    kind: ExecutionKind.Evaluation,
  });
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  setQueuedAt(h, QUEUED_AT);
  const result = h.claim();
  assert.equal(result.outcome, ClaimOutcome.Claimed);
  assert.deepEqual(result.opening, {
    kind: "evaluation",
    worker_name: "coder@1",
    queue_wait_ms: WAITED_MS,
    worker_instance: DEFAULT_INSTANCE_KEY,
    placement: null,
    revision_turn: false,
    dependency_count: 0,
    node_name: "name",
  });
});

test("the opening names the instance of a claimant with an instance", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  const instance = { ...h.identity, instanceId: createIdentity("instance") };
  const result = h.store.transaction((tx) =>
    claimOnce(tx, h.dependencies, instance, h.pull, FIXTURE_NOW),
  );
  assert.equal(result.opening!.worker_instance, instance.name);
});

test("the opening keys a claimant with no instance by binding name and identity name", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  assert.equal(h.claim().opening!.worker_instance, DEFAULT_INSTANCE_KEY);
});

test("the opening of a server and a container instance carries its instance name", (t) => {
  for (const placement of ["server", "container"]) {
    const h = claimHarness(t);
    h.dependencies.registrations.placementOf = () => placement;
    h.store.transaction((tx) =>
      h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
    );
    const instance = {
      ...h.identity,
      name: INSTANCE_NAME,
      instanceId: createIdentity("worker_instance"),
    };
    const result = h.store.transaction((tx) =>
      claimOnce(tx, h.dependencies, instance, h.pull, FIXTURE_NOW),
    );
    assert.equal(result.opening!.worker_instance, INSTANCE_NAME);
    assert.equal(result.opening!.placement, placement);
  }
});

test("instanceKeyOf keys an external harness by the last segment of the resource identity and its name", (t) => {
  const h = claimHarness(t);
  const harness = {
    ...h.identity,
    name: "harness-1",
    resourceIdentity: "worker:kanthord:coder",
  };
  assert.equal(instanceKeyOf(harness), HARNESS_INSTANCE_KEY);
});

test("the opening holds the placement of the registration instance and the facts of Mission", (t) => {
  const h = claimHarness(t);
  const placed: string[] = [];
  h.dependencies.registrations.placementOf = (_tx, runtimeIdentity) => {
    placed.push(runtimeIdentity);
    return PLACEMENT;
  };
  const reads: string[] = [];
  h.dependencies.facts.openingFacts = (_tx, nodeId) => {
    reads.push(nodeId);
    return {
      dependency_count: DEPENDENCIES,
      revision_turn: true,
      node_name: NODE_NAME,
    };
  };
  const claim = h.dependencies.transitions.claim;
  h.dependencies.transitions.claim = (...args) => {
    assert.deepEqual(reads, [h.row.node_id]);
    return claim(...args);
  };
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  const opening = h.claim().opening!;
  assert.equal(opening.placement, PLACEMENT);
  assert.deepEqual(placed, [h.row.runtime_identity]);
  assert.equal(opening.revision_turn, true);
  assert.equal(opening.dependency_count, DEPENDENCIES);
  assert.equal(opening.node_name, NODE_NAME);
});

test("the opening of an external harness claim holds no placement", (t) => {
  const h = claimHarness(t);
  h.dependencies.registrations.placementOf = () => null;
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  assert.equal(h.claim().opening!.placement, null);
});

test("the job of a revision turn measures the wait from its own queued_at", (t) => {
  const h = claimHarness(t);
  const enqueue = () =>
    h.store.transaction((tx) =>
      h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
    );
  const jobId = () =>
    h.store.database
      .prepare("SELECT job_id FROM scheduler_queue_place WHERE node_id = ?")
      .get(h.row.node_id)!.job_id;
  enqueue();
  setQueuedAt(h, QUEUED_AT);
  const first = h.claim();
  assert.equal(first.opening!.queue_wait_ms, WAITED_MS);
  const placeBefore = jobId();
  h.store.transaction((tx) => h.service.revoke(tx, h.row.node_id, FIXTURE_NOW));
  enqueue();
  setQueuedAt(h, REVISION_QUEUED_AT);
  assert.equal(jobId(), placeBefore);
  const turn = h.claim(FIXTURE_DEADLINE);
  assert.equal(turn.outcome, ClaimOutcome.Claimed);
  assert.equal(
    turn.opening!.queue_wait_ms,
    FIXTURE_DEADLINE - REVISION_QUEUED_AT,
  );
});

test("a repeat claim that answers the running execution carries no opening", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  assert.ok(h.claim().opening);
  const repeat = h.claim();
  assert.equal(repeat.outcome, ClaimOutcome.Running);
  assert.equal(repeat.opening, null);
});
