import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  AgentChoiceKind,
  ExecutionStopReason,
  ProviderFailure,
  type AgentSelection,
  type ReleaseStop,
} from "./contract.ts";
import { insertExecution, readExecution } from "./execution-store.ts";
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
    select: () => ({ kind: AgentChoiceKind.Selected, selections: [] }),
    providerFailure: (_tx, ...args) =>
      chainCalls.push({ method: "providerFailure", arguments: args }),
    success: (_tx, ...args) =>
      chainCalls.push({ method: "success", arguments: args }),
  };
  const row = executionFixture({ agent_selections: [selection] });
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
      nodeBranch: row.node_branch,
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

test("an advancing provider stop writes the cooldown of the pin and is neutral for the failure count", async (t) => {
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

test("a non-advancing provider stop counts as a failure and keeps the cooldown", async (t) => {
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

test("a release without a provider stop deletes the cooldown of the pin", async (t) => {
  const h = releaseHarness(t);
  t.mock.method(h.service, "wake", () => {});
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  await h.release(null);
  assert.deepEqual(h.chainCalls, [
    { method: "success", arguments: [[selection]] },
  ]);
  assert.deepEqual(
    h.store.transaction((tx) => readExecution(tx, h.row.execution_id))
      ?.agent_selections,
    [selection],
  );
});
