import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { SERVER_HOLDER } from "../custody/contract.ts";
import { COOLDOWN_DEFAULTS } from "../agent/config.ts";
import {
  capturedLogger,
  FallbackLog,
  memoryCredentialHolds,
} from "../agent/test-support.ts";
import {
  AdvancingFailure,
  type AgentEntry,
  type DefaultConfiguration,
} from "../agent/contract.ts";
import {
  EnablementState,
  insertEnablementRevision,
} from "../agent/enablements.ts";
import { agentMigrations } from "../agent/migrations.ts";
import {
  AgentComponent,
  SelectionKind,
  type Dependencies as AgentDependencies,
} from "../agent/service.ts";
import { background } from "../kernel/context.ts";
import { ResourceStatus } from "../kernel/health.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import {
  AgentChoiceKind,
  ClaimIntent,
  ClaimNodeState,
  CooldownChangeKind,
  EnvironmentFailure,
  ExecutionStopReason,
  ProviderFailure,
  type AgentPin,
  type AgentSelection,
  type CooldownChange,
  type ReleaseStop,
} from "./contract.ts";
import { claimOnce, ClaimOutcome } from "./claim.ts";
import { InstanceQueue } from "./instance-queue.ts";
import {
  executionRecord,
  insertExecution,
  readExecution,
} from "./execution-store.ts";
import {
  executionFixture,
  schedulerHarness,
  FIXTURE_NOW,
  transitionFixture,
} from "./test-support.ts";

const selection: AgentSelection = {
  agent_name: "swe@1",
  position: 1,
  level: "enablement",
  agent_provider: "qwen",
  provider: "openai-compatible",
  credential: "qwen-key",
  model_identifier: "qwen3.6-plus",
  reasoning_effort: "high",
};
const pin: AgentPin = {
  agent_name: selection.agent_name,
  enablement_id: createIdentity("agent_enablement"),
  position: selection.position,
};
const FAILURE_METHOD = "failure";
const NO_FAILURES = 0;
const ONE_FAILURE = 1;
const TWO_FAILURES = 2;
const THREE_FAILURES = 3;
const FIRST_STRIKE = 1;

function stopOf(reason: ReleaseStop["reason"], code: string | null) {
  return { reason, code };
}

function releaseHarness(t: TestContext) {
  const h = schedulerHarness(t);
  const holds = memoryCredentialHolds();
  const heldOf = () =>
    h.store.transaction((tx) =>
      holds.holdOf(tx, selection.credential, SERVER_HOLDER),
    );
  const chainCalls: Array<{ method: string; arguments: unknown[] }> = [];
  const reported: Array<{
    changes: readonly CooldownChange[];
    ended: boolean;
  }> = [];
  const row = executionFixture({ agent_pins: [pin] });
  h.store.transaction((tx) => insertExecution(tx, row));
  const started: CooldownChange = {
    kind: CooldownChangeKind.Started,
    execution_id: row.execution_id,
    credential: selection.credential,
    holder: SERVER_HOLDER,
    code: ProviderFailure.RateLimited,
    strikes: FIRST_STRIKE,
    available_at: FIXTURE_NOW,
  };
  const cleared: CooldownChange = {
    kind: CooldownChangeKind.Cleared,
    execution_id: row.execution_id,
    credential: selection.credential,
    holder: SERVER_HOLDER,
  };
  h.dependencies.agentChains = {
    select: () => ({
      kind: AgentChoiceKind.Selected,
      selections: [],
      pins: [],
    }),
    resolve: () => [selection],
    providerFailure: (tx, _claimant, ...args) => {
      chainCalls.push({ method: "providerFailure", arguments: args });
      holds.hold(
        tx,
        selection.credential,
        SERVER_HOLDER,
        started.available_at,
        FIRST_STRIKE,
      );
      return [started];
    },
    success: (tx, _claimant, ...args) => {
      chainCalls.push({ method: "success", arguments: args });
      holds.release(tx, selection.credential, SERVER_HOLDER);
      return [cleared];
    },
    selected: () => {},
    cooldownsChanged: (changes) => {
      const stored = h.store.transaction((tx) =>
        readExecution(tx, row.execution_id),
      );
      reported.push({ changes, ended: stored?.ended_at !== null });
    },
  };
  const caller: CallerContext = {
    context: background,
    requestId: createIdentity("request"),
    execution: {
      executionId: row.execution_id,
      projectId: row.project_id,
      nodeId: row.node_id,
      attempt: row.attempt,
      pinnedRevision: row.pinned_revision,
      nodeBranch: `kanthord/${row.node_id}`,
      runtimeIdentity: row.runtime_identity,
      workerBindingId: row.worker_binding_id,
    },
    commit: (write) => h.store.transaction(write),
  };
  const prior = (stop: ReleaseStop) =>
    h.store.transaction((tx) =>
      insertExecution(
        tx,
        executionFixture({
          node_id: row.node_id,
          project_id: row.project_id,
          attempt: row.attempt,
          ended_at: FIXTURE_NOW,
          stop,
        }),
      ),
    );
  const release = (stop: ReleaseStop | null) =>
    h.invoke(
      "executionRelease",
      {
        params: { execution_id: row.execution_id },
        query: {},
        body: { further_work: true, ...(stop && { stop }) },
      },
      caller,
    );
  const failureCount = () =>
    h.calls.find((call) => call.method === FAILURE_METHOD)?.arguments[2];
  return {
    ...h,
    row,
    holds,
    heldOf,
    chainCalls,
    reported,
    started,
    cleared,
    prior,
    release,
    failureCount,
  };
}

