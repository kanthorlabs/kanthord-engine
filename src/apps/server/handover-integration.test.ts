import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  EXECUTION_CREDENTIAL_MAX_BYTES,
  handoverPayloadSchema,
  leasePayloadSchema,
  plainHandoverPayloadSchema,
  SecretShape,
  sshSignAnswerSchema,
} from "../../custody/contract.ts";
import { llmOperations } from "../../llm/contract.ts";
import { LLM_PLATFORMS } from "../../llm/platforms.ts";
import { background } from "../../kernel/context.ts";
import { takeHandover } from "../worker/handover.ts";
import { httpTransport, observedTransport } from "../worker/transport.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { stopAfter } from "../../kernel/stop-test-support.ts";
import {
  RepositoryFileState,
  repositoryOperations,
} from "../../repository/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import {
  connectionPayloadSchema,
  HANDOVER_TIMEOUT_MS,
  HEAD_COMMIT_SUBJECT,
  INSTANCE_CONNECTION_INFO,
  InstancePlacement,
  type PromptBase,
  withoutEnvironmentMaps,
  WORKER_TOKEN_INFO,
  WorkerErrorCode,
  workerOperations,
  workerTokenPayloadSchema,
} from "../../worker/contract.ts";
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
  type SealedObject,
  sealJSON,
} from "../../kernel/hpke.ts";
import {
  AgentErrorCode,
  agentOperations,
  ChainLevel,
  PromptPart,
} from "../../agent/contract.ts";
import {
  AssetKind,
  Intent,
  missionOperations,
} from "../../mission/contract.ts";
import {
  AdvancingProviderFailure,
  ExecutionStopReason,
  schedulerOperations,
  WorkPullKind,
} from "../../scheduler/contract.ts";
import {
  type ClientOptions,
  type Operation,
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { SWE_AGENT_PROMPT } from "../../agent/prompt-assets.ts";
import { framing, PromptConsumer } from "../../agent/prompt-render.ts";
import { createIdempotencyKey, createIdentity } from "../../kernel/identity.ts";
import { canonicalJSON, digest } from "../../kernel/json.ts";
import {
  deriveHandoverKeys,
  deriveSshSignKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
} from "../../kernel/handover.ts";
import {
  FAKE_COMMIT,
  fakeRepositoryFiles,
} from "./container-fakes-test-support.ts";
import { environment, kanthord } from "./cli-test-support.ts";
import { tasksRun } from "../cli/worker-tasks.ts";
import {
  readJson,
  runOptions,
  sourceRepository,
  commandRun as tasksCommandRun,
  TEST_TIMEOUT_MS,
} from "../cli/tasks-test-support.ts";
import { RunEndKind, TasksExit } from "../worker/index.ts";
import {
  fauxAssistantMessage,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import { temporary } from "../../kernel/test-support.ts";
import { packageVersion } from "../../kernel/version.ts";
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
} from "../../repository/sshd-test-support.ts";

const WORKER_MACHINE = "workstation";
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
const COPILOT = "github-copilot";
const LOGIN_COMPLETED = "completed";
const LOGIN_PENDING = "pending";
const MAX_REPORT_BYTES = 65534;
const OVERSIZED_REPORT_BYTES = 65538;
const MAX_CHILD_BUFFER = 1024;
const EMPTY_OUTPUT = "";
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
        `Binding prompt of repository repo:\n\nFollow repository conventions.\n\n${framing(SHIPPED_TEMPLATES, PromptConsumer.Worker)}`,
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

  test(`${adapter} a unit record put of a live execution replaces the record of the unit, the setup answers it, and an unknown unit or binding and a foreign or closed execution are refused`, async (t) => {
    const h = await setup(t, adapter, undefined, { instanceCount: 2 });
    const executionId = h.execution.execution_id;
    const record = (unitId: string, bindingId: string, commit: string) => ({
      unit_id: unitId,
      content_digest: digest({ unit: unitId, commit }),
      commits: [{ binding_id: bindingId, commit }],
    });
    const put = (body: ReturnType<typeof record>, token = h.token) =>
      h.call(
        workerOperations["execution.unit_record.put"],
        { params: { execution_id: executionId }, query: {}, body },
        token,
        { idempotencyKey: createIdempotencyKey() },
      );
    const setupRecords = async () =>
      completed(
        await h.call(
          workerOperations["execution.setup.get"],
          { params: { execution_id: executionId }, query: {}, body: null },
          h.token,
        ),
      ).unit_records;
    const nodeId = h.execution.node_id;
    const bindingId = h.bindings.repo!.id;
    completed(await h.handover());
    assert.deepEqual(await setupRecords(), []);
    const first = record(nodeId, bindingId, PINNED_HEAD);
    assert.deepEqual(completed(await put(first)), first);
    assert.deepEqual(await setupRecords(), [first]);
    const replaced = record(nodeId, bindingId, MOVED_HEAD);
    completed(await put(replaced));
    assert.deepEqual(await setupRecords(), [replaced]);
    refused(
      await put(record(createIdentity("task"), bindingId, PINNED_HEAD)),
      HttpStatus.Conflict,
      WorkerErrorCode.UnitRecordUnitUnknown,
    );
    refused(
      await put(record(nodeId, createIdentity("binding"), PINNED_HEAD)),
      HttpStatus.Conflict,
      WorkerErrorCode.UnitRecordBindingUnknown,
    );
    const other = (
      await h.f.slotClient(h.execution.project_id, "general", SECOND_SLOT)
    ).token;
    completed(await h.call(workerOperations.register, NO_INPUT, other));
    refused(await put(first, other), HttpStatus.Forbidden, PROOF_FAILED);
    completed(await h.release());
    refused(await put(first), HttpStatus.Forbidden, PROOF_FAILED);
    assert.deepEqual(
      h.f.store.database
        .prepare(
          "SELECT unit_id, commits FROM worker_unit_record WHERE node_id = ?",
        )
        .all(nodeId)
        .map((row) => ({ ...row })),
      [{ unit_id: nodeId, commits: canonicalJSON(replaced.commits) }],
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
    promptBase?: PromptBase;
    repositoryFiles?: ReturnType<typeof fakeRepositoryFiles>;
    instructionFile?: string;
    implementBindsOther?: boolean;
    secondNode?: boolean;
    environment?: Record<string, unknown>;
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
    promptBase: setupOptions.promptBase,
    repositoryFiles: setupOptions.repositoryFiles,
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
  const machineKey = await generateX25519KeyPair();
  if (setupOptions.workerInstances?.length)
    completed(
      await call(workerOperations["machine.create"], {
        params: {},
        query: {},
        body: {
          name: WORKER_MACHINE,
          public_key: machineKey.public_key.toString("base64url"),
        },
      }),
    );
  for (const name of setupOptions.workerInstances ?? []) {
    const pair = await generateX25519KeyPair();
    const record = completed(
      await call(workerOperations["instance.create"], {
        params: {},
        query: {},
        body: {
          name,
          worker: "coder@1",
          placement: InstancePlacement.Worker,
          machine: WORKER_MACHINE,
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
  const serverInstances =
    setupOptions.workerName || setupOptions.workerInstances
      ? []
      : Array.from(
          { length: setupOptions.instanceCount ?? 1 },
          (_value, index) => `server-${index + 1}`,
        );
  for (const name of serverInstances)
    completed(
      await call(workerOperations["instance.create"], {
        params: {},
        query: {},
        body: { name, worker: "coder@1", placement: InstancePlacement.Server },
      }),
    );
  if (instanceKeys.size && oauth) {
    const sealedTo = keyFingerprint(machineKey.public_key);
    const sealed = await sealJSON(
      machineKey.public_key,
      CREDENTIAL_SEAL_INFO,
      credentialSealAad({
        name: "anthro-1",
        platform,
        holder: WORKER_MACHINE,
        sealed_to: sealedTo,
      }),
      { refresh: oauth.refresh, access: oauth.access, expires: oauth.expires },
    );
    f.store.transaction((tx) =>
      f.custody.createLoginRevision(
        tx,
        { platforms: LLM_PLATFORMS, instance_copies: true },
        "anthro-1",
        platform,
        { holder: WORKER_MACHINE, sealed, sealed_to: sealedTo },
        Date.now(),
      ),
    );
  } else if (instanceKeys.size)
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
      ...(setupOptions.environment === undefined
        ? {}
        : { environment: setupOptions.environment }),
      prompts: {
        ...(setupOptions.instructionFile === undefined
          ? {}
          : { instruction_file: setupOptions.instructionFile }),
        agents: { "swe@1": "Follow repository conventions." },
      },
    },
  };
  const bindingsOf = (generalInstances: readonly string[]) => ({
    ...COVERING_WORKER_BINDINGS,
    repo: repository,
    ...(setupOptions.extraRepository
      ? {
          other: {
            ...repository,
            config: {
              ...repository.config,
              address: "git@github.com:owner/other.git",
              prompts: {},
            },
          },
        }
      : {}),
    general: {
      kind: "worker" as const,
      config: {
        worker: setupOptions.workerName ?? "coder@1",
        ...(setupOptions.workerName
          ? { instance_count: setupOptions.instanceCount ?? 1 }
          : { worker_instances: [...generalInstances] }),
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
  });
  let bindingSetVersion = 1;
  const writeBindings = async (generalInstances: readonly string[]) => {
    const written = completed(
      await call(projectOperations["bindingSet.write"], {
        params: { project_id: projectId },
        query: {},
        body: {
          version: bindingSetVersion,
          bindings: bindingsOf(generalInstances),
        },
      }),
    );
    bindingSetVersion = written.binding_set_version;
    return written;
  };
  const bindingSet = await writeBindings(
    setupOptions.workerInstances ?? serverInstances,
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
          bindings: [
            bindingSet.bindings.repo!.id,
            ...(setupOptions.implementBindsOther
              ? [bindingSet.bindings.other!.id]
              : []),
          ],
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: 2,
      },
    }),
  );
  const dependency = completed(
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
  if (setupOptions.secondNode)
    completed(
      await call(missionOperations["node.create"], {
        params: { mission_id: mission.id },
        query: {},
        body: {
          filename: "implement-2.md",
          content: {
            ...CONTENT,
            intent: Intent.Implement,
            bindings: [bindingSet.bindings.repo!.id],
          },
          tasks: [],
          reason: "plan",
          expected_mission_version: dependency.mission_version,
        },
      }),
    );
  const instanceTokens: string[] = [];
  const workerTokens: string[] = [];
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
    workerTokens.push(worker.token);
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
  const clientSecretOf = (bearer: string) =>
    deriveClientSecret(
      f.config.master_key,
      f.config.gateway.auth.version,
      JSON.parse(
        Buffer.from(bearer.split(".")[1]!, "base64url").toString("utf8"),
      ).sub,
    );
  const claimSecond = async () => {
    const other = (await f.slotClient(projectId, "general", SECOND_SLOT)).token;
    const registered = completed(
      await call(workerOperations.register, NO_INPUT, other),
    );
    const pulled = completed(
      await call(
        schedulerOperations.workPull,
        {
          params: {},
          query: {},
          body: {
            resource_identity: GENERAL_RESOURCE,
            runtime_identity: registered.runtime_identity,
          },
        },
        other,
      ),
    );
    assert(pulled.kind === WorkPullKind.Claimed);
    return { token: other, execution: pulled.execution };
  };
  const claimOnInstance = async (index: number) => {
    const instanceToken = instanceTokens[index]!;
    const registered = completed(
      await call(workerOperations.register, NO_INPUT, instanceToken),
    );
    const pulled = completed(
      await call(
        schedulerOperations.workPull,
        {
          params: {},
          query: {},
          body: {
            resource_identity: GENERAL_RESOURCE,
            runtime_identity: registered.runtime_identity,
          },
        },
        instanceToken,
      ),
    );
    assert(pulled.kind === WorkPullKind.Claimed);
    return {
      token: instanceToken,
      runtime_identity: registered.runtime_identity,
      execution: pulled.execution,
    };
  };
  return {
    f,
    call,
    token,
    clientSecretOf,
    claimSecond,
    claimOnInstance,
    machineKey,
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
    reviseInstances: writeBindings,
    read,
    open,
    sign,
    openSigned,
    instanceTokens,
    workerTokens,
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
      HttpStatus.BadRequest,
      INVALID_REPORT,
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

  test(`${adapter} a revision to an empty instance list during an execution keeps its handover and inference grant and a new pull gets no work`, async (t) => {
    const h = await setup(t, adapter);
    await h.reviseInstances([]);
    assert.equal(
      h.open(completed(await h.handover())).items[0]!.credential_id,
      h.credentialId,
    );
    completed(await h.release());
    const pull = completed(
      await h.call(
        schedulerOperations.workPull,
        {
          params: {},
          query: {},
          body: {
            resource_identity: GENERAL_RESOURCE,
            runtime_identity: h.runtime_identity,
          },
        },
        h.token,
      ),
    );
    assert.equal(pull.kind, WorkPullKind.NoWork);
  });

  test(`${adapter} a revision to an empty instance list during a worker instance execution keeps its handover of the copy of the instance`, async (t) => {
    const h = await setup(t, adapter, undefined, {
      workerInstances: RELAY_INSTANCES,
    });
    await h.reviseInstances([]);
    const [item] = h.openSealed(completed(await h.handover())).items;
    assert.ok(item && "sealed" in item);
    const [relayA, relayB] = RELAY_INSTANCES as [string, string];
    assert.deepEqual(await h.openCopy(relayA, item.sealed), { key: SECRET });
    assert.equal(await h.openCopy(relayB, item.sealed), null);
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

const PINNED_HEAD = "a".repeat(40);
const MOVED_HEAD = "b".repeat(40);
const FIRST_HEAD_READ = 1;
const CONCURRENT_HANDOVERS = 2;

function storedPromptCommits(
  h: Awaited<ReturnType<typeof setup>>,
): string | null {
  return (
    h.f.store.database
      .prepare(
        "SELECT prompt_commits FROM mission_attempt WHERE node_id = ? AND attempt = ?",
      )
      .get(h.execution.node_id, h.execution.attempt) as {
      prompt_commits: string | null;
    }
  ).prompt_commits;
}

test("the first handover of an attempt pins its prompt commits and a later execution of the attempt reads no head", async (t) => {
  let reads = 0;
  const h = await setup(t, "direct", undefined, {
    promptBase: {
      instructionBindingsOf: (_tx, bindingIds) => [...bindingIds],
      instructionFileOf: async () => null,
      baseCommitOf: async () => {
        reads++;
        return reads === FIRST_HEAD_READ ? PINNED_HEAD : MOVED_HEAD;
      },
    },
  });
  assert.equal(storedPromptCommits(h), null);
  completed(await h.handover());
  const pinned = canonicalJSON([
    { binding_id: h.bindings.repo!.id, commit: PINNED_HEAD },
  ]);
  assert.equal(storedPromptCommits(h), pinned);
  completed(await h.release());
  const next = await h.pull();
  assert.notEqual(next.execution_id, h.execution.execution_id);
  assert.equal(next.node_id, h.execution.node_id);
  assert.equal(next.attempt, h.execution.attempt);
  completed(await h.handover(next.execution_id));
  assert.equal(reads, FIRST_HEAD_READ);
  assert.equal(storedPromptCommits(h), pinned);
});

const PUSHED_HEAD = "c".repeat(40);
const LIVE_BASE_HEAD = "d".repeat(40);
const PUSHED_OTHER_HEAD = "e".repeat(40);
const ENV_CANARY = "seed-environment-canary-0123456789";
const ENV_REMOTE_CANARY = "seed-remote-canary-0123456789";
const BUILD_ARGS_CANARY = "seed-build-canary-0123456789";
const CLOSED_STATE = "Completed";
const SEED_ENVIRONMENT = {
  image: "mcr.microsoft.com/devcontainers/base:ubuntu",
  build: { dockerfile: "Dockerfile", args: { CANARY: BUILD_ARGS_CANARY } },
  containerEnv: { SEED_CANARY: ENV_CANARY },
  remoteEnv: { SEED_REMOTE: ENV_REMOTE_CANARY },
};
const AGENT_PROMPT = "agent.prompt";
const NO_ROWS = 0;

type SeedHarness = Awaited<ReturnType<typeof setup>>;

function seedInput(executionId: string) {
  return { params: { execution_id: executionId }, query: {}, body: null };
}

function seedOf(h: SeedHarness, executionId: string, token = h.f.token) {
  return h.call(
    workerOperations["execution.seed.get"],
    seedInput(executionId),
    token,
  );
}

function promptSpans(h: SeedHarness): number {
  return (
    h.f.trackingStore.database
      .prepare(
        "SELECT COUNT(*) AS count FROM tracking_span WHERE operation = ?",
      )
      .get(AGENT_PROMPT) as { count: number }
  ).count;
}

function assertNoSecret(text: string, secrets: readonly string[]): void {
  for (const secret of secrets)
    assert.equal(text.includes(secret), false, secret);
}

async function submitHeads(
  h: SeedHarness,
  heads: Record<string, string>,
): Promise<void> {
  completed(
    await h.call(
      missionOperations["evidence.submit"],
      {
        params: { node_id: h.execution.node_id },
        query: {},
        body: {
          execution_id: h.execution.execution_id,
          attempt: h.execution.attempt,
          node_revision: h.execution.pinned_revision,
          subject: HEAD_COMMIT_SUBJECT,
          assets: Object.entries(heads).map(([binding_id, commit]) => ({
            kind: AssetKind.Repository,
            address: { kind: AssetKind.Repository, binding_id, commit },
          })),
        },
      },
      h.token,
      { idempotencyKey: createIdempotencyKey() },
    ),
  );
}

for (const adapter of ["direct", "http"] as const)
  test(`${adapter} the seed export answers the setup of execution.setup.get with no environment value before the first setup read, the attempt pin or else the live base, then the pushed head of the execution and of an earlier execution, and refuses a client connection token, an unknown execution and a closed node`, async (t) => {
    let base = PINNED_HEAD;
    let instructed = "";
    const h = await setup(t, adapter, undefined, {
      extraRepository: true,
      implementBindsOther: true,
      environment: SEED_ENVIRONMENT,
      promptBase: {
        instructionBindingsOf: (_tx, bindingIds) =>
          bindingIds.filter((bindingId) => bindingId === instructed),
        instructionFileOf: async () => null,
        baseCommitOf: async () => base,
      },
    });
    const repo = h.bindings.repo!.id;
    const other = h.bindings.other!.id;
    instructed = repo;
    const executionId = h.execution.execution_id;
    completed(await h.handover());
    base = LIVE_BASE_HEAD;
    const first = completed(await seedOf(h, executionId));
    assert.equal(promptSpans(h), NO_ROWS);
    assert.deepEqual(first.heads, {
      [repo]: PINNED_HEAD,
      [other]: LIVE_BASE_HEAD,
    });
    base = MOVED_HEAD;
    const served = completed(
      await h.call(
        workerOperations["execution.setup.get"],
        seedInput(executionId),
        h.token,
      ),
    );
    assert.ok(JSON.stringify(served).includes(ENV_CANARY));
    assert.ok(JSON.stringify(served).includes(BUILD_ARGS_CANARY));
    assert.deepEqual(first.setup, withoutEnvironmentMaps(served));
    const seed = completed(await seedOf(h, executionId));
    assert.deepEqual(seed.setup, first.setup);
    assert.deepEqual(seed.claim, {
      execution_id: executionId,
      node_id: h.execution.node_id,
      attempt: h.execution.attempt,
      pinned_revision: h.execution.pinned_revision,
      node_branch: h.execution.node_branch,
      created_at: h.execution.created_at,
      expired_at: h.execution.expired_at,
      trace_id: h.execution.trace_id,
      root_span_id: h.execution.root_span_id,
    });
    assert.equal(seed.revision.node_id, h.execution.node_id);
    assert.equal(seed.revision.revision, h.execution.pinned_revision);
    assert.deepEqual(seed.heads, { [repo]: PINNED_HEAD, [other]: MOVED_HEAD });
    const secrets = [
      ENV_CANARY,
      ENV_REMOTE_CANARY,
      BUILD_ARGS_CANARY,
      SECRET,
      h.token,
      h.clientSecretOf(h.token),
      "ssh_identities",
      "PRIVATE KEY",
    ];
    assertNoSecret(JSON.stringify([first, seed]), secrets);
    const pushed = { [repo]: PUSHED_HEAD, [other]: PUSHED_OTHER_HEAD };
    await submitHeads(h, pushed);
    completed(await h.release());
    const ended = completed(await seedOf(h, executionId));
    assert.deepEqual(ended.heads, pushed);
    assert.deepEqual(ended.setup, seed.setup);
    const next = await h.pull();
    assert.notEqual(next.execution_id, executionId);
    assert.equal(next.node_branch, h.execution.node_branch);
    completed(await h.handover(next.execution_id));
    const later = completed(await seedOf(h, next.execution_id));
    assert.deepEqual(later.heads, pushed);
    assertNoSecret(JSON.stringify([ended, later]), secrets);
    const reference = await h.call(
      schedulerOperations.executionGet,
      seedInput(executionId),
      h.token,
    );
    assert.ok(reference.type === OperationResultType.Failure);
    refused(
      await seedOf(h, executionId, h.token),
      reference.status,
      reference.error.error.code,
    );
    refused(
      await seedOf(h, createIdentity("execution")),
      HttpStatus.NotFound,
      "scheduler.execution.not_found",
    );
    h.f.store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(CLOSED_STATE, h.execution.node_id);
    refused(
      await seedOf(h, executionId),
      HttpStatus.Conflict,
      WorkerErrorCode.ExecutionSeedUnavailable,
    );
  });

const SEED_REFRESH = "test_seed-oauth-refresh-0123456789";
const SEED_ACCESS = "test_seed-oauth-access-0123456789";
const SEED_OAUTH: Credential = {
  type: SecretShape.OAuth,
  refresh: SEED_REFRESH,
  access: SEED_ACCESS,
  expires: 4102444800000,
};

test("the seed export of an OAuth credential holds no access token, no refresh token and no worker token", async (t) => {
  const h = await setup(t, "http", SEED_OAUTH);
  completed(await h.handover());
  const seed = completed(await seedOf(h, h.execution.execution_id));
  assertNoSecret(JSON.stringify(seed), [
    SEED_ACCESS,
    SEED_REFRESH,
    h.token,
    h.clientSecretOf(h.token),
  ]);
});

for (const adapter of ["direct", "http"] as const)
  test(`${adapter} the seed export refuses the instance worker token and holds no worker token`, async (t) => {
    const h = await setup(t, adapter, undefined, {
      workerInstances: RELAY_INSTANCES,
    });
    const [workerToken] = h.workerTokens;
    assert.ok(workerToken);
    const reference = await h.call(
      schedulerOperations.executionGet,
      seedInput(h.execution.execution_id),
      workerToken,
    );
    assert.ok(reference.type === OperationResultType.Failure);
    refused(
      await seedOf(h, h.execution.execution_id, workerToken),
      reference.status,
      reference.error.error.code,
    );
    completed(await h.handover());
    const seed = completed(await seedOf(h, h.execution.execution_id));
    assertNoSecret(JSON.stringify(seed), [
      SECRET,
      ...h.workerTokens,
      ...h.instanceTokens,
    ]);
  });

test("the seed read of an ended execution with an undrained older revision ends no revision, stores no prompt span and claims no environment, and a revoked pinned revision answers 409", async (t) => {
  const h = await setup(t, "direct");
  completed(await h.handover());
  completed(
    await h.call(llmOperations.rotate, {
      params: { credential_name: "anthro-1" },
      query: {},
      body: { expected_revision: FIRST_REVISION, secret: { key: ROTATED } },
    }),
  );
  h.f.store.database
    .prepare("UPDATE scheduler_execution SET ended_at = ? WHERE id = ?")
    .run(Date.now(), h.execution.execution_id);
  const revisions = () =>
    h.f.store.database
      .prepare("SELECT id, ended_at FROM credential ORDER BY id")
      .all();
  const before = revisions();
  const claimed = t.mock.method(h.f.project, "environmentClaimed");
  completed(await seedOf(h, h.execution.execution_id));
  assert.deepEqual(revisions(), before);
  assert.equal(promptSpans(h), NO_ROWS);
  assert.equal(claimed.mock.callCount(), NO_ROWS);
  completed(
    await h.call(llmOperations.revoke, {
      params: { credential_name: "anthro-1", revision: FIRST_REVISION },
      query: {},
      body: null,
    }),
  );
  refused(
    await seedOf(h, h.execution.execution_id),
    HttpStatus.Conflict,
    "credential.revision.revoked",
  );
});

const CLI_SUCCESS = 0;
const SEED_FOLDER_MODE = 0o700;
const SEED_FILE_MODE = 0o600;
const MODE_BITS = 0o777;

test(
  "worker tasks seed writes the seed of the route, and worker tasks run completes that seed with a scripted provider",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = temporary(t);
    const { source, head } = await sourceRepository(root);
    const h = await setup(t, "http", undefined, {
      environment: SEED_ENVIRONMENT,
      promptBase: {
        instructionBindingsOf: (_tx, bindingIds) => [...bindingIds],
        instructionFileOf: async () => null,
        baseCommitOf: async () => head,
      },
    });
    completed(await h.handover());
    const seedFolder = join(root, "seed");
    const exported = await kanthord(
      [
        "worker",
        "tasks",
        "seed",
        h.execution.execution_id,
        "--output",
        seedFolder,
      ],
      {
        ...environment(root),
        KANTHORD_ENDPOINT: h.f.endpoint,
        KANTHORD_TOKEN: h.f.token,
      },
    );
    assert.equal(exported.code, CLI_SUCCESS, exported.stderr);
    const printed = JSON.parse(exported.stdout) as Record<string, unknown>;
    assert.equal(printed.output, seedFolder);
    assert.equal(statSync(seedFolder).mode & MODE_BITS, SEED_FOLDER_MODE);
    const seedFile = join(seedFolder, "seed.json");
    assert.equal(statSync(seedFile).mode & MODE_BITS, SEED_FILE_MODE);
    const seedText = readFileSync(seedFile, "utf8");
    assertNoSecret(seedText, [
      ENV_CANARY,
      ENV_REMOTE_CANARY,
      BUILD_ARGS_CANARY,
      SECRET,
      h.token,
      h.clientSecretOf(h.token),
      "ssh_identities",
      "PRIVATE KEY",
    ]);
    const seed = JSON.parse(seedText) as Record<string, unknown>;
    assert.equal(printed.seed_digest, digest(seed));
    const bindingId = h.bindings.repo!.id;
    const fixture = { root, seedFolder, source, bindingId, head, seed };
    const run = tasksCommandRun(
      fixture,
      scriptedProvider([fauxAssistantMessage("done")]),
    );
    const code = await tasksRun(seedFolder, runOptions(fixture), run.io);
    assert.equal(code, TasksExit.Success, run.stderr.join(""));
    assert.equal(
      readJson(join(root, "out"), "result.json").end,
      RunEndKind.Completed,
    );
  },
);

test("the server setup stores the agent.prompt span with the references and the engine version, and a retried setup answers the stored text", async (t) => {
  const h = await setup(t, "direct", undefined, {
    instructionFile: "AGENTS.md",
    extraRepository: true,
    implementBindsOther: true,
  });
  completed(await h.handover());
  const input = {
    params: { execution_id: h.execution.execution_id },
    query: {},
    body: null,
  };
  const first = completed(
    await h.call(workerOperations["execution.setup.get"], input, h.token),
  );
  const second = completed(
    await h.call(workerOperations["execution.setup.get"], input, h.token),
  );
  assert.deepEqual(
    second.agents.map(({ prompt }) => prompt),
    first.agents.map(({ prompt }) => prompt),
  );
  const rows = h.f.trackingStore.database
    .prepare("SELECT attributes FROM tracking_span WHERE operation = ?")
    .all("agent.prompt") as { attributes: string }[];
  assert.equal(rows.length, first.agents.length);
  const attributes = JSON.parse(rows[0]!.attributes) as Record<string, unknown>;
  assert.equal(attributes["kanthord.engine.version"], packageVersion());
  assert.deepEqual(
    (attributes["kanthord.prompt.sources"] as string[]).map((source) =>
      JSON.parse(source),
    ),
    first.agents[0]!.prompt.sources,
  );
  assert.deepEqual(
    Object.keys(attributes)
      .filter((key) => key.startsWith("kanthord.prompt."))
      .sort(),
    ["kanthord.prompt.sources", "kanthord.prompt.templates_digest"],
  );
  assert.ok(!rows[0]!.attributes.includes(SWE_AGENT_PROMPT));
});

const INSTRUCTION_PATH = "AGENTS.md";
const INSTRUCTION_TEXT = "Write every name outside the code in snake_case.";

test("agent prompt resolve over HTTP rebuilds the served system prompt for a human and refuses a worker, an absent record and an absent execution", async (t) => {
  const files = fakeRepositoryFiles();
  const h = await setup(t, HTTP, undefined, {
    instructionFile: INSTRUCTION_PATH,
    repositoryFiles: {
      ...files,
      readFilesAtCommit: async (address, commit, paths, ...rest) =>
        paths.includes(INSTRUCTION_PATH)
          ? paths.map((path) =>
              path === INSTRUCTION_PATH
                ? {
                    path,
                    state: RepositoryFileState.Present,
                    text: INSTRUCTION_TEXT,
                  }
                : { path, state: RepositoryFileState.Absent, text: null },
            )
          : files.readFilesAtCommit(address, commit, paths, ...rest),
    },
  });
  completed(await h.handover());
  const setupAnswer = completed(
    await h.call(
      workerOperations["execution.setup.get"],
      {
        params: { execution_id: h.execution.execution_id },
        query: {},
        body: null,
      },
      h.token,
    ),
  );
  const served = setupAnswer.agents[0]!;
  assert.deepEqual(
    served.prompt.sources
      .filter(({ part }) => part === PromptPart.InstructionFile)
      .map(({ path, commit, binding_id }) => ({ path, commit, binding_id })),
    [
      {
        path: INSTRUCTION_PATH,
        commit: FAKE_COMMIT,
        binding_id: h.bindings.repo!.id,
      },
    ],
  );
  assert.ok(served.prompt.final.includes(INSTRUCTION_TEXT));
  const resolve = (executionId: string, agentName: string, token = h.f.token) =>
    h.call(
      agentOperations["prompt.resolve"],
      {
        params: {},
        query: { execution_id: executionId, agent_name: agentName },
        body: null,
      },
      token,
    );
  const answer = completed(
    await resolve(h.execution.execution_id, served.agent_name),
  );
  assert.equal(answer.final, served.prompt.final);
  assert.equal(answer.engine_version, packageVersion());
  assert.deepEqual(
    answer.parts.map(
      ({ part, name, origin, path, binding_id, commit, digest }) => ({
        part,
        name,
        origin,
        path,
        binding_id,
        commit,
        digest,
      }),
    ),
    served.prompt.sources,
  );
  refused(
    await resolve(h.execution.execution_id, served.agent_name, h.token),
    HttpStatus.Unauthorized,
    "gateway.authentication.unauthorized",
  );
  refused(
    await resolve(h.execution.execution_id, "re@1"),
    HttpStatus.NotFound,
    AgentErrorCode.PromptRecordAbsent,
  );
  refused(
    await resolve("execution_absent", served.agent_name),
    HttpStatus.NotFound,
    "scheduler.execution.not_found",
  );
});

test("two concurrent first handovers of one attempt store one pin and both answer it", async (t) => {
  const heads: ((commit: string) => void)[] = [];
  let bothRead = () => {};
  const reading = new Promise<void>((resolve) => {
    bothRead = resolve;
  });
  const h = await setup(t, "direct", undefined, {
    promptBase: {
      instructionBindingsOf: (_tx, bindingIds) => [...bindingIds],
      instructionFileOf: async () => null,
      baseCommitOf: () =>
        new Promise((resolve) => {
          heads.push(resolve);
          if (heads.length === CONCURRENT_HANDOVERS) bothRead();
        }),
    },
  });
  const answered: unknown[] = [];
  const pinPromptCommits = h.f.mission.pinPromptCommits.bind(h.f.mission);
  t.mock.method(
    h.f.mission,
    "pinPromptCommits",
    (...args: Parameters<typeof pinPromptCommits>) => {
      const stored = pinPromptCommits(...args);
      answered.push(stored);
      return stored;
    },
  );
  const first = h.handover();
  const second = h.handover();
  await reading;
  heads[0]!(PINNED_HEAD);
  heads[1]!(MOVED_HEAD);
  completed(await first);
  completed(await second);
  const pinned = [{ binding_id: h.bindings.repo!.id, commit: PINNED_HEAD }];
  assert.equal(storedPromptCommits(h), canonicalJSON(pinned));
  assert.deepEqual(answered, [pinned, pinned]);
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

const NO_HELD = 0;
const LEASE_POLL_MS = 10;
const LEASE_POLL_ROUNDS = 1000;
const OAUTH_STORED: OAuthCredential = {
  type: SecretShape.OAuth,
  refresh: "test_refresh_one",
  access: "test_access_one",
  expires: 1,
};
const OAUTH_REFRESHED: OAuthCredential = {
  type: SecretShape.OAuth,
  refresh: "test_refresh_two",
  access: "test_access_two",
  expires: 4102444800000,
};

async function polled(done: () => boolean): Promise<void> {
  for (let round = 0; round < LEASE_POLL_ROUNDS && !done(); round++)
    await sleep(LEASE_POLL_MS);
  assert.ok(done());
}

test("two executions of two server instances that pin one OAuth revision make one refresh call", async (t) => {
  const h = await setup(t, HTTP, OAUTH_STORED, {
    instanceCount: 2,
    secondNode: true,
  });
  const second = await h.claimSecond();
  assert.notEqual(second.execution.execution_id, h.execution.execution_id);
  let held = 0;
  const open = (
    token: string,
    claim: typeof h.execution,
    observe: (result: OperationResult<unknown>) => void,
  ) =>
    takeHandover({
      api: observedTransport(httpTransport(h.f.endpoint, token), observe),
      claim,
      clientSecret: h.clientSecretOf(token),
      context: background,
    });
  const firstView = await open(h.token, h.execution, () => {});
  const secondView = await open(second.token, second.execution, (result) => {
    if (
      result.type === OperationResultType.Failure &&
      result.error.error.code === WorkerErrorCode.CredentialLeaseHeld
    )
      held++;
  });
  stopAfter(t, () => firstView.credentials.discard());
  stopAfter(t, () => secondView.credentials.discard());
  const [firstItem, secondItem] = [firstView, secondView].map(
    ({ credentials }) => credentials.items[0]!,
  );
  assert.equal(firstItem!.credential_id, h.credentialId);
  assert.equal(secondItem!.credential_id, h.credentialId);
  let refreshCalls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = async (current: Credential | undefined) => {
    if (current?.type === SecretShape.OAuth && current.expires > Date.now())
      return undefined;
    refreshCalls++;
    await gate;
    return OAUTH_REFRESHED;
  };
  const firstDone = firstItem!.store.modify(firstItem!.provider_id, refresh);
  await polled(() => refreshCalls === FIRST_REVISION);
  const secondDone = secondItem!.store.modify(secondItem!.provider_id, refresh);
  await polled(() => held > NO_HELD);
  release();
  assert.deepEqual(await firstDone, OAUTH_REFRESHED);
  assert.deepEqual(await secondDone, OAUTH_REFRESHED);
  assert.equal(refreshCalls, FIRST_REVISION);
  assert.deepEqual(
    h.open(completed(await h.handover())).items[0]!.credential,
    OAUTH_REFRESHED,
  );
});

const MACHINE_INSTANCES = ["box-1", "box-2"];
const SECOND_INSTANCE = 1;
const CREDENTIAL_NAME = "anthro-1";

test("two executions of two instances of one machine pin the machine copy and share its refresh lease", async (t) => {
  const h = await setup(t, HTTP, OAUTH_STORED, {
    workerInstances: MACHINE_INSTANCES,
    secondNode: true,
  });
  const second = await h.claimOnInstance(SECOND_INSTANCE);
  assert.notEqual(second.execution.execution_id, h.execution.execution_id);
  const first = {
    token: h.token,
    runtime_identity: h.runtime_identity,
    execution: h.execution,
  };
  const secretsOf = (claimant: typeof first) => {
    const keys = deriveHandoverKeys(h.clientSecretOf(claimant.token));
    const aad = handoverAad(
      claimant.execution.execution_id,
      claimant.runtime_identity,
    );
    return { keys, aad };
  };
  const handover = async (claimant: typeof first) => {
    const { keys, aad } = secretsOf(claimant);
    const envelope = completed(
      await h.call(
        workerOperations.handover,
        {
          params: {},
          query: {},
          body: { execution_id: claimant.execution.execution_id },
        },
        claimant.token,
        { idempotencyKey: createIdempotencyKey() },
      ),
    );
    const [item] = handoverPayloadSchema.parse(
      openEnvelope(keys.handover, aad, envelope),
    ).items;
    assert.ok(item && "sealed" in item);
    return item;
  };
  const lease = async (claimant: typeof first, credentialId: string) =>
    h.call(
      workerOperations["credential.lease"],
      {
        params: {},
        query: {},
        body: {
          execution_id: claimant.execution.execution_id,
          credential_id: credentialId,
        },
      },
      claimant.token,
    );
  const firstItem = await handover(first);
  const secondItem = await handover(second);
  assert.equal(firstItem.holder, WORKER_MACHINE);
  assert.equal(secondItem.holder, WORKER_MACHINE);
  assert.equal(firstItem.credential_id, secondItem.credential_id);
  const leased = completed(await lease(first, firstItem.credential_id));
  const leasedItem = leasePayloadSchema.parse(
    openEnvelope(secretsOf(first).keys.handover, secretsOf(first).aad, leased),
  ).item;
  assert.ok("sealed" in leasedItem);
  assert.equal(leasedItem.holder, WORKER_MACHINE);
  refused(
    await lease(second, secondItem.credential_id),
    HttpStatus.ServiceUnavailable,
    WorkerErrorCode.CredentialLeaseHeld,
  );
  const machineSealedTo = keyFingerprint(h.machineKey.public_key);
  const machineAad = credentialSealAad({
    name: CREDENTIAL_NAME,
    platform: COPILOT,
    holder: WORKER_MACHINE,
    sealed_to: machineSealedTo,
  });
  assert.deepEqual(
    await openJSON(
      h.machineKey.private_key,
      CREDENTIAL_SEAL_INFO,
      machineAad,
      leasedItem.sealed,
    ),
    {
      refresh: OAUTH_STORED.refresh,
      access: OAUTH_STORED.access,
      expires: OAUTH_STORED.expires,
    },
  );
  const reports = [
    {
      credential_id: leasedItem.credential_id,
      digest: digest(leasedItem.sealed),
      sealed: await sealJSON(
        h.machineKey.public_key,
        CREDENTIAL_SEAL_INFO,
        machineAad,
        {
          refresh: OAUTH_REFRESHED.refresh,
          access: OAUTH_REFRESHED.access,
          expires: OAUTH_REFRESHED.expires,
        },
      ),
    },
  ];
  completed(
    await h.call(
      workerOperations.credential,
      {
        params: {},
        query: {},
        body: {
          execution_id: first.execution.execution_id,
          ...sealEnvelope(
            secretsOf(first).keys.report,
            secretsOf(first).aad,
            reports[0],
          ),
        },
      },
      first.token,
      { idempotencyKey: createIdempotencyKey() },
    ),
  );
  completed(await lease(second, secondItem.credential_id));
});

test("a provider failure stop of an execution that pins the machine copy holds the machine copy", async (t) => {
  const h = await setup(t, HTTP, OAUTH_STORED, {
    workerInstances: MACHINE_INSTANCES,
  });
  const [item] = h.openSealed(completed(await h.handover())).items;
  assert.ok(item && "sealed" in item);
  assert.equal(item.holder, WORKER_MACHINE);
  completed(
    await h.call(
      schedulerOperations.executionRelease,
      {
        params: { execution_id: h.execution.execution_id },
        query: {},
        body: {
          further_work: true,
          stop: {
            reason: ExecutionStopReason.ProviderFailed,
            code: AdvancingProviderFailure.RateLimited,
          },
        },
      },
      h.token,
    ),
  );
  const { items } = completed(
    await h.call(agentOperations["cooldown.list"], NO_INPUT),
  );
  assert.deepEqual(
    items.map(({ credential, holder }) => [credential, holder]),
    [[CREDENTIAL_NAME, WORKER_MACHINE]],
  );
});
