import { credentialSecrets } from "../../agent/known-secrets.ts";
import { ExecutionBudget } from "./budget.ts";
import { BudgetLimit, EnvironmentFailure } from "../../scheduler/contract.ts";
import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { background } from "../../kernel/context.ts";
import {
  EXECUTION_NOT_RUNNING,
  EXECUTION_PROOF_FAILED,
  ExecutionRun,
} from "./execution-run.ts";
import {
  EndReason,
  ExecutionEndKind,
  ExecutionStop,
} from "./execution-stop.ts";
import {
  disposeAgent,
  executionBoundary,
  runNativeExecution,
  stopOnEnd,
} from "./native-method.ts";
import {
  hostEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  anthropicAgent,
  anthropicSetup,
  declareAffected,
  everyBindingSshAccess,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  implementFixture,
  repositorySetup,
  scriptedModelRuntime,
  scriptedProvider,
  task,
  testSessions,
  testSshAccess,
  transport,
  workspaceRequest,
} from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { CLAIM_WATCH_INTERVAL_MS } from "./claim-watch.ts";
import { BASE_DIRECTORY } from "./workspace-layout.ts";
import { PoolClass } from "./tree-pool.ts";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import { AgentErrorType } from "./agent-telemetry.ts";
import { SpanOperation } from "./telemetry.ts";
import { ExecutionIntent, type RepositoryTransport } from "../contract.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import type { MethodClients } from "./method-clients.ts";
import { openNativeAgent } from "./native-agent.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";

const EXPECTED_CALL_COUNT = 1;
const NO_RELEASES = 0;
const START_POLL_MS = 10;
const RELEASE_CALL = "executionRelease";
const SESSION_END = "agent.session.end";
const SESSION_ENTRY = "session_entry";
const ONE_RELEASE = 1;
const ONE_TURN = 1;
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
  const knownSecrets = credentialSecrets(store, "anthropic");
  const budget = new ExecutionBudget({
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    resource_budget: setup.resource_budget,
  });
  const agent = await openNativeAgent({
    sessions: testSessions({
      credential: {
        credential_id: setup.agents[0]!.credential_id,
        provider_id: "anthropic",
        store,
      },
      modelRuntimeFactory: scriptedModelRuntime(provider),
      knownSecrets,
      budget,
      hostHome: temporary(t),
      spans: run.spans,
    }),
    request: workspaceRequest(setup, claim, workspace),
    knownSecrets,
    budget,
    context: run.operationContext,
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
  await disposeAgent(agent);
  await disposeAgent(agent);
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
    throw new ExecutionStop(EndReason.OperationFailed, null);
  });
  await pending.catch(() => {});
  await disposeAgent(agent);
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
      "execution.review_round.get": async () =>
        complete({ round: 1, final: false, review_base: null, findings: [] }),
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

test("an agent open that throws in the prepare runs no setup and leaves no base head tree", async (t) => {
  const h = await implementFixture(t, [task("first", "true")], []);
  const { claim } = h.input;
  writeFileSync(join(h.root, "node-file"), "node");
  await simpleGit(h.root).add("node-file");
  await simpleGit(h.root).raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "node",
  ]);
  await simpleGit(h.root).raw([
    "push",
    "origin",
    `HEAD:refs/heads/${claim.node_branch}`,
  ]);
  const setup = {
    ...h.input.setup,
    repositories: h.input.setup.repositories.map((repository) => ({
      ...repository,
      environment: {
        source: EnvironmentSource.Stored,
        document: { postCreateCommand: NODE_ONLY_SETUP_FAILURE },
        digest: "d".repeat(64),
      },
    })),
  };
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
    worker: {
      "execution.failed_check.get": async () => complete({ items: [] }),
      "execution.link_update.get": async () =>
        complete({ items: [], next_cursor: null, total: 0 }),
    },
  } as unknown as MethodClients;
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test_open_failure",
  }));
  const workspaces = WorkspaceRoot.open(temporary(t));
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
    workspaces,
    hostHome: temporary(t),
    env: hostEnvironment(),
    modelRuntimeFactory: async () => {
      throw new Error("open failed");
    },
    hostTools: () => unusedHostTools,
    context: background,
  });
  assert.equal(
    existsSync(join(workspaces.nodeKey(claim.node_id), BASE_DIRECTORY)),
    false,
  );
  assert.equal(
    workspaces.pool
      .trees()
      .filter(({ path }) => basename(dirname(path)) === PoolClass.Command)
      .length,
    NO_COMMAND_TREE,
  );
});