test("an advancing provider stop writes the hold of the pin and is neutral for the failure count", async (t) => {
  const h = releaseHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.prior(stopOf(ExecutionStopReason.JudgementInvalid, null));
  h.prior(
    stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.QuotaExhausted),
  );
  await h.release(
    stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.RateLimited),
  );
  assert.deepEqual(h.chainCalls, [
    {
      method: "providerFailure",
      arguments: [
        [selection],
        ProviderFailure.RateLimited,
        h.row.execution_id,
        FIXTURE_NOW,
      ],
    },
  ]);
  assert.equal(h.failureCount(), ONE_FAILURE);
});

test("a first advancing provider stop counts no failure", async (t) => {
  const h = releaseHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  await h.release(
    stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.Unavailable),
  );
  assert.equal(h.failureCount(), NO_FAILURES);
});

test("three consecutive environment stops set no hold and never pause the node", async (t) => {
  const h = releaseHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.dependencies.transitions.failure = (tx, nodeId, count) => {
    h.calls.push({ method: FAILURE_METHOD, arguments: [tx, nodeId, count] });
    h.service.insert(tx, nodeId, h.row.project_id, 0);
    return transitionFixture();
  };
  for (let index = 0; index < TWO_FAILURES; index += 1)
    h.prior(
      stopOf(
        ExecutionStopReason.EnvironmentFailed,
        EnvironmentFailure.CommandAbsent,
      ),
    );
  await h.release(
    stopOf(
      ExecutionStopReason.EnvironmentFailed,
      EnvironmentFailure.SetupFailed,
    ),
  );
  assert.equal(h.failureCount(), NO_FAILURES);
  assert.deepEqual(
    h.store.database
      .prepare("SELECT node_id, available_at FROM scheduler_job")
      .all()
      .map((job) => ({ ...job })),
    [{ node_id: h.row.node_id, available_at: null }],
  );
});

test("environment stops between two code failures change no count of the other failures", async (t) => {
  const h = releaseHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.prior(stopOf(ExecutionStopReason.JudgementInvalid, null));
  for (let index = 0; index < THREE_FAILURES; index += 1)
    h.prior(
      stopOf(
        ExecutionStopReason.EnvironmentFailed,
        EnvironmentFailure.SetupFailed,
      ),
    );
  await h.release(stopOf(ExecutionStopReason.NoProgress, null));
  assert.equal(h.failureCount(), TWO_FAILURES);
});

test("a non-advancing provider stop counts as a failure and keeps the hold", async (t) => {
  const h = releaseHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.prior(
    stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.RateLimited),
  );
  h.prior(stopOf(ExecutionStopReason.NoProgress, null));
  await h.release(
    stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.Unauthorized),
  );
  assert.deepEqual(h.chainCalls, []);
  assert.equal(h.failureCount(), TWO_FAILURES);
});

test("a release without a provider stop releases the hold of the pin", async (t) => {
  const h = releaseHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  await h.release(null);
  assert.deepEqual(h.chainCalls, [
    {
      method: "success",
      arguments: [[selection], h.row.execution_id],
    },
  ]);
  assert.deepEqual(
    h.store.transaction((tx) => readExecution(tx, h.row.execution_id))
      ?.agent_pins,
    [pin],
  );
});

test("a release reports the cooldown changes of its write once, after the commit", async (t) => {
  const failing = releaseHarness(t);
  t.mock.method(failing.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  await failing.release(
    stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.RateLimited),
  );
  assert.deepEqual(failing.reported, [
    { changes: [failing.started], ended: true },
  ]);
  const succeeding = releaseHarness(t);
  t.mock.method(succeeding.service, "wake", () => {});
  await succeeding.release(null);
  assert.deepEqual(succeeding.reported, [
    { changes: [succeeding.cleared], ended: true },
  ]);
});

