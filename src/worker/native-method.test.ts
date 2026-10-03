import assert from "node:assert/strict";
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
} from "./native-method.ts";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  anthropicSetup,
  fauxAssistantMessage,
  scriptedProvider,
  scriptedModelRuntime,
} from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { noTranscript } from "./transcript.ts";
import type { RepositoryTransport } from "./contract.ts";
import type { MethodClients } from "./method-clients.ts";
import type { NativeAgent } from "./native-agent.ts";

const ONE = 1;
const ZERO = 0;
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
  const page = async () => complete({ items: [], nextCursor: null });
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
    context: background,
  });
  assert.deepEqual(result, { kind: "released", furtherWork: false });
  assert.equal(provider.calls.length, ONE);
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
            requestId: "test",
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
    assert.equal(aborts, ONE);
    assert.equal(releases, ZERO);
  }
});