const RENDEZVOUS_MS = 5000;

function rendezvous(): { arrive(): Promise<void> } {
  const parties = 2;
  let arrived = 0;
  let open: () => void = () => {};
  const met = new Promise<void>((resolve) => {
    open = resolve;
  });
  const timeout = AbortSignal.timeout(RENDEZVOUS_MS);
  return {
    async arrive() {
      arrived += 1;
      if (arrived === parties) open();
      await Promise.race([
        met,
        new Promise((_, reject) =>
          timeout.addEventListener("abort", () =>
            reject(new Error("the revision read waited for the workspace")),
          ),
        ),
      ]);
    },
  };
}

test("the pinned revision read runs while the workspace branch prepares the checkout", async (t) => {
  const h = await implementFixture(t, [task("first", "true")], []);
  const { claim, setup } = h.input;
  const both = rendezvous();
  const checkout = transport.fetchAndCheckout.bind(transport);
  t.mock.method(
    transport,
    "fetchAndCheckout",
    async (...args: Parameters<typeof checkout>) => {
      await both.arrive();
      return checkout(...args);
    },
  );
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  let read = false;
  const clients = {
    mission: {
      "execution.pinnedRevision.get": async () => {
        await both.arrive();
        read = true;
        return complete({
          content: {
            ...h.revision.content,
            bindings: [setup.repositories[0]!.binding_id],
          },
          tasks: h.revision.tasks,
        });
      },
      "execution.rework_assessment.get": async () => complete(null),
      "execution.evidence.list": async () =>
        complete({ items: [], next_cursor: null }),
    },
    scheduler: { executionRelease: async () => complete({}) },
    worker: {
      "execution.failed_check.get": async () => complete({ items: [] }),
      "execution.link_update.get": async () =>
        complete({ items: [], next_cursor: null, total: 0 }),
    },
  } as unknown as MethodClients;
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test_parallel_read",
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
    modelRuntimeFactory: async () => {
      throw new Error("open failed");
    },
    hostTools: () => unusedHostTools,
    context: background,
  });
  assert.ok(read);
});

const NO_MODEL_CALLS = 0;

test("an invalid affected declaration at the base stops with environment_failed affected_invalid before the first model call", async (t) => {
  const h = await implementFixture(t, [task("first", "true")], []);
  await declareAffected(h, t, " ");
  const { claim, setup } = h.input;
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  const releases: unknown[] = [];
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
    scheduler: {
      executionRelease: async (input: { body: unknown }) => {
        releases.push(input.body);
        return complete({});
      },
    },
    worker: {
      "execution.failed_check.get": async () => complete({ items: [] }),
      "execution.link_update.get": async () =>
        complete({ items: [], next_cursor: null, total: 0 }),
    },
  } as unknown as MethodClients;
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test_affected_invalid",
  }));
  const provider = scriptedProvider([fauxAssistantMessage("never")]);
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
    modelRuntimeFactory: scriptedModelRuntime(provider),
    hostTools: () => unusedHostTools,
    context: background,
  });
  assert.equal(provider.calls.length, NO_MODEL_CALLS);
  assert.equal(releases.length, ONE_RELEASE);
  const { stop } = releases[0] as { stop: { reason: string; code: string } };
  assert.equal(stop.reason, EndReason.EnvironmentFailed);
  assert.equal(stop.code, EnvironmentFailure.AffectedInvalid);
});

const OK_RELEASE = { kind: "released", furtherWork: false };
const NODE_ONLY_SETUP_FAILURE = 'case "$PWD" in */checkouts/*) exit 1;; esac';
const NO_COMMAND_TREE = 0;

interface ExamineOptions {
  turns?: number;
}

