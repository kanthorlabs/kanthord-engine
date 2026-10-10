import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
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
  handoverPayloadSchema,
  SecretShape,
  EXECUTION_CREDENTIAL_MAX_BYTES,
} from "../../custody/contract.ts";
import { llmOperations } from "../../llm/contract.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { agentOperations } from "../../agent/contract.ts";
import { missionOperations, NodeKind } from "../../mission/contract.ts";
import { schedulerOperations, WorkPullKind } from "../../scheduler/contract.ts";
import {
  OperationResultType,
  type Operation,
  type OperationResult,
  type ClientOptions,
} from "../../kernel/operation.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { SWE_AGENT_PROMPT } from "../../agent/prompt-assets.ts";
import { framing, PromptConsumer } from "../../agent/prompt-render.ts";
import { WORKING_LAYER_ALL_ON } from "../../worker/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { canonicalJSON, digest } from "../../kernel/json.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
  HANDOVER_CIPHER,
  HANDOVER_NONCE_BYTES,
  HANDOVER_TAG_BYTES,
} from "../../kernel/handover.ts";
import {
  FAKE_SSH_CREDENTIAL_BODY,
  FAKE_SSH_IDENTITY,
  gatewayFixture,
} from "./test-support.ts";

const SECRET = "test_handover-integration-secret-one";
const REFRESHED = "test_handover-integration-secret-two";
const ROTATED = "test_handover-integration-secret-three";
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
const MAX_REPORT_BYTES = 65534;
const OVERSIZED_REPORT_BYTES = 65538;
const CHILD_TIMEOUT_MS = 10000;
const MAX_CHILD_BUFFER = 1024;
const EMPTY_OUTPUT = "";
const API_KEY_FIELD = "key";
const NO_INPUT = { params: {}, query: {}, body: null };
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off" as const,
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

