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
import { directClient } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { deriveClientSecret } from "../../gateway/auth/jwt.ts";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
  handoverPayloadSchema,
  plainHandoverPayloadSchema,
  SecretShape,
  sshSignAnswerSchema,
  EXECUTION_CREDENTIAL_MAX_BYTES,
} from "../../custody/contract.ts";
import { llmOperations } from "../../llm/contract.ts";
import { LLM_PLATFORMS } from "../../llm/platforms.ts";
import { background } from "../../kernel/context.ts";
import { takeHandover } from "../worker/handover.ts";
import { httpTransport } from "../worker/transport.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import {
  INSTANCE_CONNECTION_INFO,
  WORKER_TOKEN_INFO,
  HANDOVER_TIMEOUT_MS,
  WorkerErrorCode,
  connectionPayloadSchema,
  workerOperations,
  workerTokenPayloadSchema,
} from "../../worker/contract.ts";
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
  sealJSON,
  type SealedObject,
} from "../../kernel/hpke.ts";
import { agentOperations, ChainLevel } from "../../agent/contract.ts";
import { missionOperations, Intent } from "../../mission/contract.ts";
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
import { createIdentity, createIdempotencyKey } from "../../kernel/identity.ts";
import { canonicalJSON, digest } from "../../kernel/json.ts";
import {
  deriveHandoverKeys,
  deriveSshSignKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
  HANDOVER_CIPHER,
  HANDOVER_NONCE_BYTES,
  HANDOVER_TAG_BYTES,
} from "../../kernel/handover.ts";
import {
  COVERING_WORKER_BINDINGS,
  enableCoveringAgents,
  FAKE_GITHUB_HOST_KEY,
  FAKE_GITHUB_HOST_KEY_FINGERPRINT,
  FAKE_SSH_CREDENTIAL,
  FAKE_SSH_HOST,
  gatewayFixture,
} from "./test-support.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import { generateSshKey, sshPublicKeyBlob } from "../../repository/ssh-key.ts";
import {
  knownHostsKeyBlob,
  sshSignatureVerifies,
  userAuthenticationData,
} from "../../repository/test-sshd.ts";

const SECRET = "test_handover-integration-secret-one";
const REFRESHED = "test_handover-integration-secret-two";
const ROTATED = "test_handover-integration-secret-three";
const FIRST_REVISION = 1;
const SECOND_SLOT = 1;
const HEAD_POSITION = 0;
const TWO_REVISIONS = 2;
const HTTP = "http";
const PROOF_FAILED = "gateway.invocation.execution_proof_failed";
const SIGN_REFUSED = "worker.ssh.sign_refused";
const SIGN_INVALID = "worker.ssh.sign_invalid";
const PLACEMENT_REFUSED = "worker.ssh.placement_refused";
const RELAY_INSTANCES = ["relay-a", "relay-b"];
const GENERAL_RESOURCE = "worker:kanthord:general";
const AUTHORIZATION_REFUSED = "project.authorization.refused";
const RSA_SHA2_256 = 2;
const INVALID_REPORT = "custody.handover.report_invalid";
const BODY_TOO_LARGE = "gateway.request.body_too_large";
const COPILOT = "github-copilot";
const LOGIN_COMPLETED = "completed";
const LOGIN_PENDING = "pending";
const MAX_REPORT_BYTES = 65534;
const OVERSIZED_REPORT_BYTES = 65538;
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
    assert.equal(answer.agents[0]!.position, HEAD_POSITION);
    assert.equal(answer.agents[0]!.level, ChainLevel.Binding);
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
      answer.agents[0]!.prompt.final.endsWith(
        `Instructions of repository repo:\n\nFollow repository conventions.\n\n${framing(SHIPPED_TEMPLATES, PromptConsumer.Worker)}`,
      ),
    );
    assert.ok(answer.agents[0]!.prompt.final.includes(SWE_AGENT_PROMPT));
    assert.deepEqual(answer.repositories[0], {
      binding_id: answer.repositories[0]!.binding_id,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      ssh_host_key: {
        known_hosts: `${FAKE_SSH_HOST} ${FAKE_GITHUB_HOST_KEY}\n`,
      },
      resource_identity: "repository:github:owner/repo",
      ssh_public_key: h.sshPublicKey,
      strategy: { base_branch: "main" },
      environment: null,
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
    const other = (
      await h.f.slotClient(h.execution.project_id, "general", SECOND_SLOT)
    ).token;
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
          fallback_configurations: [],
        },
      }),
    );
    assert.deepEqual(completed(await read()), before);
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
    const h = await setup(t, adapter, undefined, {
      workerName: "claude-code@1",
    });
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
  signal: AbortSignal,
) {
  assert.equal(credential.type, SecretShape.OAuth);
  const client = httpClient(llmOperations, f.endpoint, f.token);
  const pending = completed(
    await client.login(
      { params: {}, query: {}, body: { platform: COPILOT, name: "anthro-1" } },
      { idempotencyKey: createIdempotencyKey() },
    ),
  );
  for (;;) {
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
    await setImmediate(undefined, { signal });
  }
}