async function examineRun(
  t: TestContext,
  script: Parameters<typeof scriptedProvider>[0],
  options: ExamineOptions = {},
) {
  const setup = anthropicSetup({
    intent: ExecutionIntent.Examine,
    repositories: [],
  });
  if (options.turns !== undefined) setup.resource_budget.turns = options.turns;
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
  const releases: unknown[] = [];
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
      executionRelease: async (input: { body: unknown }) => {
        releases.push(input.body);
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
  return { result, provider, order, timeline, releases };
}

test("native entry runs an examine report and ends the agent.session span before the release", async (t) => {
  const { result, provider, order } = await examineRun(t, [
    fauxAssistantMessage("All dependencies completed."),
  ]);
  assert.deepEqual(result, OK_RELEASE);
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
  assert.deepEqual(order, [`${SESSION_END}:${SpanStatus.Ok}`, RELEASE_CALL]);
});

const EXAMINE_TEXT = "All dependencies completed.";
const REFUSED_REPLIES = [
  [
    "error",
    fauxAssistantMessage(EXAMINE_TEXT, {
      stopReason: "error",
      errorMessage: "terminated",
    }),
  ],
  ["length", fauxAssistantMessage(EXAMINE_TEXT, { stopReason: "length" })],
  ["aborted", fauxAssistantMessage(EXAMINE_TEXT, { stopReason: "aborted" })],
  ["empty stop", fauxAssistantMessage("")],
  [
    "tool call",
    fauxAssistantMessage([
      fauxText(EXAMINE_TEXT),
      fauxToolCall("ls", { path: "." }),
    ]),
  ],
] as const;

test("at an exhausted turns budget only a nonempty stop reply with no tool call keeps the examine report", async (t) => {
  for (const [name, reply] of REFUSED_REPLIES) {
    const { result, releases } = await examineRun(
      t,
      [reply, fauxAssistantMessage(EXAMINE_TEXT)],
      { turns: ONE_TURN },
    );
    assert.equal(result.kind, ExecutionEndKind.Released, name);
    assert.deepEqual(
      (
        releases as {
          further_work: boolean;
          stop: { reason: string; code: string };
        }[]
      ).map(({ further_work, stop }) => [further_work, stop.reason, stop.code]),
      [[true, EndReason.BudgetEnd, BudgetLimit.Turns]],
      name,
    );
  }
  const { result, releases } = await examineRun(
    t,
    [fauxAssistantMessage(EXAMINE_TEXT)],
    { turns: ONE_TURN },
  );
  assert.deepEqual(result, OK_RELEASE);
  assert.deepEqual(releases, [{ further_work: false, stop: null }]);
});

test("an examine budget end after prepare releases with further_work and the stop budget_end/<limit>", async (t) => {
  const { result, releases } = await examineRun(
    t,
    [
      fauxAssistantMessage(fauxToolCall("ls", { path: "." }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("All dependencies completed."),
    ],
    { turns: ONE_TURN },
  );
  assert.equal(result.kind, ExecutionEndKind.Released);
  assert.equal(releases.length, ONE_RELEASE);
  const body = releases[0] as {
    further_work: boolean;
    stop: { reason: string; code: string };
  };
  assert.equal(body.further_work, true);
  assert.equal(body.stop.reason, EndReason.BudgetEnd);
  assert.equal(body.stop.code, BudgetLimit.Turns);
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
    stopAfter(t, () => run.dispose());
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

interface WatchedRun {
  script: (tick: () => void) => Parameters<typeof scriptedProvider>[0];
  claimState: string;
}

async function watchedImplementRun(t: TestContext, run: WatchedRun) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const tick = () => t.mock.timers.tick(CLAIM_WATCH_INTERVAL_MS);
  const h = await implementFixture(t, [task("hello", "test -f hello.txt")], []);
  const { claim, setup } = h.input;
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  const calls: string[] = [];
  const counted =
    (name: string, answer: () => unknown) => async (): Promise<unknown> => {
      calls.push(name);
      return answer();
    };
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
      "evidence.submit": counted("evidence.submit", () =>
        complete({ evidence: { id: createIdentity("evidence"), assets: [] } }),
      ),
    },
    scheduler: {
      claimGet: counted(CLAIM_READ, () =>
        complete({
          claim_state: run.claimState,
          ended_at: null,
          stop: null,
        }),
      ),
      executionRelease: counted(RELEASE_CALL, () =>
        complete({ execution_id: claim.execution_id, ended_at: Date.now() }),
      ),
    },
    worker: {
      "execution.failed_check.get": async () => complete({ items: [] }),
      "execution.link_update.get": async () =>
        complete({ items: [], next_cursor: null, total: 0 }),
      "execution.unit_record.put": async (request: { body: unknown }) =>
        complete(request.body),
    },
  } as unknown as MethodClients;
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: "test_claim_watch",
  }));
  const provider = scriptedProvider(run.script(tick));
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
    transport,
    sshAccess: testSshAccess(setup.repositories),
    workspaces: WorkspaceRoot.open(temporary(t)),
    hostHome: temporary(t),
    env: hostEnvironment(),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    hostTools: () => unusedHostTools,
    context: background,
  });
  const branches = await simpleGit().listRemote([
    "--heads",
    h.bare,
    claim.node_branch,
  ]);
  return { result, calls, provider, pushed: branches.trim() !== NO_OUTPUT };
}

