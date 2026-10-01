import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { z } from "zod";
import { ulid } from "ulid";
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { deriveClientSecret } from "../../gateway/local.ts";
import {
  custodyOperations,
  handoverPayloadSchema,
  SecretShape,
} from "../../custody/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { missionOperations, NodeKind } from "../../mission/contract.ts";
import { schedulerOperations, WorkPullKind } from "../../scheduler/contract.ts";
import {
  OperationResultType,
  type Operation,
  type OperationResult,
  type ClientOptions,
} from "../../kernel/operation.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { digest } from "../../kernel/json.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
} from "../../kernel/handover.ts";
import { gatewayFixture } from "./test-support.ts";

const SECRET = "handover-integration-secret-one";
const REFRESHED = "handover-integration-secret-two";
const ROTATED = "handover-integration-secret-three";
const FIRST_REVISION = 1;
const TWO_REVISIONS = 2;
const HTTP = "http";
const PROOF_FAILED = "gateway.invocation.execution_proof_failed";
const INVALID_REPORT = "custody.handover.report_invalid";
const BODY_TOO_LARGE = "gateway.request.body_too_large";
const NO_INPUT = { params: {}, query: {}, body: null };
const CONFIGURATION = {
  agentProvider: "default",
  modelIdentifier: "claude-sonnet-4-5",
  reasoningEffort: "off" as const,
};
const CONTENT = {
  name: "Work",
  requirement: "Do work",
  criterion: "Done",
  verifications: ["true"],
  bindings: [],
};

function completed<T>(result: OperationResult<T>): T {
  assert(result.type === OperationResultType.Completed, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  return result.data;
}
function refused<T>(
  result: OperationResult<T>,
  status: number,
  code: string,
): void {
  assert(result.type === OperationResultType.Failure, JSON.stringify(result));
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(REFRESHED), false);
}

