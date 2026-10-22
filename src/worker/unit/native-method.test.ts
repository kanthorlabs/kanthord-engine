import { ExecutionBudget } from "./budget.ts";
import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { background } from "../../kernel/context.ts";
import {
  EndReason,
  ExecutionEndKind,
  ExecutionRun,
  EXECUTION_NOT_RUNNING,
  EXECUTION_PROOF_FAILED,
} from "./execution-run.ts";
import {
  executionBoundary,
  stopOnEnd,
  runNativeExecution,
  disposeAgent,
} from "./native-method.ts";
import { temporary, hostEnvironment } from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  anthropicAgent,
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedProvider,
  scriptedModelRuntime,
  repositorySetup,
  everyBindingSshAccess,
} from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { RecordKind, SpanStatus } from "../../tracking/contract.ts";
import { SpanOperation } from "./telemetry.ts";
import { ExecutionIntent, type RepositoryTransport } from "../contract.ts";
import type { MethodClients } from "./method-clients.ts";
import { openNativeAgent, type NativeAgent } from "./native-agent.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";

const EXPECTED_CALL_COUNT = 1;
const NO_RELEASES = 0;
const START_POLL_MS = 10;
const RELEASE_CALL = "executionRelease";
const SESSION_END = "agent.session.end";
test("S1 refusal aborts an active native session and ends its agent.session span exactly once", async (t) => {
  const setup = anthropicSetup();
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const ends: string[] = [];
  const run = new ExecutionRun({
    claim,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
    telemetry: {
      write: (records) => {
        for (const record of records)
          if (
            record.kind === RecordKind.Span &&
            record.operation === SpanOperation.Session &&
            record.end_time
          )
            ends.push(record.span_id);
      },
      flush: async () => {},
    },
  });
  const workspace = temporary(t);
  const store = new InMemoryCredentialStore();
  const secret = "test_active_session_secret";
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: secret,
  }));
  const provider = scriptedProvider([
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "touch started; sleep 30" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("unexpected"),
  ]);
  const agent = await openNativeAgent({
    hostTools: unusedHostTools,
    setup,
    claim,
    intent: ExecutionIntent.Implement,
    agent: setup.agents[0]!,
    credential: {
      credential_id: setup.agents[0]!.credential_id,
      provider_id: "anthropic",
      store: store,
    },
    budget: new ExecutionBudget({
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      resource_budget: setup.resource_budget,
    }),
    workspaceAgentFiles: true,
    workspace,
    checkouts: [workspace],
    hostHome: temporary(t),
    env: hostEnvironment(),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    context: run.operationContext,
    spans: run.spans,
  });
  stopOnEnd(run, agent);
  const pending = agent.prompt(
    renderWorkPrompt(SHIPPED_TEMPLATES, {
      node_id: claim.node_id,
      revision: 1,
      content: {
        name: "work",
        requirement: "wait",
        criterion: "wait",
        verifications: [],
      },
    }),
  );
  while (!existsSync(join(workspace, "started")))
    await setTimeout(START_POLL_MS, undefined, { signal: t.signal });
  assert.ok(existsSync(join(workspace, "started")));
  const result = await executionBoundary(run, async () => {
    await run.call(async () => ({
      type: "failure",
      status: 409,
      error: {
        error: { code: EXECUTION_NOT_RUNNING, message: "ended", details: null },
        request_id: "test",
      },
    }));
    throw new Error("unexpected");
  });
  await pending;
  assert.deepEqual(result, {
    kind: "ended",
    reason: EndReason.Revoked,
    code: EXECUTION_NOT_RUNNING,
  });
  disposeAgent(agent);
  disposeAgent(agent);
  run.dispose();
  assert.equal(ends.length, EXPECTED_CALL_COUNT);
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
});

test("S1 native reviewer evaluates even when the attempt already contains an expected request", async (t) => {
  const repository = repositorySetup();
  const setup = anthropicSetup({
    worker_name: "reviewer@1",
    agents: [anthropicAgent({ agent_name: "re@1" })],
    repositories: [repository],
  });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const assetId = createIdentity("evidence_asset");
  const address = { kind: "produced", sha256: "a".repeat(64) };
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  let assessments = 0;
  const clients = {
    mission: {
      "execution.pinnedRevision.get": async () =>
        complete({
          content: {
            name: "node",
            requirement: "review",
            criterion: "met",
            verifications: ["true"],
            bindings: [repository.binding_id],
          },
          tasks: [],
        }),
      "execution.evidence.list": async () =>
        complete({
          items: [
            {
              id: "report",
              assets: [{ id: assetId, kind: "produced", address }],
            },
            {
              id: "request",
              requirementKey: "action",
              endState: "expected",
              assets: [],
            },
          ],
          next_cursor: null,
        }),
      "execution.evidence.asset.content.get": async () =>
        complete({
          asset_id: assetId,
          address,
          data: Buffer.from("report").toString("base64"),
          encoding: "base64",
          media_type: "text/plain",
        }),
      "evidence.submit": async () =>
        complete({ evidence: { id: "verification" } }),
      "assessment.submit": async () => {
        assessments++;
        return complete({ outcome: { id: "outcome" } });
      },
    },
  } as unknown as MethodClients;
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test_request_evaluation",
  }));
  const provider = scriptedProvider([
    fauxAssistantMessage(
      'kanthord-judgement: {"result":"success","rationale":"met"}',
    ),
  ]);
  const result = await runNativeExecution({
    claim,
    setup,
    clients,
    credentials: {
      items: [
        {
          credential_id: setup.agents[0]!.credential_id,
          provider_id: "anthropic",
          store,
        },
      ],
      release: async () => {},
    },
    transport: {} as RepositoryTransport,
    sshAccess: everyBindingSshAccess,
    workspaces: WorkspaceRoot.open(temporary(t)),
    hostHome: temporary(t),
    env: hostEnvironment(),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    hostTools: () => unusedHostTools,
    context: background,
  });
  assert.deepEqual(result, { kind: "closed", outcomeId: "outcome" });
  assert.equal(assessments, EXPECTED_CALL_COUNT);
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
});
const OK_RELEASE = { kind: "released", furtherWork: false };