test("a non-advancing provider stop reports no cooldown change", async (t) => {
  const h = releaseHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  await h.release(
    stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.Unauthorized),
  );
  assert.deepEqual(h.reported, [{ changes: [], ended: true }]);
});

test("a rolled-back release reports no cooldown change", async (t) => {
  const rollback = new Error("rolled back");
  const refused = releaseHarness(t);
  t.mock.method(refused.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  refused.dependencies.transitions.release = () => {
    throw rollback;
  };
  const held = { available_at: FIXTURE_NOW, strikes: FIRST_STRIKE };
  refused.store.transaction((tx) =>
    refused.holds.hold(
      tx,
      selection.credential,
      SERVER_HOLDER,
      held.available_at,
      held.strikes,
    ),
  );
  await assert.rejects(refused.release(null), rollback);
  assert.deepEqual(refused.chainCalls, [
    {
      method: "success",
      arguments: [[selection], refused.row.execution_id],
    },
  ]);
  assert.deepEqual(refused.reported, []);
  assert.deepEqual(refused.heldOf(), held);
  assert.equal(
    refused.store.transaction((tx) =>
      readExecution(tx, refused.row.execution_id),
    )?.ended_at,
    null,
  );
  const failed = releaseHarness(t);
  t.mock.method(failed.service, "wake", () => {});
  failed.dependencies.transitions.failure = () => {
    throw rollback;
  };
  await assert.rejects(
    failed.release(
      stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.RateLimited),
    ),
    rollback,
  );
  assert.deepEqual(failed.chainCalls, [
    {
      method: "providerFailure",
      arguments: [
        [selection],
        ProviderFailure.RateLimited,
        failed.row.execution_id,
        FIXTURE_NOW,
      ],
    },
  ]);
  assert.deepEqual(failed.reported, []);
  assert.equal(failed.heldOf(), null);
  assert.equal(
    failed.store.transaction((tx) => readExecution(tx, failed.row.execution_id))
      ?.ended_at,
    null,
  );
});

const PIN_AGENT = "swe@1";
const PIN_WORKER = "coder@1";
const PRIMARY = {
  name: "primary",
  provider: "anthropic",
  credential: "anthropic",
};
const SPARE = {
  name: "spare",
  provider: "anthropic",
  credential: "anthropic-spare",
};
const CLAIM_REVISION = 3;
const WALL_TIME_MS = 7200000;
const head: DefaultConfiguration = {
  agent_provider: PRIMARY.name,
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
};
const other: DefaultConfiguration = {
  agent_provider: SPARE.name,
  model_identifier: "claude-haiku-4-5",
  reasoning_effort: "off",
};

