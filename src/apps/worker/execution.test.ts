import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  sealEnvelope,
} from "../../kernel/handover.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  EndReason,
  WorkspaceRoot,
  noTranscript,
  type NativeExecutionInput,
} from "../../worker/index.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import type { ExecutionSetup } from "../../worker/contract.ts";
import { workerApi } from "./api.ts";
import { testClaim } from "./test-support.ts";
import { hostExecution } from "./execution.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";

const SECRET = Buffer.alloc(32, 7).toString("base64");
test("host takes handover before setup and method, discards on every method end", async (t) => {
  const api = workerApi("http://127.0.0.1:1");
  const claim = testClaim();
  const events: string[] = [];
  const credential = {
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    provider_id: "anthropic",
    credential: { type: "api_key", key: "test_host_key" },
  };
  const setup: ExecutionSetup = {
    execution_id: claim.execution_id,
    worker_name: "general@1",
    agents: [
      {
        agent_name: "swe@1",
        credential_id: credential.credential_id,
        effective_configuration: {
          agent_provider: "default",
          provider: "anthropic",
          credential: "anthro-1",
          model_identifier: "claude-sonnet-4-5",
          reasoning_effort: "off",
        },
        metadata: null,
        prompt: { final: "setup prompt" },
      },
    ],
    templates: SHIPPED_TEMPLATES,
    resource_budget: { turns: 200, wall_time_ms: 7200000 },
    repositories: [],
  };
  t.mock.method(api.worker, "handover", async () => {
    events.push("handover");
    return {
      type: OperationResultType.Completed,
      status: 200,
      data: sealEnvelope(
        deriveHandoverKeys(SECRET).handover,
        handoverAad(claim.execution_id, claim.claimant.runtime_identity),
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
    transcript: noTranscript,
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
  const stop = {
    reason: EndReason.OperationFailed,
    code: "llm.provider.unavailable",
  };
  assert.equal(
    await hostExecution(input, async () => ({
      kind: "released",
      furtherWork: true,
      stop,
    })),
    null,
  );
  assert.equal(
    (await hostExecution(input, async () => ({ kind: "ended", ...stop })))
      ?.code,
    stop.code,
  );
  assert.equal(
    await hostExecution(input, async () => ({
      kind: "ended",
      reason: EndReason.Revoked,
      code: "scheduler.execution.not_running",
    })),
    null,
  );
  assert.equal(
    await stored!.items[0]!.store.read(credential.provider_id),
    undefined,
  );
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
  assert.equal(
    await stored!.items[0]!.store.read(credential.provider_id),
    undefined,
  );
  const workspace = temporary(t);
  await writeFile(join(workspace, "a.txt"), "test evidence");
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  for (const operation of [
    "evidence.submit",
    "evidence.asset.complete",
  ] as const) {
    for (const [status, code] of [
      [403, "gateway.invocation.execution_proof_failed"],
      [409, "scheduler.execution.not_running"],
    ] as const) {
      const failure = {
        type: OperationResultType.Failure,
        status,
        error: {
          request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
          error: { code, message: "Ended", details: null },
        },
      };
      t.mock.method(api.mission, "evidence.submit", async () => ({
        type: OperationResultType.Completed,
        status: 200,
        data: {
          evidence: { id: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAA" },
          uploads: [
            {
              asset_id: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
              put_url: "http://127.0.0.1/test_upload",
              headers: {},
              expires_at: Date.now() + 60000,
            },
          ],
        },
      }));
      t.mock.method(api.mission, operation, async () => failure);
      assert.equal(
        await hostExecution(input, async (native) => {
          let aborted = false;
          const unsubscribe = native.context.onCancel(() => {
            aborted = true;
          });
          try {
            await assert.rejects(
              native.hostTools(workspace).evidenceUpload("a.txt", undefined),
              { code },
            );
            assert.ok(aborted);
            assert.ok(native.context.err());
            return { kind: "released", furtherWork: false };
          } finally {
            unsubscribe();
          }
        }),
        null,
      );
    }
  }
  t.mock.method(api.worker, "execution.setup.get", async () => ({
    type: OperationResultType.Failure,
    status: 403,
    error: {
      request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
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