async function setup(
  t: TestContext,
  adapter: "direct" | "http",
  boundary?: Credential,
  setupOptions: {
    compatible?: boolean;
    noEntries?: boolean;
    instanceCount?: number;
    workerInstances?: readonly string[];
    workerName?: string;
    resourceBudget?: { turns: number; wall_time_ms: number };
    extraRepository?: boolean;
    handoverRefreshWaitMs?: number;
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
    fakeSlots: true,
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
    oauthProviders: oauth ? () => [offlineProvider(oauth)] : undefined,
    handoverRefreshWaitMs: setupOptions.handoverRefreshWaitMs,
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
    ? await loginCredential(f, oauth, t.signal)
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
  const sshRecord = completed(
    await call(repositoryOperations.ssh_key_create, {
      params: {},
      query: {},
      body: { name: FAKE_SSH_CREDENTIAL },
    }),
  );
  completed(
    await call(repositoryOperations.host_key_pin, {
      params: { host: FAKE_SSH_HOST },
      query: {},
      body: { fingerprint: FAKE_GITHUB_HOST_KEY_FINGERPRINT },
    }),
  );
  await enableCoveringAgents(
    { KANTHORD_ENDPOINT: f.endpoint, KANTHORD_TOKEN: f.token },
    { platform, credential: "anthro-1", configuration },
  );
  const instanceKeys = new Map<
    string,
    { id: string; private_key: Buffer; public_key: Buffer }
  >();
  for (const name of setupOptions.workerInstances ?? []) {
    const pair = await generateX25519KeyPair();
    const record = completed(
      await call(workerOperations["instance.create"], {
        params: {},
        query: {},
        body: {
          name,
          worker: "coder@1",
          public_key: pair.public_key.toString("base64url"),
        },
      }),
    );
    instanceKeys.set(name, {
      id: record.id,
      private_key: pair.private_key,
      public_key: pair.public_key,
    });
  }
  if (instanceKeys.size)
    completed(
      await call(llmOperations.create, {
        params: {},
        query: {},
        body: {
          name: "anthro-1",
          platform,
          metadata: null,
          holders: [...instanceKeys.keys()],
          secret: { key: SECRET },
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
  const repository = {
    kind: "repository" as const,
    config: {
      available: true,
      platform: "github" as const,
      address: "git@github.com:owner/repo.git",
      ssh_credential: FAKE_SSH_CREDENTIAL,
      strategy: { base_branch: "main" },
      credential: "github",
      prompts: { "swe@1": "Follow repository conventions." },
    },
  };
  const bindingSet = completed(
    await call(projectOperations["bindingSet.write"], {
      params: { project_id: projectId },
      query: {},
      body: {
        version: 1,
        bindings: {
          ...COVERING_WORKER_BINDINGS,
          repo: repository,
          ...(setupOptions.extraRepository
            ? {
                other: {
                  ...repository,
                  config: {
                    ...repository.config,
                    address: "git@github.com:owner/other.git",
                  },
                },
              }
            : {}),
          general: {
            kind: "worker",
            config: {
              worker: setupOptions.workerName ?? "coder@1",
              placement: setupOptions.workerName
                ? undefined
                : setupOptions.workerInstances
                  ? "worker"
                  : "server",
              instance_count: setupOptions.workerInstances
                ? undefined
                : (setupOptions.instanceCount ?? 1),
              worker_instances: setupOptions.workerInstances,
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
  const examine = completed(
    await call(missionOperations["node.create"], {
      params: { mission_id: mission.id },
      query: {},
      body: {
        filename: "examine-1.md",
        content: { ...CONTENT, intent: Intent.Examine },
        tasks: [],
        reason: "plan",
        expected_mission_version: 1,
      },
    }),
  );
  const implement = completed(
    await call(missionOperations["node.create"], {
      params: { mission_id: mission.id },
      query: {},
      body: {
        filename: "implement-1.md",
        content: {
          ...CONTENT,
          intent: Intent.Implement,
          bindings: [bindingSet.bindings.repo!.id],
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: 2,
      },
    }),
  );
  completed(
    await call(missionOperations["dependency.add"], {
      params: {
        node_id: examine.revisions[0]!.node_id,
        depends_on_id: implement.revisions[0]!.node_id,
      },
      query: {},
      body: {
        reason: "plan",
        expected_mission_version: implement.mission_version,
      },
    }),
  );
  const instanceTokens: string[] = [];
  for (const [name, key] of instanceKeys) {
    const worker = workerTokenPayloadSchema.parse(
      await openJSON(
        key.private_key,
        WORKER_TOKEN_INFO,
        key.id,
        completed(
          await call(workerOperations["instance.token"], {
            params: {},
            query: {},
            body: { instance_id: key.id },
          }),
        ).sealed,
      ),
    );
    const connected = completed(
      await call(
        workerOperations["instance.connect"],
        { params: {}, query: {}, body: { connection_name: name } },
        worker.token,
        { idempotencyKey: createIdempotencyKey() },
      ),
    );
    const payload = connectionPayloadSchema.parse(
      await openJSON(
        key.private_key,
        INSTANCE_CONNECTION_INFO,
        `${key.id}${connected.connection_id}`,
        connected.sealed,
      ),
    );
    const entry = payload.bindings.find(
      (item) =>
        item.project_id === projectId &&
        item.resource_identity === GENERAL_RESOURCE,
    );
    assert.ok(entry);
    instanceTokens.push(entry.token);
  }
  const token = setupOptions.workerName
    ? await f.machineToken(projectId, "general", "general-a")
    : instanceTokens.length
      ? instanceTokens[0]!
      : (await f.slotClient(projectId, "general")).token;
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
            resource_identity: GENERAL_RESOURCE,
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
  const clientSecret = deriveClientSecret(
    f.config.master_key,
    f.config.gateway.auth.version,
    claims.sub,
  );
  const keys = deriveHandoverKeys(clientSecret);
  const signKeys = deriveSshSignKeys(clientSecret);
  const sign = (
    request: unknown,
    executionId = execution.execution_id,
    idempotencyKey = createIdempotencyKey(),
    auth = token,
  ) =>
    call(
      workerOperations["ssh.sign"],
      {
        params: {},
        query: {},
        body: {
          execution_id: executionId,
          ...sealEnvelope(
            signKeys.request,
            handoverAad(executionId, runtimeIdentity),
            request,
          ),
        },
      },
      auth,
      { idempotencyKey },
    );
  const openSigned = (envelope: ReturnType<typeof sealEnvelope>) =>
    sshSignAnswerSchema.parse(
      openEnvelope(
        signKeys.answer,
        handoverAad(execution.execution_id, runtimeIdentity),
        envelope,
      ),
    );
  const handover = (
    executionId = execution.execution_id,
    idempotencyKey = createIdempotencyKey(),
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
    idempotencyKey = createIdempotencyKey(),
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
    plainHandoverPayloadSchema.parse(
      openEnvelope(
        keys.handover,
        handoverAad(executionId, runtimeIdentity),
        envelope,
      ),
    );
  const openSealed = (envelope: ReturnType<typeof sealEnvelope>) =>
    handoverPayloadSchema.parse(
      openEnvelope(
        keys.handover,
        handoverAad(execution.execution_id, runtimeIdentity),
        envelope,
      ),
    );
  const copyAad = (holder: string) => {
    const pair = instanceKeys.get(holder);
    assert.ok(pair);
    return credentialSealAad({
      name: "anthro-1",
      platform,
      holder,
      sealed_to: keyFingerprint(pair.public_key),
    });
  };
  const openCopy = async (holder: string, sealed: SealedObject) => {
    try {
      return await openJSON(
        instanceKeys.get(holder)!.private_key,
        CREDENTIAL_SEAL_INFO,
        copyAad(holder),
        sealed,
      );
    } catch {
      return null;
    }
  };
  const sealCopy = (holder: string, secret: unknown) =>
    sealJSON(
      instanceKeys.get(holder)!.public_key,
      CREDENTIAL_SEAL_INFO,
      copyAad(holder),
      secret,
    );
  return {
    f,
    call,
    token,
    keys,
    openSealed,
    openCopy,
    sealCopy,
    runtime_identity: runtimeIdentity,
    execution,
    pull,
    handover,
    report,
    release,
    read,
    open,
    sign,
    openSigned,
    instanceTokens,
    instanceKeys,
    bindings: bindingSet.bindings,
    sshPublicKey: String(sshRecord.revisions[0]!.metadata!.public_key),
    sshCredentialId: sshRecord.revisions[0]!.id,
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
            { idempotencyKey: createIdempotencyKey() },
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

async function workerBoundaryRoundTrip(
  h: Awaited<ReturnType<typeof setup>>,
  signal: AbortSignal,
) {
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
          h.f.config.gateway.auth.version,
          claims.sub,
        ),
        executionId: h.execution.execution_id,
        runtimeIdentity: h.runtime_identity,
      }),
    ],
    { signal, maxBuffer: MAX_CHILD_BUFFER },
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
    await workerBoundaryRoundTrip(h, t.signal);
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
        { identity, idempotencyKey: createIdempotencyKey() },
      ),
      HttpStatus.BadRequest,
      INVALID_REPORT,
    );
    refused(
      await httpClient(workerOperations, h.f.endpoint, h.token).credential(
        { params: {}, query: {}, body },
        { idempotencyKey: createIdempotencyKey() },
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
    const key = createIdempotencyKey();
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
      await h.handover(
        h.execution.execution_id,
        createIdempotencyKey(),
        h.f.token,
      ),
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
    const key = createIdempotencyKey();
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

for (const adapter of ["direct", "http"] as const) {
  test(`${adapter} a worker placement handover answers a sealed copy that the instance key opens, then worker.ssh.sign signs for a node binding, pins at first use, refuses others and answers a replay with 409`, async (t) => {
    const h = await setup(t, adapter, undefined, {
      extraRepository: true,
      workerInstances: RELAY_INSTANCES,
    });
    const setupRead = () =>
      h.call(
        workerOperations["execution.setup.get"],
        {
          params: { execution_id: h.execution.execution_id },
          query: {},
          body: null,
        },
        h.token,
      );
    refused(
      await setupRead(),
      HttpStatus.Conflict,
      "worker.execution.credential_not_pinned",
    );
    const handed = h.openSealed(completed(await h.handover()));
    assert.deepEqual(handed.ssh_identities, []);
    const [item] = handed.items;
    assert.ok(item && "sealed" in item);
    assert.deepEqual(
      [item.name, item.platform, item.provider_id],
      ["anthro-1", "anthropic", "anthropic"],
    );
    const [relayA, relayB] = RELAY_INSTANCES as [string, string];
    assert.deepEqual(await h.openCopy(relayA, item.sealed), { key: SECRET });
    assert.equal(await h.openCopy(relayB, item.sealed), null);
    assert.equal(
      completed(await setupRead()).agents[0]!.credential_id,
      item.credential_id,
    );
    assert.equal(
      completed(
        await h.report({
          credential_id: item.credential_id,
          digest: digest(item.sealed),
          sealed: await h.sealCopy(relayA, { key: REFRESHED }),
        }),
      ),
      null,
    );
    const [refreshed] = h.openSealed(completed(await h.handover())).items;
    assert.ok(refreshed && "sealed" in refreshed);
    assert.deepEqual(await h.openCopy(relayA, refreshed.sealed), {
      key: REFRESHED,
    });
    const repo = h.bindings.repo!.id;
    const key = sshPublicKeyBlob(h.sshPublicKey);
    const hostKey = knownHostsKeyBlob(FAKE_GITHUB_HOST_KEY);
    const data = userAuthenticationData({ key, hostKey });
    const request = {
      binding_id: repo,
      data: data.toString("base64"),
      flags: RSA_SHA2_256,
    };
    const idempotencyKey = createIdempotencyKey();
    const signed = h.openSigned(
      completed(
        await h.sign(request, h.execution.execution_id, idempotencyKey),
      ),
    );
    assert.ok(
      sshSignatureVerifies(
        h.sshPublicKey,
        data,
        Buffer.from(signed.signature, "base64"),
      ),
    );
    const pins = h.f.store.database
      .prepare("SELECT credentials FROM scheduler_execution WHERE id = ?")
      .get(h.execution.execution_id) as { credentials: string };
    assert.ok(pins.credentials.includes(h.sshCredentialId));
    const replay = await h.sign(
      request,
      h.execution.execution_id,
      idempotencyKey,
    );
    assert(replay.type === OperationResultType.Failure);
    assert.equal(replay.status, HttpStatus.Conflict);
    assert.equal(JSON.stringify(replay).includes("ciphertext"), false);
    refused(
      await h.sign({ ...request, binding_id: h.bindings.other!.id }),
      HttpStatus.Forbidden,
      AUTHORIZATION_REFUSED,
    );
    for (const [payload, reason] of [
      [
        userAuthenticationData({ key, user: "root" }),
        "not_user_authentication",
      ],
      [
        userAuthenticationData({
          key: sshPublicKeyBlob(generateSshKey("other").public_key),
        }),
        "key_mismatch",
      ],
      [
        userAuthenticationData({ key, hostKey: Buffer.from("other") }),
        "host_key_mismatch",
      ],
    ] as const) {
      const answer = await h.sign({
        ...request,
        data: payload.toString("base64"),
      });
      refused(answer, HttpStatus.BadRequest, SIGN_REFUSED);
      assert(answer.type === OperationResultType.Failure);
      assert.deepEqual(answer.error.error.details, { reason });
    }
    refused(
      await h.call(
        workerOperations["ssh.sign"],
        {
          params: {},
          query: {},
          body: {
            execution_id: h.execution.execution_id,
            nonce: "AAAA",
            ciphertext: "AAAA",
          },
        },
        h.token,
      ),
      HttpStatus.BadRequest,
      SIGN_INVALID,
    );
    const other = h.instanceTokens[1]!;
    completed(await h.call(workerOperations.register, NO_INPUT, other));
    refused(
      await h.sign(
        request,
        h.execution.execution_id,
        createIdempotencyKey(),
        other,
      ),
      HttpStatus.Forbidden,
      PROOF_FAILED,
    );
    completed(await h.release());
    refused(await h.sign(request), HttpStatus.Forbidden, PROOF_FAILED);
    assert.equal(h.f.logs.join("").includes("PRIVATE KEY"), false);
  });

  test(`${adapter} worker.ssh.sign refuses a server slot with a live claim`, async (t) => {
    const h = await setup(t, adapter);
    const request = {
      binding_id: h.bindings.repo!.id,
      data: userAuthenticationData({
        key: sshPublicKeyBlob(h.sshPublicKey),
      }).toString("base64"),
      flags: RSA_SHA2_256,
    };
    const answer = await h.sign(request);
    refused(answer, HttpStatus.Forbidden, PLACEMENT_REFUSED);
    assert(answer.type === OperationResultType.Failure);
    assert.deepEqual(answer.error.error.details, { placement: "server" });
    const pins = h.f.store.database
      .prepare("SELECT credentials FROM scheduler_execution WHERE id = ?")
      .get(h.execution.execution_id) as { credentials: string };
    assert.equal(pins.credentials.includes(h.sshCredentialId), false);
  });
}

test("HTTP handover enforces its byte limit before body parsing", async (t) => {
  const h = await setup(t, "http");
  const response = await fetch(`${h.f.endpoint}/api/worker/handover`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${h.token}`,
      "content-type": "application/json",
      "idempotency-key": createIdempotencyKey(),
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

const REFRESH_WAIT_MS = 200;
const NO_ANSWER = 0;
const STORED_OAUTH: Credential = {
  type: SecretShape.OAuth,
  refresh: "test_stored-refresh",
  access: "test_stored-access",
  expires: 1700000000000,
};
const ROTATED_OAUTH: Credential = {
  type: SecretShape.OAuth,
  refresh: "test_rotated-refresh",
  access: "test_rotated-access",
  expires: 4102444800000,
};

test("http handover answers a retryable refusal before the route timer while a refresh is in flight, and the worker retries to the envelope", async (t) => {
  const h = await setup(t, HTTP, STORED_OAUTH, {
    handoverRefreshWaitMs: REFRESH_WAIT_MS,
  });
  const refreshStore = h.f.store.transaction((tx) =>
    h.f.custody.checkMaterial(tx, { platforms: LLM_PLATFORMS }, "anthro-1"),
  )!.refreshStore!;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refreshing = refreshStore.modify(COPILOT, async () => {
    await gate;
    return ROTATED_OAUTH;
  });
  await setImmediate();
  const pins = () =>
    h.f.store.database
      .prepare("SELECT credentials FROM scheduler_execution WHERE id = ?")
      .get(h.execution.execution_id);
  const before = pins();
  const started = Date.now();
  refused(
    await h.handover(),
    HttpStatus.ServiceUnavailable,
    WorkerErrorCode.HandoverRefreshInFlight,
  );
  assert.ok(Date.now() - started < HANDOVER_TIMEOUT_MS);
  await setImmediate();
  assert.deepEqual(pins(), before);
  const claims = JSON.parse(
    Buffer.from(h.token.split(".")[1]!, "base64url").toString("utf8"),
  );
  const api = httpTransport(h.f.endpoint, h.token);
  const handover = api.worker.handover.bind(api.worker);
  const statuses: number[] = [];
  let refusedOnce = () => {};
  const firstRefusal = new Promise<void>((resolve) => {
    refusedOnce = resolve;
  });
  t.mock.method(
    api.worker,
    "handover",
    async (...args: Parameters<typeof handover>) => {
      const answer = await handover(...args);
      statuses.push(
        answer.type === OperationResultType.Indeterminate
          ? NO_ANSWER
          : answer.status,
      );
      refusedOnce();
      return answer;
    },
  );
  const pending = takeHandover({
    api,
    claim: h.execution,
    clientSecret: deriveClientSecret(
      h.f.config.master_key,
      h.f.config.gateway.auth.version,
      claims.sub,
    ),
    context: background,
  });
  await firstRefusal;
  assert.deepEqual(statuses, [HttpStatus.ServiceUnavailable]);
  assert.deepEqual(pins(), before);
  release();
  assert.deepEqual(await refreshing, ROTATED_OAUTH);
  const taken = await pending;
  assert.deepEqual(statuses, [HttpStatus.ServiceUnavailable, HttpStatus.OK]);
  const item = taken.credentials.items[0]!;
  assert.deepEqual(await item.store.read(item.provider_id), ROTATED_OAUTH);
  assert.notDeepEqual(pins(), before);
  taken.credentials.discard();
});