async function setup(t: TestContext, adapter: "direct" | "http") {
  const f = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
  });
  async function call<T extends Operation>(
    operation: T,
    input: z.input<T["input"]>,
    token = f.token,
    options: ClientOptions = {},
  ) {
    if (adapter === HTTP)
      return httpClient({ operation }, f.endpoint, token).operation(
        input,
        options,
      );
    const identity = await f.gateway.authentication.authenticate(
      `Bearer ${token}`,
    );
    return directClient({ operation }, f.gateway.invocation).operation(input, {
      ...options,
      identity,
    });
  }
  const created = completed(
    await call(custodyOperations.create, {
      params: {},
      query: {},
      body: {
        name: "anthro-1",
        platform: "anthropic",
        metadata: null,
        secret: { key: SECRET },
      },
    }),
  );
  completed(
    await call(custodyOperations.create, {
      params: {},
      query: {},
      body: {
        name: "github",
        platform: "github",
        metadata: null,
        secret: { key: "github-secret" },
      },
    }),
  );
  completed(
    await call(workerOperations["agent.enablement.put"], {
      params: { agentName: "swe@1" },
      query: {},
      body: {
        agentProviders: [
          { name: "default", provider: "anthropic", credential: "anthro-1" },
        ],
        defaultConfiguration: CONFIGURATION,
      },
    }),
  );
  const projectId = completed(
    await call(projectOperations.create, {
      params: {},
      query: {},
      body: { name: "handover" },
    }),
  ).id;
  completed(
    await call(projectOperations["bindingSet.write"], {
      params: { projectId },
      query: {},
      body: {
        version: 1,
        bindings: {
          repo: {
            kind: "repository",
            config: {
              available: true,
              platform: "github",
              address: "git@github.com:owner/repo.git",
              strategy: { baseBranch: "main" },
              credential: "github",
            },
          },
          general: {
            kind: "worker",
            config: {
              worker: "general@1",
              instanceCount: 1,
              entries: [{ agent: "swe@1", ...CONFIGURATION }],
            },
          },
        },
      },
    }),
  );
  const mission = completed(
    await call(missionOperations.get, {
      params: { projectId },
      query: {},
      body: null,
    }),
  );
  const initiative = completed(
    await call(missionOperations["node.create"], {
      params: { missionId: mission.id },
      query: {},
      body: {
        filename: "initiative-1.md",
        kind: NodeKind.Initiative,
        content: CONTENT,
        reason: "plan",
        expectedMissionVersion: 1,
      },
    }),
  );
  completed(
    await call(missionOperations["node.create"], {
      params: { missionId: mission.id },
      query: {},
      body: {
        filename: "objective-1.md",
        kind: NodeKind.Objective,
        content: { ...CONTENT, bindings: ["repo"] },
        reason: "plan",
        expectedMissionVersion: 2,
        parentId: initiative.revisions[0]!.nodeId,
        expectedParentRevision: 1,
      },
    }),
  );
  const token = await f.machineToken(projectId, "general", "general-a");
  const runtimeIdentity = completed(
    await call(workerOperations.register, NO_INPUT, token),
  ).runtimeIdentity;
  const pull = async () => {
    const result = completed(
      await call(
        schedulerOperations.workPull,
        {
          params: {},
          query: {},
          body: {
            resourceIdentity: "worker:kanthord:general",
            runtimeIdentity,
          },
        },
        token,
      ),
    );
    assert(result.kind === WorkPullKind.Claimed);
    return result.execution;
  };
  const execution = await pull();
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  );
  const keys = deriveHandoverKeys(
    deriveClientSecret(f.config.masterKey, claims.sub),
  );
  const handover = (
    executionId = execution.executionId,
    idempotencyKey = ulid(),
    auth = token,
  ) =>
    call(
      workerOperations.handover,
      { params: {}, query: {}, body: { executionId } },
      auth,
      { idempotencyKey },
    );
  const report = (
    value: unknown,
    executionId = execution.executionId,
    idempotencyKey = ulid(),
  ) =>
    call(
      workerOperations.credential,
      {
        params: {},
        query: {},
        body: {
          executionId,
          ...sealEnvelope(
            keys.report,
            handoverAad(executionId, runtimeIdentity),
            value,
          ),
        },
      },
      token,
      { idempotencyKey },
    );
  const release = (executionId = execution.executionId) =>
    call(
      schedulerOperations.executionRelease,
      { params: { executionId }, query: {}, body: { furtherWork: true } },
      token,
    );
  const read = () =>
    call(custodyOperations.get, {
      params: { credentialName: "anthro-1" },
      query: {},
      body: null,
    });
  const open = (
    envelope: ReturnType<typeof sealEnvelope>,
    executionId = execution.executionId,
  ) =>
    handoverPayloadSchema.parse(
      openEnvelope(
        keys.handover,
        handoverAad(executionId, runtimeIdentity),
        envelope,
      ),
    );
  return {
    f,
    call,
    token,
    keys,
    runtimeIdentity,
    execution,
    pull,
    handover,
    report,
    release,
    read,
    open,
    credentialId: created.revisions[0]!.id,
  };
}