for (const adapter of ["direct", "http"] as const) {
  test(`${adapter} native setup reads pinned facts without secrets or new pins`, async (t) => {
    const h = await setup(t, adapter, undefined, { instanceCount: 2 });
    const input = {
      params: { execution_id: h.execution.execution_id },
      query: {},
      body: null,
    };
    const read = (token = h.token) =>
      h.call(workerOperations["execution.setup.get"], input, token);
    refused(
      await read(),
      HttpStatus.Conflict,
      "worker.execution.credential_not_pinned",
    );
    completed(await h.handover());
    const before = h.f.store.database
      .prepare("SELECT credentials FROM scheduler_execution WHERE id = ?")
      .get(h.execution.execution_id);
    const answer = completed(await read());
    assert.equal(answer.agents[0]!.credential_id, h.credentialId);
    assert.deepEqual(answer.agents[0]!.effective_configuration, {
      ...CONFIGURATION,
      provider: "anthropic",
      credential: "anthro-1",
    });
    assert.deepEqual(answer.resource_budget, {
      turns: 200,
      wall_time_ms: 7200000,
    });
    assert.equal(answer.agents[0]!.metadata, null);
    assert.ok(
      answer.agents[0]!.prompt.final.endsWith(framing(PromptConsumer.Worker)),
    );
    assert.ok(answer.agents[0]!.prompt.final.includes(SWE_AGENT_PROMPT));
    assert.deepEqual(answer.repositories[0], {
      binding_id: answer.repositories[0]!.binding_id,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      ssh_identity: FAKE_SSH_CREDENTIAL_BODY.metadata,
      strategy: { base_branch: "main" },
      project_prompt: "Follow repository conventions.",
      working_layer: WORKING_LAYER_ALL_ON,
    });
    assert.deepEqual(
      h.f.store.database
        .prepare("SELECT credentials FROM scheduler_execution WHERE id = ?")
        .get(h.execution.execution_id),
      before,
    );
    const human = await read(h.f.token);
    assert.ok(human.type === OperationResultType.Failure);
    assert.equal(human.status, HttpStatus.Unauthorized);
    const other = await h.f.machineToken(
      h.execution.project_id,
      "general",
      "other-instance",
    );
    completed(await h.call(workerOperations.register, NO_INPUT, other));
    refused(await read(other), HttpStatus.Forbidden, PROOF_FAILED);
    completed(
      await h.call(llmOperations.rotate, {
        params: { credential_name: "anthro-1" },
        query: {},
        body: { expected_revision: FIRST_REVISION, secret: { key: ROTATED } },
      }),
    );
    completed(
      await h.call(llmOperations.revoke, {
        params: { credential_name: "anthro-1", revision: FIRST_REVISION },
        query: {},
        body: null,
      }),
    );
    refused(await read(), HttpStatus.Conflict, "credential.revision.revoked");
    completed(await h.release());
    refused(await read(), HttpStatus.Forbidden, PROOF_FAILED);
  });

  test(`${adapter} native setup validates against rotated compatible metadata and binding budget`, async (t) => {
    const resourceBudget = { turns: 3, wall_time_ms: 600000 };
    const h = await setup(t, adapter, undefined, {
      compatible: true,
      noEntries: true,
      resourceBudget,
    });
    completed(await h.handover());
    const read = () =>
      h.call(
        workerOperations["execution.setup.get"],
        {
          params: { execution_id: h.execution.execution_id },
          query: {},
          body: null,
        },
        h.token,
      );
    const before = completed(await read());
    assert.deepEqual(before.resource_budget, resourceBudget);
    const newerModel = "new-model";
    completed(
      await h.call(llmOperations.rotate, {
        params: { credential_name: "anthro-1" },
        query: {},
        body: {
          expected_revision: TWO_REVISIONS,
          secret: { key: ROTATED },
          metadata: {
            base_url: "http://localhost:12345/v2",
            models: [
              { id: CONFIGURATION.model_identifier },
              { id: newerModel },
            ],
          },
        },
      }),
    );
    assert.deepEqual(completed(await read()), before);
    completed(
      await h.call(agentOperations["enablement.put"], {
        params: { agent_name: "swe@1" },
        query: {},
        body: {
          expected_revision: FIRST_REVISION,
          agent_providers: [
            {
              name: "default",
              provider: "openai-compatible",
              credential: "anthro-1",
            },
          ],
          default_configuration: {
            ...CONFIGURATION,
            model_identifier: newerModel,
          },
        },
      }),
    );
    refused(
      await read(),
      HttpStatus.BadRequest,
      "agent.configuration.model_unknown",
    );
    completed(
      await h.call(agentOperations["enablement.disable"], {
        params: { agent_name: "swe@1" },
        query: {},
        body: { expected_revision: TWO_REVISIONS },
      }),
    );
    refused(
      await read(),
      HttpStatus.BadRequest,
      "agent.enablement.unavailable",
    );
  });

  test(`${adapter} external execution refuses native setup`, async (t) => {
    const h = await setup(t, adapter, undefined, { workerName: "claude@1" });
    refused(
      await h.call(
        workerOperations["execution.setup.get"],
        {
          params: { execution_id: h.execution.execution_id },
          query: {},
          body: null,
        },
        h.token,
      ),
      HttpStatus.Conflict,
      "worker.execution.no_native_agent",
    );
  });
}