const CLAIM_READ = "claimGet";
const NO_OUTPUT = "";
const THREE_TURNS = 3;
const FENCE_READS = 1;
const LONG_COMMAND_S = 600;
const KILLED_WITHIN_MS = 30000;

test("a run of three turns reads the claim once per 60 s and once at the push fence", async (t) => {
  const { result, calls, provider, pushed } = await watchedImplementRun(t, {
    claimState: "running",
    script: (tick) => [
      () => {
        tick();
        return fauxAssistantMessage(
          fauxToolCall("bash", { command: "printf hello > hello.txt" }),
          { stopReason: "toolUse" },
        );
      },
      () => {
        tick();
        return fauxAssistantMessage(
          fauxToolCall("bash", { command: "test -f hello.txt" }),
          { stopReason: "toolUse" },
        );
      },
      () => {
        tick();
        return fauxAssistantMessage("done");
      },
    ],
  });
  assert.deepEqual(result, OK_RELEASE);
  assert.equal(provider.calls.length, THREE_TURNS);
  assert.equal(
    calls.filter((call) => call === CLAIM_READ).length,
    THREE_TURNS + FENCE_READS,
  );
  assert.ok(pushed);
});

test("a claim watch revoke while an agent command runs kills the command and ends as revoked with no push and no release", async (t) => {
  const marker = join(temporary(t), "started");
  const startedAt = Date.now();
  const { result, calls, provider, pushed } = await watchedImplementRun(t, {
    claimState: "finished",
    script: (tick) => [
      () => {
        void (async () => {
          while (!existsSync(marker))
            await setTimeout(START_POLL_MS, undefined, { signal: t.signal });
          tick();
        })();
        return fauxAssistantMessage(
          fauxToolCall("bash", {
            command: `touch ${marker}; sleep ${LONG_COMMAND_S}`,
          }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("unexpected"),
    ],
  });
  assert.ok(existsSync(marker));
  assert.ok(Date.now() - startedAt < KILLED_WITHIN_MS);
  assert.deepEqual(result, {
    kind: ExecutionEndKind.Ended,
    reason: EndReason.Revoked,
    code: null,
  });
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
  assert.deepEqual(calls, [CLAIM_READ]);
  assert.equal(pushed, false);
});

test("a fence read of an ended claim in finish ends as revoked with no push and no release", async (t) => {
  const { result, calls, pushed } = await watchedImplementRun(t, {
    claimState: "finished",
    script: () => [
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "printf hello > hello.txt" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ],
  });
  assert.deepEqual(result, {
    kind: ExecutionEndKind.Ended,
    reason: EndReason.Revoked,
    code: null,
  });
  assert.equal(calls.filter((call) => call === CLAIM_READ).length, FENCE_READS);
  assert.equal(calls.includes(RELEASE_CALL), false);
  assert.equal(pushed, false);
});

test("a fence read of an ended claim in onStop skips the push and the release and ends the run as revoked", async (t) => {
  const { result, calls, pushed } = await watchedImplementRun(t, {
    claimState: "finished",
    script: () => [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "terminated",
      }),
    ],
  });
  assert.equal(result.kind, ExecutionEndKind.Ended);
  assert.equal(
    result.kind === ExecutionEndKind.Ended && result.reason,
    EndReason.Revoked,
  );
  assert.equal(calls.filter((call) => call === CLAIM_READ).length, FENCE_READS);
  assert.equal(
    calls.filter((call) => call === RELEASE_CALL).length,
    NO_RELEASES,
  );
  assert.equal(pushed, false);
});