async function examineRun(
  t: TestContext,
  script: Parameters<typeof scriptedProvider>[0],
) {
  const setup = anthropicSetup({
    intent: ExecutionIntent.Examine,
    repositories: [],
  });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "a".repeat(32),
    root_span_id: "1".repeat(16),
  };
  const provider = scriptedProvider(script);
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test_native_method",
  }));
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  const page = async () => complete({ items: [], next_cursor: null });
  const order: string[] = [];
  const clients = {
    mission: {
      "execution.pinnedRevision.get": async () =>
        complete({
          content: {
            name: "examine",
            requirement: "report",
            criterion: "report",
            verifications: [],
            bindings: [],
          },
        }),
      "execution.dependency.list": page,
      "execution.dependency.outcome.list": page,
      "execution.dependency.evidence.list": page,
      "evidence.submit": async () => complete({ evidence: {} }),
    },
    scheduler: {
      executionRelease: async () => {
        order.push(RELEASE_CALL);
        return complete({});
      },
    },
  } as unknown as MethodClients;
  const result = await runNativeExecution({
    claim,
    setup,
    clients,
    credentials: {
      items: [
        {
          credential_id: setup.agents[0]!.credential_id,
          provider_id: "anthropic",
          store,
        },
      ],
      release: async () => {},
    },
    transport: {} as RepositoryTransport,
    sshAccess: everyBindingSshAccess,
    workspaces: WorkspaceRoot.open(temporary(t)),
    hostHome: temporary(t),
    env: hostEnvironment(),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    hostTools: () => unusedHostTools,
    context: background,
    telemetry: {
      write: (records) => {
        for (const record of records)
          if (
            record.kind === RecordKind.Span &&
            record.operation === SpanOperation.Session &&
            record.end_time
          )
            order.push(`${SESSION_END}:${record.status}`);
      },
      flush: async () => {},
    },
  });
  return { result, provider, order };
}

test("native entry runs an examine report and ends the agent.session span before the release", async (t) => {
  const { result, provider, order } = await examineRun(t, [
    fauxAssistantMessage("All dependencies completed."),
  ]);
  assert.deepEqual(result, OK_RELEASE);
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
  assert.deepEqual(order, [`${SESSION_END}:${SpanStatus.Ok}`, RELEASE_CALL]);
});

test("a stop ends the agent.session span with Error before the release of the stop", async (t) => {
  const { result, order } = await examineRun(t, [
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "terminated",
    }),
  ]);
  assert.equal(result.kind, ExecutionEndKind.Released);
  assert.deepEqual(order, [`${SESSION_END}:${SpanStatus.Error}`, RELEASE_CALL]);
});
test("refused execution evidence aborts the agent and prevents later server operations", async (t) => {
  for (const [status, code] of [
    [403, EXECUTION_PROOF_FAILED],
    [409, EXECUTION_NOT_RUNNING],
  ] as const) {
    const claim = {
      execution_id: "execution",
      node_id: "node",
      attempt: 1,
      pinned_revision: 1,
      node_branch: `kanthord/${"node"}`,
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
      root_span_id: "1".repeat(16),
    };
    let aborts = 0;
    let releases = 0;
    const clients = {
      mission: {
        "evidence.submit": async () => ({
          type: "failure",
          status,
          error: {
            error: { code, message: "ended", details: null },
            request_id: "test",
          },
        }),
      },
      scheduler: {
        executionRelease: async () => {
          releases++;
          throw new Error("unexpected");
        },
      },
    } as unknown as MethodClients;
    const run = new ExecutionRun({
      claim,
      clients,
      credentials: { release: async () => {} },
      context: background,
    });
    t.after(() => run.dispose());
    stopOnEnd(run, {
      abort: async () => {
        aborts++;
      },
    } as unknown as NativeAgent);
    const result = await executionBoundary(run, async () => {
      await run.submitEvidence(claim.node_id, { subject: "head", assets: [] });
      return run.release(false);
    });
    assert.deepEqual(result, {
      kind: "ended",
      reason: EndReason.Revoked,
      code,
    });
    await assert.rejects(run.release(false));
    assert.equal(aborts, EXPECTED_CALL_COUNT);
    assert.equal(releases, NO_RELEASES);
  }
});
