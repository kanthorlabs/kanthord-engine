import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { COOLDOWN_DEFAULTS } from "../agent/config.ts";
import { memoryCredentialHolds } from "../agent/test-support.ts";
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
import { AgentComponent, SelectionKind } from "../agent/service.ts";
import { background } from "../kernel/context.ts";
import { ResourceStatus } from "../kernel/health.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import {
  AgentChoiceKind,
  ClaimIntent,
  ClaimNodeState,
  ExecutionStopReason,
  ProviderFailure,
  type AgentPin,
  type AgentSelection,
  type ReleaseStop,
} from "./contract.ts";
import { claimOnce, ClaimOutcome } from "./claim.ts";
import {
  executionRecord,
  insertExecution,
  readExecution,
} from "./execution-store.ts";
import {
  executionFixture,
  schedulerHarness,
  FIXTURE_NOW,
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

function stopOf(reason: ReleaseStop["reason"], code: string | null) {
  return { reason, code };
}

function releaseHarness(t: TestContext) {
  const h = schedulerHarness(t);
  const chainCalls: Array<{ method: string; arguments: unknown[] }> = [];
  h.dependencies.agentChains = {
    select: () => ({
      kind: AgentChoiceKind.Selected,
      selections: [],
      pins: [],
    }),
    resolve: () => [selection],
    providerFailure: (_tx, ...args) =>
      chainCalls.push({ method: "providerFailure", arguments: args }),
    success: (_tx, ...args) =>
      chainCalls.push({ method: "success", arguments: args }),
    selected: () => {},
  };
  const row = executionFixture({ agent_pins: [pin] });
  h.store.transaction((tx) => insertExecution(tx, row));
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
  return { ...h, row, chainCalls, prior, release, failureCount };
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

function pinHarness(t: TestContext) {
  const h = schedulerHarness(t);
  h.store.transaction(({ database }) => {
    for (const migration of agentMigrations) migration(database);
  });
  const agent = new AgentComponent({
    store: h.store,
    config: {
      prompt: { system_file: "", agent_directory: "", host_file: true },
      cooldown: COOLDOWN_DEFAULTS,
    },
    dataDirectory: "/nonexistent/data",
    hostHome: "/nonexistent/home",
    workbenchDirectory: (agentName) => `/nonexistent/workbench/${agentName}`,
    custodySuitability: () => {},
    credentialHolds: memoryCredentialHolds(),
    approvedModels: () => null,
    entriesOfAgent: () => [],
    repositoryWorkingOf: () => null,
    providerHealthCheck: () => async () => ResourceStatus.Unknown,
    providerCapability: () => "model-list read",
    toolDeclarations: async () => [],
    logger: pino({ enabled: false }),
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
      const chosen = agent.selectAgent(tx, PIN_AGENT, entryOf(bindingId));
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
    providerFailure: (tx, selections, code, executionId, now) => {
      agent.recordProviderFailure(tx, selections, code, now, executionId);
    },
    success: (tx, selections, executionId) => {
      chainCalls.push({ method: "success", arguments: [selections] });
      agent.recordSuccess(tx, selections, executionId);
    },
    selected: (selections, executionId) => {
      agent.recordSelection(selections, executionId);
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
        h.dependencies,
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
      AdvancingFailure.RateLimited,
      FIXTURE_NOW,
      createIdentity("execution"),
    ),
  );
  const fresh = h.store.transaction((tx) =>
    h.dependencies.agentChains.select(tx, bindingEdit),
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
