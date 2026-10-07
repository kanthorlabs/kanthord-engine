import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import {
  EndReason,
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
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedProvider,
  scriptedModelRuntime,
} from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { noTranscript } from "./transcript.ts";
import type { RepositoryTransport } from "./contract.ts";
import type { MethodClients } from "./method-clients.ts";
import { NodeKind, openNativeAgent, type NativeAgent } from "./native-agent.ts";
import { WorkerMethod } from "./contract.ts";
import { renderWorkPrompt } from "../agent/prompt-composer.ts";

const EXPECTED_CALL_COUNT = 1;
const NO_RELEASES = 0;
test("S1 refusal aborts an active native session and records its stopped transcript exactly once", async (t) => {
  const setup = anthropicSetup();
  const claim = {
    executionId: setup.executionId,
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    createdAt: Date.now(),
    expiredAt: Date.now() + 60000,
    traceId: "trace",
  };
  const run = new ExecutionRun({
    claim,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
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
    nodeKind: NodeKind.Objective,
    method: WorkerMethod.Steps,
    credentials: store,
    handoverItem: { credentialId: setup.credentialId, providerId: "anthropic" },
    workspace,
    hostHome: temporary(t),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    context: run.operationContext,
  });
  stopOnEnd(run, agent);
  const pending = agent.prompt(
    renderWorkPrompt({
      nodeId: claim.nodeId,
      revision: 1,
      content: {
        name: "work",
        requirement: "wait",
        criterion: "wait",
        verifications: [],
      },
    }),
  );
  const POLLS = 100;
  for (let i = 0; i < POLLS && !existsSync(join(workspace, "started")); i++)
    await setTimeout(10);
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
  const entries: unknown[] = [];
  disposeAgent(run, agent, {
    record: (entry) => {
      entries.push(entry);
    },
  });
  run.dispose();
  assert.equal(entries.length, EXPECTED_CALL_COUNT);
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
  assert.equal(JSON.stringify(entries).includes(secret), false);
  assert.equal(JSON.stringify(entries).includes("ciphertext"), false);
});

test("S1 native reviewer evaluates even when the attempt already contains an expected request", async (t) => {
  const setup = anthropicSetup({
    workerName: "reviewer@1",
    agentName: "re@1",
    repositories: [],
  });
  const claim = {
    executionId: setup.executionId,
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    createdAt: Date.now(),
    expiredAt: Date.now() + 60000,
    traceId: "trace",
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
            name: "objective",
            requirement: "review",
            criterion: "met",
            verifications: ["true"],
            bindings: [],
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
          assetId,
          address,
          data: Buffer.from("report").toString("base64"),
          encoding: "base64",
          mediaType: "text/plain",
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
    credentials: { store, release: async () => {} },
    handoverItem: { credentialId: setup.credentialId, providerId: "anthropic" },
    transport: {} as RepositoryTransport,
    workspaces: WorkspaceRoot.open(temporary(t)),
    hostHome: temporary(t),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    transcript: noTranscript,
    hostTools: () => unusedHostTools,
    context: background,
  });
  assert.deepEqual(result, { kind: "closed", outcomeId: "outcome" });
  assert.equal(assessments, EXPECTED_CALL_COUNT);
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
});
test("native entry runs an initiative report with the scripted provider", async (t) => {
  const setup = anthropicSetup({ repositories: [] });
  const claim = {
    executionId: setup.executionId,
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    createdAt: Date.now(),
    expiredAt: Date.now() + 60000,
    traceId: "trace",
  };
  const provider = scriptedProvider([
    fauxAssistantMessage("All objectives completed."),
  ]);
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
  const clients = {
    mission: {
      "execution.pinnedRevision.get": async () =>
        complete({
          content: {
            name: "initiative",
            requirement: "report",
            criterion: "report",
            verifications: [],
            bindings: [],
          },
        }),
      "execution.objective.list": page,
      "execution.objective.outcome.list": page,
      "execution.objective.evidence.list": page,
      "evidence.submit": async () => complete({ evidence: {} }),
    },
    scheduler: { executionRelease: async () => complete({}) },
  } as unknown as MethodClients;
  const result = await runNativeExecution({
    claim,
    setup,
    clients,
    credentials: { store, release: async () => {} },
    handoverItem: { credentialId: setup.credentialId, providerId: "anthropic" },
    transport: {} as RepositoryTransport,
    workspaces: WorkspaceRoot.open(temporary(t)),
    hostHome: temporary(t),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    transcript: noTranscript,
    hostTools: () => unusedHostTools,
    context: background,
  });
  assert.deepEqual(result, { kind: "released", furtherWork: false });
  assert.equal(provider.calls.length, EXPECTED_CALL_COUNT);
});
test("refused execution evidence aborts the agent and prevents later server operations", async (t) => {
  for (const [status, code] of [
    [403, EXECUTION_PROOF_FAILED],
    [409, EXECUTION_NOT_RUNNING],
  ] as const) {
    const claim = {
      executionId: "execution",
      nodeId: "node",
      attempt: 1,
      pinnedRevision: 1,
      createdAt: Date.now(),
      expiredAt: Date.now() + 60000,
      traceId: "trace",
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
      await run.submitEvidence(claim.nodeId, { subject: "head", assets: [] });
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
