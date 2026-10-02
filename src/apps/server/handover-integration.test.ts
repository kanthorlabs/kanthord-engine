import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import {
  createProvider,
  type Credential,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
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
  EXECUTION_CREDENTIAL_MAX_BYTES,
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
import { canonicalJSON, digest } from "../../kernel/json.ts";
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
const COPILOT = "github-copilot";
const LOGIN_COMPLETED = "completed";
const LOGIN_PENDING = "pending";
const LOGIN_POLL_LIMIT = 50;
const MAX_REPORT_BYTES = 65533;
const OVERSIZED_REPORT_BYTES = 65537;
const CHILD_TIMEOUT_MS = 10000;
const MAX_CHILD_BUFFER = 1024;
const EMPTY_OUTPUT = "";
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

function offlineProvider(credential: OAuthCredential) {
  return createProvider({
    id: COPILOT,
    models: [],
    api: {},
    auth: {
      oauth: {
        name: "Offline boundary fixture",
        login: async (interaction) => {
          interaction.notify({
            type: "device_code",
            verificationUri: "https://github.com/login/device",
            userCode: "ABCD-EFGH",
          });
          return credential;
        },
        refresh: async () => {
          throw new Error("Unexpected provider refresh");
        },
        toAuth: async () => {
          throw new Error("Unexpected provider auth");
        },
      },
    },
  });
}

async function loginCredential(
  f: Awaited<ReturnType<typeof gatewayFixture>>,
  credential: OAuthCredential,
) {
  assert.equal(credential.type, SecretShape.OAuth);
  const client = httpClient(custodyOperations, f.endpoint, f.token);
  const pending = completed(
    await client.login(
      { params: {}, query: {}, body: { platform: COPILOT, name: "anthro-1" } },
      { idempotencyKey: ulid() },
    ),
  );
  for (let poll = 0; poll < LOGIN_POLL_LIMIT; poll++) {
    const state = completed(
      await client.login_status({
        params: { sessionId: pending.sessionId },
        query: {},
        body: null,
      }),
    );
    if (state.state !== LOGIN_PENDING) {
      assert.equal(state.state, LOGIN_COMPLETED);
      return completed(
        await client.get({
          params: { credentialName: "anthro-1" },
          query: {},
          body: null,
        }),
      );
    }
    await setImmediate();
  }
  assert.fail("Offline OAuth login exceeded its bounded polls");
}

async function setup(
  t: TestContext,
  adapter: "direct" | "http",
  boundary?: Credential,
) {
  const oauth = boundary?.type === SecretShape.OAuth ? boundary : undefined;
  const platform = oauth ? "github-copilot" : "anthropic";
  const configuration = oauth
    ? { ...CONFIGURATION, modelIdentifier: "claude-sonnet-4.6" }
    : CONFIGURATION;
  const f = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
    oauthProviders: oauth ? () => [offlineProvider(oauth)] : undefined,
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
  const created = oauth
    ? await loginCredential(f, oauth)
    : completed(
        await call(custodyOperations.create, {
          params: {},
          query: {},
          body: {
            name: "anthro-1",
            platform: "anthropic",
            metadata: null,
            secret: {
              key:
                boundary?.type === SecretShape.ApiKey ? boundary.key : SECRET,
            },
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
          { name: "default", provider: platform, credential: "anthro-1" },
        ],
        defaultConfiguration: configuration,
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
              entries: [{ agent: "swe@1", ...configuration }],
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

function boundaryCredential(
  type: typeof SecretShape.ApiKey | typeof SecretShape.OAuth,
): Credential {
  const base =
    type === SecretShape.ApiKey
      ? { type, key: 'é🙂"\\\n' }
      : {
          type,
          refresh: "r".repeat(16000),
          access: 'é🙂"\\\n',
          expires: 1700000000000,
        };
  const remaining =
    EXECUTION_CREDENTIAL_MAX_BYTES - Buffer.byteLength(canonicalJSON(base));
  assert.ok(remaining > MAX_CHILD_BUFFER);
  const credential =
    base.type === SecretShape.ApiKey
      ? { ...base, key: base.key + "x".repeat(remaining) }
      : { ...base, access: base.access + "x".repeat(remaining) };
  assert.equal(
    Buffer.byteLength(canonicalJSON(credential)),
    EXECUTION_CREDENTIAL_MAX_BYTES,
  );
  return credential;
}

async function workerBoundaryRoundTrip(h: Awaited<ReturnType<typeof setup>>) {
  const claims = JSON.parse(
    Buffer.from(h.token.split(".")[1]!, "base64url").toString("utf8"),
  );
  const script = new URL(
    "../worker/credential-budget-test-support.ts",
    import.meta.url,
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      script.pathname,
      JSON.stringify({
        endpoint: h.f.endpoint,
        token: h.token,
        clientSecret: deriveClientSecret(h.f.config.masterKey, claims.sub),
        executionId: h.execution.executionId,
        runtimeIdentity: h.runtimeIdentity,
      }),
    ],
    { timeout: CHILD_TIMEOUT_MS, maxBuffer: MAX_CHILD_BUFFER },
  );
  assert.equal(stderr, EMPTY_OUTPUT);
  assert.deepEqual(JSON.parse(stdout), {
    reportBytes: MAX_REPORT_BYTES,
    released: true,
  });
}

for (const type of [SecretShape.ApiKey, SecretShape.OAuth] as const) {
  test(`${type} maximum handover and public worker store release fit HTTP; next byte refuses without writes`, async (t) => {
    const maximum = boundaryCredential(type);
    const h = await setup(t, HTTP, maximum);
    await workerBoundaryRoundTrip(h);
    const before = h.f.store.database
      .prepare("SELECT * FROM credential ORDER BY id")
      .all();
    const oversized =
      maximum.type === SecretShape.ApiKey
        ? { ...maximum, key: maximum.key + "x" }
        : { ...maximum, access: maximum.access + "x" };
    const executionId = h.execution.executionId;
    const body = {
      executionId,
      ...sealEnvelope(
        h.keys.report,
        handoverAad(executionId, h.runtimeIdentity),
        {
          credentialId: h.credentialId,
          digest: digest(maximum),
          credential: oversized,
        },
      ),
    };
    assert.equal(
      Buffer.byteLength(JSON.stringify(body)),
      OVERSIZED_REPORT_BYTES,
    );
    const identity = await h.f.gateway.authentication.authenticate(
      `Bearer ${h.token}`,
    );
    refused(
      await directClient(workerOperations, h.f.gateway.invocation).credential(
        { params: {}, query: {}, body },
        { identity, idempotencyKey: ulid() },
      ),
      HttpStatus.BadRequest,
      INVALID_REPORT,
    );
    refused(
      await httpClient(workerOperations, h.f.endpoint, h.token).credential(
        { params: {}, query: {}, body },
        { idempotencyKey: ulid() },
      ),
      HttpStatus.PayloadTooLarge,
      BODY_TOO_LARGE,
    );
    assert.deepEqual(
      h.f.store.database.prepare("SELECT * FROM credential ORDER BY id").all(),
      before,
    );
    assert.deepEqual(
      h.open(completed(await h.handover())).items[0]?.credential,
      maximum,
    );
    if (oversized.type === SecretShape.ApiKey) {
      refused(
        await h.call(custodyOperations.create, {
          params: {},
          query: {},
          body: {
            name: "oversized",
            platform: "anthropic",
            metadata: null,
            secret: { key: oversized.key },
          },
        }),
        HttpStatus.BadRequest,
        "credential.input.invalid",
      );
      refused(
        await h.call(custodyOperations.rotate, {
          params: { credentialName: "anthro-1" },
          query: {},
          body: {
            expectedRevision: FIRST_REVISION,
            secret: { key: oversized.key },
          },
        }),
        HttpStatus.BadRequest,
        "credential.input.invalid",
      );
      assert.deepEqual(
        h.f.store.database
          .prepare("SELECT * FROM credential ORDER BY id")
          .all(),
        before,
      );
    }
  });
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
