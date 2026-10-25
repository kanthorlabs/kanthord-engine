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
  ExecutionStop,
  ExecutionRun,
  EXECUTION_NOT_RUNNING,
  EXECUTION_PROOF_FAILED,
} from "./execution-run.ts";
import {
  executionBoundary,
  stopOnEnd,
  runNativeExecution,
  disposeAgent,
  environmentDigestsOf,
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
  implementFixture,
  task,
  transport,
  testSshAccess,
} from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import { AgentErrorType } from "./agent-telemetry.ts";
import { Phase, SpanOperation } from "./telemetry.ts";
import { ExecutionIntent, type RepositoryTransport } from "../contract.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import type { MethodClients } from "./method-clients.ts";
import { openNativeAgent, type NativeAgent } from "./native-agent.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";

const EXPECTED_CALL_COUNT = 1;
const NO_RELEASES = 0;
const START_POLL_MS = 10;
const RELEASE_CALL = "executionRelease";
const SESSION_END = "agent.session.end";
const SESSION_ENTRY = "session_entry";
const ONE_RELEASE = 1;
const TASK_COUNT = 2;
const VERIFICATION_COUNT = 3;
const BINDING_COUNT = 1;
async function startedSession(t: TestContext, clients: MethodClients) {
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
  const written: TelemetryRecord[] = [];
  const run = new ExecutionRun({
    claim,
    clients,
    credentials: { release: async () => {} },
    context: background,
    telemetry: {
      write: (records) => {
        written.push(...records);
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
    workspace,
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
  return { run, agent, pending, provider, ends, written };
}

test("S1 refusal aborts an active native session and ends its agent.session span exactly once", async (t) => {
  const { run, agent, pending, provider, ends } = await startedSession(
    t,
    {} as MethodClients,
  );
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

test("a stop during a turn ends the open tool and turn with stopped and the agent.session span with Error", async (t) => {
  const executionRelease = async () => ({
    type: "completed",
    status: 200,
    data: {},
  });
  const { run, agent, pending, written, ends } = await startedSession(t, {
    scheduler: { executionRelease },
  } as unknown as MethodClients);
  run.onTraceClose((status) => agent.closeTrace(status));
  const result = await executionBoundary(run, async () => {
    throw new ExecutionStop(EndReason.OperationFailed, null, null);
  });
  await pending.catch(() => {});
  disposeAgent(agent);
  run.dispose();
  assert.equal(result.kind, ExecutionEndKind.Released);
  assert.equal(ends.length, EXPECTED_CALL_COUNT);
  const spanEnds = written.flatMap((record) =>
    record.kind === RecordKind.Span && record.end_time ? [record] : [],
  );
  const session = spanEnds.find(
    (record) => record.operation === SpanOperation.Session,
  );
  assert.equal(session?.status, SpanStatus.Error);
  const turn = spanEnds.find(
    (record) => record.operation === SpanOperation.Turn,
  );
  assert.equal(turn?.status, SpanStatus.Error);
  assert.equal(turn?.attributes?.["error.type"], AgentErrorType.Stopped);
  const tool = spanEnds.find(
    (record) => record.operation === SpanOperation.Tool,
  );
  assert.equal(tool?.status, SpanStatus.Error);
  assert.equal(tool?.attributes?.["error.type"], AgentErrorType.Stopped);
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
test("the end of the prepare phase span holds the shape of the pinned revision", async (t) => {
  const h = await implementFixture(
    t,
    [task("first", "true"), task("second", "true")],
    [],
  );
  const { setup, claim } = h.input;
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  const clients = {
    mission: {
      "execution.pinnedRevision.get": async () =>
        complete({
          content: {
            ...h.revision.content,
            bindings: [setup.repositories[0]!.binding_id],
          },
          tasks: h.revision.tasks,
        }),
      "execution.rework_assessment.get": async () => complete(null),
      "execution.evidence.list": async () =>
        complete({ items: [], next_cursor: null }),
    },
    scheduler: { executionRelease: async () => complete({}) },
  } as unknown as MethodClients;
  const written: TelemetryRecord[] = [];
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test_prepare_shape",
  }));
  await runNativeExecution({
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
    transport,
    sshAccess: testSshAccess(setup.repositories),
    workspaces: WorkspaceRoot.open(temporary(t)),
    hostHome: temporary(t),
    env: hostEnvironment(),
    modelRuntimeFactory: scriptedModelRuntime(scriptedProvider([])),
    hostTools: () => unusedHostTools,
    context: background,
    telemetry: {
      write: (records) => void written.push(...records),
      flush: async () => {},
    },
  });
  const spans = written.filter((record) => record.kind === RecordKind.Span);
  const prepare = spans.find(
    (record) => record.attributes?.["kanthord.phase"] === Phase.Prepare,
  );
  const end = spans.find(
    (record) => record.end_time && record.span_id === prepare?.span_id,
  );
  assert.equal(end?.status, SpanStatus.Ok);
  assert.equal(end?.attributes?.["kanthord.node.task_count"], TASK_COUNT);
  assert.equal(
    end?.attributes?.["kanthord.node.verification_count"],
    VERIFICATION_COUNT,
  );
  assert.equal(end?.attributes?.["kanthord.node.binding_count"], BINDING_COUNT);
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
  const timeline: string[] = [];
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
        timeline.push(RELEASE_CALL);
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
        for (const record of records) {
          if (record.kind === RecordKind.SessionEntry)
            timeline.push(SESSION_ENTRY);
          if (
            record.kind === RecordKind.Span &&
            record.operation === SpanOperation.Session &&
            record.end_time
          ) {
            order.push(`${SESSION_END}:${record.status}`);
            timeline.push(`${SESSION_END}:${record.status}`);
          }
        }
      },
      flush: async () => {},
    },
  });
  return { result, provider, order, timeline };
}

test("native entry runs an examine report and ends the agent.session span before the release", async (t) => {
  const { result, provider, order } = await examineRun(t, [
    fauxAssistantMessage("All dependencies completed."),
  ]);
  assert.deepEqual(result, OK_RELEASE);
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
  assert.deepEqual(order, [`${SESSION_END}:${SpanStatus.Ok}`, RELEASE_CALL]);
});

test("the last session_entry record and the agent.session end reach the sink before the release", async (t) => {
  const { result, timeline } = await examineRun(t, [
    fauxAssistantMessage("All dependencies completed."),
  ]);
  assert.deepEqual(result, OK_RELEASE);
  assert.equal(timeline.at(-1), RELEASE_CALL);
  assert.equal(timeline.at(-2), `${SESSION_END}:${SpanStatus.Ok}`);
  assert.equal(timeline.at(-3), SESSION_ENTRY);
  assert.equal(
    timeline.filter((item) => item === RELEASE_CALL).length,
    ONE_RELEASE,
  );
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

test("the environment digests of a setup name each repository environment by its resource identity", () => {
  const repository = repositorySetup();
  const digest = "d".repeat(64);
  assert.deepEqual(
    environmentDigestsOf([
      {
        ...repository,
        resource_identity: "github:acme/engine",
        environment: { source: EnvironmentSource.Repository, digest },
      },
      { ...repository, resource_identity: "github:acme/none" },
    ]),
    { "github:acme/engine": digest },
  );
});