function pinHarness(
  t: TestContext,
  logger: AgentDependencies["logger"] = pino({ enabled: false }),
) {
  const h = schedulerHarness(t);
  h.store.transaction(({ database }) => {
    for (const migration of agentMigrations) migration(database);
  });
  const holds = memoryCredentialHolds();
  const agent = new AgentComponent({
    store: h.store,
    config: {
      prompt: { agent_directory: "" },
      cooldown: COOLDOWN_DEFAULTS,
    },
    dataDirectory: "/nonexistent/data",
    custodySuitability: () => {},
    copyHeld: () => true,
    credentialHolds: holds,
    approvedModels: () => null,
    entriesOfAgent: () => [],
    repositoryPromptsOf: () => null,
    providerHealthCheck: () => async () => ResourceStatus.Unknown,
    providerCapability: () => "model-list read",
    toolDeclarations: async () => [],
    logger,
    clock: () => FIXTURE_NOW,
  });
  const bindings = new Map<string, AgentEntry | null>();
  const entryOf = (bindingId: string) => {
    const entry = bindings.get(bindingId);
    assert.notEqual(entry, undefined);
    return entry!;
  };
  const chainCalls: Array<{ method: string; arguments: unknown[] }> = [];
  h.dependencies.agentChains = {
    select: (tx, bindingId) => {
      const chosen = agent.selectAgent(tx, PIN_AGENT, entryOf(bindingId), {
        holders: [SERVER_HOLDER],
        claimant: SERVER_HOLDER,
      });
      if (chosen.kind === SelectionKind.Cooling)
        return {
          kind: AgentChoiceKind.Cooling,
          available_at: chosen.available_at,
        };
      assert.ok(chosen.kind === SelectionKind.Selected);
      return {
        kind: AgentChoiceKind.Selected,
        selections: [chosen.selection],
        pins: [
          {
            agent_name: PIN_AGENT,
            enablement_id: chosen.enablement_id,
            position: chosen.selection.position,
          },
        ],
      };
    },
    resolve: (tx, bindingId, pins) =>
      pins.map((pin) =>
        agent.selectionAt(
          tx,
          pin.agent_name,
          pin.enablement_id,
          entryOf(bindingId),
          pin.position,
        ),
      ),
    providerFailure: (tx, _claimant, selections, code, executionId, now) =>
      agent.recordProviderFailure(
        tx,
        selections,
        SERVER_HOLDER,
        code,
        executionId,
        now,
      ),
    success: (tx, _claimant, selections, executionId) => {
      chainCalls.push({ method: "success", arguments: [selections] });
      return agent.recordSuccess(tx, selections, SERVER_HOLDER, executionId);
    },
    selected: (selections, executionId) => {
      agent.recordSelection(selections, executionId);
    },
    cooldownsChanged: (changes) => {
      agent.recordCooldowns(changes);
    },
  };
  const row = executionFixture();
  const bindingId = row.worker_binding_id;
  bindings.set(bindingId, null);
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
  h.dependencies.bindings.workerBindingOf = () => ({
    binding_id: bindingId,
    worker_name: PIN_WORKER,
    instance_count: 1,
    tags: [],
    environment: null,
    tombstone: false,
    resource_budget: null,
  });
  h.dependencies.declarations.declarationOf = () => ({
    declared_node_states: [ClaimNodeState.Available],
    declared_intents: Object.values(ClaimIntent),
    resource_budget: { wall_time_ms: WALL_TIME_MS },
  });
  h.dependencies.transitions.claim = (tx, nodeId) => {
    h.service.delete(tx, nodeId);
    return {
      kind: "claim",
      project_id: row.project_id,
      attempt: 1,
      node_revision: CLAIM_REVISION,
    };
  };
  const enable = (
    defaults: DefaultConfiguration,
    tail: DefaultConfiguration[],
  ) =>
    h.store.transaction((tx) =>
      insertEnablementRevision(
        tx,
        PIN_AGENT,
        EnablementState.Enabled,
        [PRIMARY, SPARE],
        defaults,
        tail,
      ),
    );
  const claim = () =>
    h.store.transaction((tx) =>
      claimOnce(
        tx,
        { ...h.dependencies, instances: new InstanceQueue(() => {}) },
        identity,
        {
          resource_identity: row.resource_identity,
          runtime_identity: row.runtime_identity,
        },
        FIXTURE_NOW,
      ),
    );
  const caller = (claimed: { execution_id: string; node_id: string }) =>
    ({
      context: background,
      requestId: createIdentity("request"),
      execution: {
        executionId: claimed.execution_id,
        projectId: row.project_id,
        nodeId: claimed.node_id,
        attempt: 1,
        pinnedRevision: CLAIM_REVISION,
        nodeBranch: `kanthord/${claimed.node_id}`,
        runtimeIdentity: row.runtime_identity,
        workerBindingId: bindingId,
      },
      commit: (write) => h.store.transaction(write),
    }) satisfies CallerContext;
  return {
    ...h,
    agent,
    holds,
    bindings,
    bindingId,
    row,
    enable,
    claim,
    caller,
    chainCalls,
  };
}

test("an enablement edit, a binding edit and a hold during a live execution keep its selection", async (t) => {
  const h = pinHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.enable(head, [other]);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  const claimed = h.claim();
  assert.equal(claimed.outcome, ClaimOutcome.Claimed);
  const execution = claimed.row!;
  const [selection] = h.store.transaction((tx) =>
    h.dependencies.agentChains.resolve(
      tx,
      execution.worker_binding_id,
      execution.agent_pins,
    ),
  );
  assert.ok(selection);
  assert.equal(selection.model_identifier, head.model_identifier);
  assert.equal(selection.credential, PRIMARY.credential);
  const bindingEdit = createIdentity("binding");
  h.bindings.set(bindingEdit, {
    agent_provider: SPARE.name,
    model_identifier: other.model_identifier,
  });
  h.enable(other, []);
  h.store.transaction((tx) =>
    h.agent.recordProviderFailure(
      tx,
      [selection],
      SERVER_HOLDER,
      AdvancingFailure.RateLimited,
      createIdentity("execution"),
      FIXTURE_NOW,
    ),
  );
  const fresh = h.store.transaction((tx) =>
    h.dependencies.agentChains.select(tx, bindingEdit, "runtime"),
  );
  assert.ok(fresh.kind === AgentChoiceKind.Selected);
  assert.notDeepEqual(fresh.selections, [selection]);
  const record = h.store.transaction((tx) =>
    executionRecord(tx, h.dependencies, execution, FIXTURE_NOW),
  );
  assert.deepEqual(record.agent_selections, [selection]);
  assert.deepEqual(
    h.store.transaction((tx) =>
      h.service.agentSelectionsOf(tx, execution.execution_id),
    ),
    [selection],
  );
  await h.invoke(
    "executionRelease",
    {
      params: { execution_id: execution.execution_id },
      query: {},
      body: { further_work: true },
    },
    h.caller(execution),
  );
  assert.deepEqual(h.chainCalls, [
    { method: "success", arguments: [[selection]] },
  ]);
});