function offlineProvider(credential: OAuthCredential) {
  return createProvider({
    id: COPILOT,
    models: [],
    api: {
      stream: () => {
        throw new Error("Unexpected provider stream");
      },
      streamSimple: () => {
        throw new Error("Unexpected provider stream");
      },
    },
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
  const client = httpClient(llmOperations, f.endpoint, f.token);
  const pending = completed(
    await client.login(
      { params: {}, query: {}, body: { platform: COPILOT, name: "anthro-1" } },
      { idempotencyKey: ulid() },
    ),
  );
  for (let poll = 0; poll < LOGIN_POLL_LIMIT; poll++) {
    const state = completed(
      await client.login_status({
        params: { session_id: pending.session_id },
        query: {},
        body: null,
      }),
    );
    if (state.state !== LOGIN_PENDING) {
      assert.equal(state.state, LOGIN_COMPLETED);
      return completed(
        await client.get({
          params: { credential_name: "anthro-1" },
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
  setupOptions: {
    compatible?: boolean;
    noEntries?: boolean;
    instanceCount?: number;
    workerName?: string;
    resourceBudget?: { turns: number; wall_time_ms: number };
  } = {},
) {
  const oauth = boundary?.type === SecretShape.OAuth ? boundary : undefined;
  const platform = setupOptions.compatible
    ? "openai-compatible"
    : oauth
      ? "github-copilot"
      : "anthropic";
  const configuration = oauth
    ? { ...CONFIGURATION, model_identifier: "claude-sonnet-4.6" }
    : CONFIGURATION;
  const f = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
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
  let created = oauth
    ? await loginCredential(f, oauth)
    : completed(
        await call(llmOperations.create, {
          params: {},
          query: {},
          body: {
            name: "anthro-1",
            platform,
            metadata: setupOptions.compatible
              ? {
                  base_url: "http://localhost:12345/v1",
                  models: [],
                }
              : null,
            secret: {
              key:
                boundary?.type === SecretShape.ApiKey ? boundary.key : SECRET,
            },
          },
        }),
      );
  if (setupOptions.compatible)
    created = completed(
      await call(llmOperations.update_metadata, {
        params: { credential_name: "anthro-1" },
        query: {},
        body: {
          expected_revision: FIRST_REVISION,
          metadata: {
            base_url: "http://localhost:12345/v1",
            models: [
              {
                id: CONFIGURATION.model_identifier,
                reasoning_levels: ["off", "low"],
              },
            ],
          },
        },
      }),
    );
  completed(
    await call(repositoryOperations.create, {
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
    await call(repositoryOperations.create, {
      params: {},
      query: {},
      body: {
        name: "github-ssh",
        platform: "ssh",
        metadata: {
          host: "github.com",
          hostname: "github.com",
          port: 22,
          identity_file: "~/.ssh/id_rsa",
        },
        secret: {},
      },
    }),
  );
  completed(
    await call(agentOperations["enablement.put"], {
      params: { agent_name: "swe@1" },
      query: {},
      body: {
        agent_providers: [
          { name: "default", provider: platform, credential: "anthro-1" },
        ],
        default_configuration: configuration,
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
  const bindingSet = completed(
    await call(projectOperations["bindingSet.write"], {
      params: { project_id: projectId },
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
              ssh_credential: "github-ssh",
              strategy: { base_branch: "main" },
              credential: "github",
              project_prompt: "Follow repository conventions.",
            },
          },
          general: {
            kind: "worker",
            config: {
              worker: setupOptions.workerName ?? "general@1",
              instance_count: setupOptions.instanceCount ?? 1,
              resource_budget: setupOptions.resourceBudget && {
                turns: setupOptions.resourceBudget.turns,
                wall_time_ms: setupOptions.resourceBudget.wall_time_ms,
              },
              entries:
                setupOptions.workerName || setupOptions.noEntries
                  ? undefined
                  : [{ agent: "swe@1", ...configuration }],
            },
          },
        },
      },
    }),
  );
  const mission = completed(
    await call(missionOperations.get, {
      params: { project_id: projectId },
      query: {},
      body: null,
    }),
  );
  const initiative = completed(
    await call(missionOperations["node.create"], {
      params: { mission_id: mission.id },
      query: {},
      body: {
        filename: "initiative-1.md",
        kind: NodeKind.Initiative,
        content: CONTENT,
        reason: "plan",
        expected_mission_version: 1,
      },
    }),
  );
  completed(
    await call(missionOperations["node.create"], {
      params: { mission_id: mission.id },
      query: {},
      body: {
        filename: "objective-1.md",
        kind: NodeKind.Objective,
        content: { ...CONTENT, bindings: [bindingSet.bindings.repo!.id] },
        reason: "plan",
        expected_mission_version: 2,
        parent_id: initiative.revisions[0]!.node_id,
        expected_parent_revision: 1,
      },
    }),
  );
  const token = await f.machineToken(projectId, "general", "general-a");
  const runtimeIdentity = completed(
    await call(workerOperations.register, NO_INPUT, token),
  ).runtime_identity;
  const pull = async () => {
    const result = completed(
      await call(
        schedulerOperations.workPull,
        {
          params: {},
          query: {},
          body: {
            resource_identity: "worker:kanthord:general",
            runtime_identity: runtimeIdentity,
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
    deriveClientSecret(
      f.config.master_key,
      f.config.gateway.token_version,
      claims.sub,
    ),
  );
  const handover = (
    executionId = execution.execution_id,
    idempotencyKey = ulid(),
    auth = token,
  ) =>
    call(
      workerOperations.handover,
      { params: {}, query: {}, body: { execution_id: executionId } },
      auth,
      { idempotencyKey },
    );
  const report = (
    value: unknown,
    executionId = execution.execution_id,
    idempotencyKey = ulid(),
  ) =>
    call(
      workerOperations.credential,
      {
        params: {},
        query: {},
        body: {
          execution_id: executionId,
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
  const release = (executionId = execution.execution_id) =>
    call(
      schedulerOperations.executionRelease,
      {
        params: { execution_id: executionId },
        query: {},
        body: { further_work: true },
      },
      token,
    );
  const read = () =>
    call(llmOperations.get, {
      params: { credential_name: "anthro-1" },
      query: {},
      body: null,
    });
  const open = (
    envelope: ReturnType<typeof sealEnvelope>,
    executionId = execution.execution_id,
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
    runtime_identity: runtimeIdentity,
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

function sealRawJson(key: Buffer, aad: Buffer, value: unknown) {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  assert.ok(plaintext.length);
  assert.ok(aad.length);
  const nonce = randomBytes(HANDOVER_NONCE_BYTES);
  const cipher = createCipheriv(HANDOVER_CIPHER, key, nonce, {
    authTagLength: HANDOVER_TAG_BYTES,
  });
  cipher.setAAD(aad);
  try {
    return {
      nonce: nonce.toString("base64"),
      ciphertext: Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64"),
    };
  } finally {
    plaintext.fill(0);
  }
}

for (const adapter of ["direct", "http"] as const) {
  for (const field of ["key", "refresh", "access"] as const) {
    test(`${adapter} authenticated report rejects lone surrogates in ${field} without changing material`, async (t) => {
      const valid: Credential =
        field === API_KEY_FIELD
          ? { type: SecretShape.ApiKey, key: "test_é🙂" }
          : {
              type: SecretShape.OAuth,
              refresh: "test_é🙂",
              access: "test_é🙂",
              expires: 1700000000000,
            };
      const h = await setup(t, adapter, valid);
      const first = h.open(completed(await h.handover())).items[0]!;
      assert.deepEqual(first.credential, valid);
      const before = h.f.store.database
        .prepare("SELECT * FROM credential ORDER BY id")
        .all();
      const executionId = h.execution.execution_id;
      const aad = handoverAad(executionId, h.runtime_identity);
      for (const surrogate of ["\ud800", "\udc00"]) {
        const report = {
          credential_id: h.credentialId,
          digest: digest(valid),
          credential: { ...valid, [field]: surrogate },
        };
        const envelope = sealRawJson(h.keys.report, aad, report);
        assert.deepEqual(openEnvelope(h.keys.report, aad, envelope), report);
        refused(
          await h.call(
            workerOperations.credential,
            {
              params: {},
              query: {},
              body: { execution_id: executionId, ...envelope },
            },
            h.token,
            { idempotencyKey: ulid() },
          ),
          HttpStatus.BadRequest,
          INVALID_REPORT,
        );
        assert.deepEqual(
          h.f.store.database
            .prepare("SELECT * FROM credential ORDER BY id")
            .all(),
          before,
        );
        assert.deepEqual(
          h.open(completed(await h.handover())).items[0]?.credential,
          valid,
        );
      }
    });
  }
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
        clientSecret: deriveClientSecret(
          h.f.config.master_key,
          h.f.config.gateway.token_version,
          claims.sub,
        ),
        executionId: h.execution.execution_id,
        runtimeIdentity: h.runtime_identity,
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
    const executionId = h.execution.execution_id;
    const body = {
      execution_id: executionId,
      ...sealEnvelope(
        h.keys.report,
        handoverAad(executionId, h.runtime_identity),
        {
          credential_id: h.credentialId,
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
        await h.call(llmOperations.create, {
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
        await h.call(llmOperations.rotate, {
          params: { credential_name: "anthro-1" },
          query: {},
          body: {
            expected_revision: FIRST_REVISION,
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
    const first = completed(await h.handover(h.execution.execution_id, key));
    assert.deepEqual(h.open(first).items, [
      {
        credential_id: h.credentialId,
        provider_id: "anthropic",
        credential: { type: SecretShape.ApiKey, key: SECRET },
      },
    ]);
    const replay = await h.handover(h.execution.execution_id, key);
    assert(replay.type === OperationResultType.Failure);
    assert.equal(replay.status, HttpStatus.Conflict);
    assert.equal(JSON.stringify(replay).includes("ciphertext"), false);
    assert.equal(
      h.open(completed(await h.handover())).items[0]!.credential_id,
      h.credentialId,
    );
    completed(
      await h.call(llmOperations.rotate, {
        params: { credential_name: "anthro-1" },
        query: {},
        body: {
          expected_revision: FIRST_REVISION,
          secret: { key: ROTATED },
        },
      }),
    );
    assert(
      completed(await h.read()).revisions.every((row) => row.ended_at === null),
    );
    const refresh = {
      credential_id: h.credentialId,
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
        credential_id: createIdentity("credential"),
      }),
      HttpStatus.BadRequest,
      INVALID_REPORT,
    );
    refused(
      await h.handover(h.execution.execution_id, ulid(), h.f.token),
      HttpStatus.Unauthorized,
      "gateway.authentication.unauthorized",
    );
    completed(await h.release());
    refused(
      await h.handover(h.execution.execution_id, key),
      HttpStatus.Forbidden,
      PROOF_FAILED,
    );
    refused(await h.report(refresh), HttpStatus.Forbidden, PROOF_FAILED);
    const read = completed(await h.read());
    assert.notEqual(read.revisions[1]!.ended_at, null);
    assert.equal(read.revisions[0]!.ended_at, null);
    const next = await h.pull();
    assert.equal(
      h.open(completed(await h.handover(next.execution_id)), next.execution_id)
        .items[0]!.credential_id,
      read.revisions[0]!.id,
    );
    for (const secret of [SECRET, REFRESHED, ROTATED])
      assert.equal(h.f.logs.join("").includes(secret), false);
  });

  test(`${adapter} failed execution proof reserves no key and malformed reports expose no secret`, async (t) => {
    const h = await setup(t, adapter);
    const key = ulid();
    const clock = t.mock.method(Date, "now", () => h.execution.expired_at);
    refused(
      await h.handover(h.execution.execution_id, key),
      HttpStatus.Forbidden,
      PROOF_FAILED,
    );
    clock.mock.restore();
    completed(await h.handover(h.execution.execution_id, key));
    const aad = handoverAad(h.execution.execution_id, h.runtime_identity);
    const payload = {
      credential_id: h.credentialId,
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
            body: { execution_id: h.execution.execution_id, ...envelope },
          },
          h.token,
        ),
        HttpStatus.BadRequest,
        INVALID_REPORT,
      );
    }
    const extra = { execution_id: h.execution.execution_id, extra: true };
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
    body: JSON.stringify({ execution_id: h.execution.execution_id }).padEnd(
      1025,
      " ",
    ),
  });
  assert.equal(response.status, HttpStatus.PayloadTooLarge);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, BODY_TOO_LARGE);
});