for (const adapter of ["direct", "http"] as const) {
  test(`${adapter} handover pins, rotates, refreshes, rejects stale proof and drains after release`, async (t) => {
    const h = await setup(t, adapter);
    const key = ulid();
    const first = completed(await h.handover(h.execution.executionId, key));
    assert.deepEqual(h.open(first).items, [
      {
        credentialId: h.credentialId,
        providerId: "anthropic",
        credential: { type: SecretShape.ApiKey, key: SECRET },
      },
    ]);
    const replay = await h.handover(h.execution.executionId, key);
    assert(replay.type === OperationResultType.Failure);
    assert.equal(replay.status, HttpStatus.Conflict);
    assert.equal(JSON.stringify(replay).includes("ciphertext"), false);
    assert.equal(
      h.open(completed(await h.handover())).items[0]!.credentialId,
      h.credentialId,
    );
    completed(
      await h.call(custodyOperations.rotate, {
        params: { credentialName: "anthro-1" },
        query: {},
        body: {
          expectedRevision: FIRST_REVISION,
          secret: { key: ROTATED },
        },
      }),
    );
    assert(
      completed(await h.read()).revisions.every((row) => row.endedAt === null),
    );
    const refresh = {
      credentialId: h.credentialId,
      digest: digest({ type: SecretShape.ApiKey, key: SECRET }),
      credential: { type: SecretShape.ApiKey, key: REFRESHED },
    };
    assert.equal(completed(await h.report(refresh)), null);
    assert.equal(completed(await h.report(refresh)), null);
    assert.deepEqual(
      h.open(completed(await h.handover())).items[0]!.credential,
      refresh.credential,
    );
    assert.equal(completed(await h.read()).revisions.length, TWO_REVISIONS);
    refused(
      await h.report({ ...refresh, digest: "bad" }),
      HttpStatus.BadRequest,
      INVALID_REPORT,
    );
    refused(
      await h.report({
        ...refresh,
        credentialId: createIdentity("credential"),
      }),
      HttpStatus.BadRequest,
      INVALID_REPORT,
    );
    refused(
      await h.handover(h.execution.executionId, ulid(), h.f.token),
      HttpStatus.Unauthorized,
      "gateway.authentication.unauthorized",
    );
    completed(await h.release());
    refused(
      await h.handover(h.execution.executionId, key),
      HttpStatus.Forbidden,
      PROOF_FAILED,
    );
    refused(await h.report(refresh), HttpStatus.Forbidden, PROOF_FAILED);
    const read = completed(await h.read());
    assert.notEqual(read.revisions[1]!.endedAt, null);
    assert.equal(read.revisions[0]!.endedAt, null);
    const next = await h.pull();
    assert.equal(
      h.open(completed(await h.handover(next.executionId)), next.executionId)
        .items[0]!.credentialId,
      read.revisions[0]!.id,
    );
    for (const secret of [SECRET, REFRESHED, ROTATED])
      assert.equal(h.f.logs.join("").includes(secret), false);
  });

  test(`${adapter} failed execution proof reserves no key and malformed reports expose no secret`, async (t) => {
    const h = await setup(t, adapter);
    const key = ulid();
    const clock = t.mock.method(Date, "now", () => h.execution.expiredAt);
    refused(
      await h.handover(h.execution.executionId, key),
      HttpStatus.Forbidden,
      PROOF_FAILED,
    );
    clock.mock.restore();
    completed(await h.handover(h.execution.executionId, key));
    const aad = handoverAad(h.execution.executionId, h.runtimeIdentity);
    const payload = {
      credentialId: h.credentialId,
      digest: digest({ type: SecretShape.ApiKey, key: SECRET }),
      credential: { type: SecretShape.ApiKey, key: REFRESHED },
    };
    for (const envelope of [
      sealEnvelope(h.keys.handover, aad, payload),
      { nonce: "AAAA", ciphertext: "AAAA" },
    ]) {
      refused(
        await h.call(
          workerOperations.credential,
          {
            params: {},
            query: {},
            body: { executionId: h.execution.executionId, ...envelope },
          },
          h.token,
        ),
        HttpStatus.BadRequest,
        INVALID_REPORT,
      );
    }
    const extra = { executionId: h.execution.executionId, extra: true };
    refused(
      await h.call(
        workerOperations.handover,
        { params: {}, query: {}, body: extra },
        h.token,
      ),
      HttpStatus.BadRequest,
      "gateway.request.validation_failed",
    );
  });
}

test("HTTP handover enforces its byte limit before body parsing", async (t) => {
  const h = await setup(t, "http");
  const response = await fetch(`${h.f.endpoint}/api/worker/handover`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${h.token}`,
      "content-type": "application/json",
      "idempotency-key": ulid(),
    },
    body: JSON.stringify({ executionId: h.execution.executionId }).padEnd(
      1025,
      " ",
    ),
  });
  assert.equal(response.status, HttpStatus.PayloadTooLarge);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, BODY_TOO_LARGE);
});