function claimedPin(t: TestContext, logger: AgentDependencies["logger"]) {
  const h = pinHarness(t, logger);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.enable(head, [other]);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  const claimed = h.claim();
  assert.equal(claimed.outcome, ClaimOutcome.Claimed);
  const execution = claimed.row!;
  const [pinned] = h.store.transaction((tx) =>
    h.dependencies.agentChains.resolve(
      tx,
      execution.worker_binding_id,
      execution.agent_pins,
    ),
  );
  assert.ok(pinned);
  assert.equal(pinned.credential, PRIMARY.credential);
  const seedHold = () =>
    h.store.transaction((tx) =>
      h.agent.recordProviderFailure(
        tx,
        [pinned],
        SERVER_HOLDER,
        AdvancingFailure.RateLimited,
        createIdentity("execution"),
        FIXTURE_NOW,
      ),
    );
  const release = (stop: ReleaseStop | null, caller = h.caller(execution)) =>
    h.invoke(
      "executionRelease",
      {
        params: { execution_id: execution.execution_id },
        query: {},
        body: { further_work: true, ...(stop && { stop }) },
      },
      caller,
    );
  return { ...h, execution, seedHold, release };
}

test("a rolled-back release of a pinned execution writes no cooldown log", async (t) => {
  const { logger, logs } = capturedLogger();
  const h = claimedPin(t, logger);
  h.seedHold();
  logs.length = 0;
  const heldOf = () =>
    h.store.transaction((tx) =>
      h.holds.holdOf(tx, PRIMARY.credential, SERVER_HOLDER),
    );
  const held = heldOf();
  assert.notEqual(held, null);
  const rollback = new Error("rolled back");
  const rollbackCaller = {
    ...h.caller(h.execution),
    commit: (write) =>
      h.store.transaction((tx) => {
        write(tx);
        throw rollback;
      }),
  } satisfies CallerContext;
  await assert.rejects(h.release(null, rollbackCaller), rollback);
  assert.deepEqual(
    logs.filter(({ msg }) => msg === FallbackLog.CooldownCleared),
    [],
  );
  assert.deepEqual(heldOf(), held);
  await assert.rejects(
    h.release(
      stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.RateLimited),
      rollbackCaller,
    ),
    rollback,
  );
  assert.deepEqual(
    logs.filter(({ msg }) => msg === FallbackLog.CooldownStarted),
    [],
  );
  assert.deepEqual(heldOf(), held);
});

test("a committed release of a pinned execution writes the cooldown records of today", async (t) => {
  const failing = capturedLogger();
  const h = claimedPin(t, failing.logger);
  failing.logs.length = 0;
  await h.release(
    stopOf(ExecutionStopReason.ProviderFailed, ProviderFailure.RateLimited),
  );
  assert.deepEqual(failing.logs, [
    {
      level: pino.levels.values.info,
      msg: FallbackLog.CooldownStarted,
      execution_id: h.execution.execution_id,
      credential_name: PRIMARY.credential,
      holder: SERVER_HOLDER,
      code: ProviderFailure.RateLimited,
      strikes: FIRST_STRIKE,
      available_at: FIXTURE_NOW + COOLDOWN_DEFAULTS.rate_limited_ms,
    },
  ]);
  const succeeding = capturedLogger();
  const cooling = claimedPin(t, succeeding.logger);
  cooling.seedHold();
  succeeding.logs.length = 0;
  await cooling.release(null);
  assert.deepEqual(succeeding.logs, [
    {
      level: pino.levels.values.info,
      msg: FallbackLog.CooldownCleared,
      execution_id: cooling.execution.execution_id,
      credential_name: PRIMARY.credential,
      holder: SERVER_HOLDER,
    },
  ]);
});
