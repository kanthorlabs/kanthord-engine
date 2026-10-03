import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  sealEnvelope,
} from "../../kernel/handover.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  WorkspaceRoot,
  noTranscript,
  type NativeExecutionInput,
} from "../../worker/index.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import type { ExecutionSetup } from "../../worker/contract.ts";
import { workerApi } from "./api.ts";
import { testClaim } from "./test-support.ts";
import { hostExecution } from "./execution.ts";

const SECRET = Buffer.alloc(32, 7).toString("base64");
test("host takes handover before setup and method, discards on every method end", async (t) => {
  const api = workerApi("http://127.0.0.1:1");
  const claim = testClaim();
  const events: string[] = [];
  const credential = {
    credentialId: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    providerId: "anthropic",
    credential: { type: "api_key", key: "test_host_key" },
  };
  const setup: ExecutionSetup = {
    executionId: claim.executionId,
    workerName: "general@1",
    agentName: "swe@1",
    credentialId: credential.credentialId,
    effectiveConfiguration: {
      agentProvider: "default",
      provider: "anthropic",
      credential: "anthro-1",
      modelIdentifier: "claude-sonnet-4-5",
      reasoningEffort: "off",
    },
    metadata: null,
    resourceBudget: { turns: 200, wallTimeMs: 7200000 },
    repositories: [],
    globalPrompt: { state: "absent" },
  };
  t.mock.method(api.worker, "handover", async () => {
    events.push("handover");
    return {
      type: OperationResultType.Completed,
      status: 200,
      data: sealEnvelope(
        deriveHandoverKeys(SECRET).handover,
        handoverAad(claim.executionId, claim.claimant.runtimeIdentity),
        { items: [credential] },
      ),
    };
  });
  t.mock.method(api.worker, "execution.setup.get", async () => {
    events.push("setup");
    return { type: OperationResultType.Completed, status: 200, data: setup };
  });
  const input = {
    api,
    claim,
    clientSecret: SECRET,
    context: background,
    workspaces: WorkspaceRoot.open(temporary(t)),
    transport: new RepositoryComponent(),
    modelRuntimeFactory: async () => {
      throw new Error("Unexpected inference");
    },
    hostHome: temporary(t),
    log: () => {},
  };
  let stored: NativeExecutionInput["credentials"] | undefined;
  assert.equal(
    await hostExecution(input, async (native) => {
      events.push("method");
      stored = native.credentials;
      assert.equal(native.transcript, noTranscript);
      assert.ok(native.hostTools(temporary(t)).evidenceUpload);
      return { kind: "released", furtherWork: false };
    }),
    null,
  );
  assert.deepEqual(events, ["handover", "setup", "method"]);
  assert.equal(await stored!.store.read(credential.providerId), undefined);
  const expected = "system.operation.unknown";
  assert.equal(
    (
      await hostExecution(input, async (native) => {
        stored = native.credentials;
        throw new Error("test_private_material");
      })
    )?.code,
    expected,
  );
  assert.equal(await stored!.store.read(credential.providerId), undefined);
  t.mock.method(api.worker, "execution.setup.get", async () => ({
    type: OperationResultType.Failure,
    status: 403,
    error: {
      requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      error: {
        code: "gateway.invocation.execution_proof_failed",
        message: "Ended",
        details: null,
      },
    },
  }));
  assert.equal(
    await hostExecution(input, async () => {
      assert.fail("Revoked claim ran");
    }),
    null,
  );
});
