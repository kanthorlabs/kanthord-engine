import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  createModels,
  createProvider,
  type AuthPrompt,
  type Provider,
  type ProviderAuthInteraction,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { Logger } from "pino";
import {
  CustodyComponent,
  custodyMigrations,
  type AgentProvidersDependentOnFn,
} from "../custody/index.ts";
import {
  CUSTODY_SERVICE_NAME,
  EXECUTION_CREDENTIAL_MAX_BYTES,
  SecretShape,
  type CredentialAnswer,
} from "../custody/contract.ts";
import { decrypt } from "../custody/envelope.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  AccessPolicy,
  OperationRegistry,
  type CallerContext,
} from "../kernel/operation.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { HealthStatus } from "../kernel/service.ts";
import { REPOSITORY_PLATFORMS } from "../repository/index.ts";
import { STORAGE_PLATFORMS } from "../storage/index.ts";
import {
  llmOperations,
  type EnablementsDependentOnModelFn,
} from "./contract.ts";
import {
  COPILOT_ENTERPRISE_DOMAIN_PLACEHOLDER,
  OAUTH_PROVIDER_IDS,
} from "./login.ts";
import {
  CAPABILITY_MODEL_LIST_READ,
  CAPABILITY_NONE,
  LLM_PLATFORMS,
  Platform,
} from "./platforms.ts";
import { ANTHROPIC_MODELS_URL, GITHUB_COPILOT_TOKEN_URL } from "./probes.ts";
import { LoginSessionState, SESSION_EXPIRY_MS } from "./sessions.ts";
import { LlmComponent } from "./service.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";

const FIRST_REVISION = 1;
const HUMAN_ACCOUNT_ID = "alice";
const NAME_CONFLICT_CODE = "credential.name.conflict";
const REVISION_CONFLICT_CODE = "credential.revision.conflict";
const CREDENTIAL_NOT_FOUND_CODE = "credential.credential.not_found";
const PLATFORM_MISMATCH_CODE = "credential.platform.mismatch";
const MODEL_IN_USE_CODE = "llm.metadata.model_in_use";
const BASE_URL_FIXED_CODE = "llm.metadata.base_url_fixed";
const REMOVED_MODEL = "removed";
const KEPT_MODEL = "kept";
const DEPENDENT_AGENT = "dependent-agent";
const RemovalMode = {
  MetadataEdit: "metadata edit",
  Rotation: "rotation",
} as const;
const NEXT_REVISION = FIRST_REVISION + 1;
const THIRD_REVISION = NEXT_REVISION + 1;
const ROTATED_BASE_URL = "https://other.example/v1";
const key = Buffer.alloc(32, 7);
const secretValue = "private-credential-value";
const apiSecret = { key: secretValue };
function unexpectedCollaboration(): never {
  throw new Error("UNEXPECTED_COLLABORATION");
}

const inputs = [
  {
    name: "anthropic",
    platform: Platform.Anthropic,
    secret: apiSecret,
    metadata: null,
  },
  {
    name: "openai",
    platform: Platform.OpenAICompatible,
    secret: apiSecret,
    metadata: { base_url: "https://example.com/v1", models: [] },
  },
];

function fixture(
  collaborations: {
    oauthProviders?: () => readonly Provider[];
    now?: () => number;
    agentProvidersDependentOn?: AgentProvidersDependentOnFn;
    enablementsDependentOnModel?: EnablementsDependentOnModelFn;
  } = {},
) {
  const store = new Store(IN_MEMORY_DATABASE);
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const logs: { credential_id: string; human_identity: string }[] = [];
  const logger = {
    info: (record: { credential_id: string; human_identity: string }) =>
      logs.push(record),
  } as unknown as Logger;
  const agentProvidersDependentOn =
    collaborations.agentProvidersDependentOn ?? (() => []);
  const custody = new CustodyComponent({
    executions: {
      requireRunning: unexpectedCollaboration,
      pinCredential: unexpectedCollaboration,
      liveExecutionsPinning: () => [],
    },
    authorization: { authorizeModelInference: unexpectedCollaboration },
    missionAuthorization: {
      frozenAction: unexpectedCollaboration,
      requestEvidence: unexpectedCollaboration,
      evidenceAsset: unexpectedCollaboration,
      objectPut: unexpectedCollaboration,
    },
    clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
    store,
    platforms: {
      ...LLM_PLATFORMS,
      ...REPOSITORY_PLATFORMS,
      ...STORAGE_PLATFORMS,
    },
    envelopeKey: key,
    logger,
    agentProvidersDependentOn,
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    intakeServiceName: INTAKE_SERVICE_NAME,
  });
  const component = new LlmComponent({
    records: custody,
    store,
    logger,
    oauthProviders: collaborations.oauthProviders,
    now: collaborations.now,
    agentProvidersDependentOn,
    enablementsDependentOnModel:
      collaborations.enablementsDependentOnModel ?? (() => []),
  });
  const registry = new OperationRegistry();
  component.declare(registry);
  let lastTransaction: Transaction | undefined;
  const caller: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    commit: (write) =>
      store.transaction((tx) => {
        lastTransaction = tx;
        return write(tx);
      }),
  };
  function invoke(
    operation: (typeof llmOperations)[keyof typeof llmOperations],
    input: unknown,
  ): unknown {
    const parsed = operation.input.parse(input);
    return registry.get(operation.id).handler(parsed, caller);
  }
  const create = (body: unknown) =>
    invoke(llmOperations.create, { params: {}, query: {}, body });
  const get = (name: string) =>
    invoke(llmOperations.get, {
      params: { credential_name: name },
      query: {},
      body: null,
    });
  const list = (query: Record<string, unknown> = {}) =>
    invoke(llmOperations.list, { params: {}, query, body: null });
  const rotate = (name: string, body: unknown) =>
    invoke(llmOperations.rotate, {
      params: { credential_name: name },
      query: {},
      body,
    });
  const updateMetadata = (name: string, body: unknown) =>
    invoke(llmOperations.update_metadata, {
      params: { credential_name: name },
      query: {},
      body,
    });
  const revoke = (name: string, revision: number) =>
    invoke(llmOperations.revoke, {
      params: { credential_name: name, revision },
      query: {},
      body: null,
    });
  const archive = (name: string) =>
    invoke(llmOperations.archive, {
      params: { credential_name: name },
      query: {},
      body: null,
    });
  const platformList = () =>
    invoke(llmOperations.platform_list, {
      params: {},
      query: {},
      body: null,
    }) as typeof llmOperations.platform_list.output._output;
  const login = async (body: unknown) =>
    (await invoke(llmOperations.login, {
      params: {},
      query: {},
      body,
    })) as typeof llmOperations.login.output._output;
  const loginCode = (sessionId: string, value: string) =>
    invoke(llmOperations.login_code, {
      params: { session_id: sessionId },
      query: {},
      body: { value },
    });
  const loginStatus = (sessionId: string) =>
    invoke(llmOperations.login_status, {
      params: { session_id: sessionId },
      query: {},
      body: null,
    }) as typeof llmOperations.login_status.output._output;
  const providerCheck = async (body: unknown) =>
    (await invoke(llmOperations.provider_check, {
      params: {},
      query: {},
      body,
    })) as typeof llmOperations.provider_check.output._output;
  const credentialCheck = async (body: unknown) =>
    (await invoke(llmOperations.check, {
      params: {},
      query: {},
      body,
    })) as typeof llmOperations.check.output._output;
  return {
    store,
    custody,
    component,
    caller,
    invoke,
    login,
    loginCode,
    loginStatus,
    lastTransaction: () => lastTransaction,
    registry,
    logs,
    create,
    get,
    list,
    rotate,
    updateMetadata,
    revoke,
    archive,
    platformList,
    providerCheck,
    credentialCheck,
  };
}

function fails(fn: () => unknown, status: number, code: string) {
  assert.throws(
    fn,
    (error) =>
      error instanceof OperationError &&
      error.status === status &&
      error.code === code,
  );
}

function noSecret(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes('"secret"'));
  assert.ok(!serialized.includes(secretValue));
}

test("create refuses a platform of another component, nonempty initial models and an OAuth platform", () => {
  const f = fixture();
  try {
    for (const platform of ["github", "s3", "unknown"])
      fails(
        () => f.create({ ...inputs[0], platform }),
        HttpStatus.BadRequest,
        UNSUPPORTED_PLATFORM_CODE,
      );
    fails(
      () =>
        f.create({
          ...inputs[1],
          name: "nonempty-models",
          metadata: { ...inputs[1]!.metadata, models: [{ id: "gpt" }] },
        }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
    fails(
      () => f.create({ ...inputs[0], platform: Platform.GitHubCopilot }),
      HttpStatus.BadRequest,
      UNSUPPORTED_ENTRY_CODE,
    );
    assert.equal(credentialCount(f), NO_CREDENTIALS);
  } finally {
    f.store.close();
  }
});

test("a name of another component answers not found and stays out of the list", () => {
  const f = fixture();
  try {
    f.store.transaction((tx) =>
      f.custody.create(
        tx,
        { platforms: REPOSITORY_PLATFORMS },
        {
          name: "github",
          platform: "github",
          secret: apiSecret,
          metadata: null,
        },
        undefined,
      ),
    );
    f.create(inputs[0]);
    for (const call of [
      () => f.get("github"),
      () =>
        f.rotate("github", {
          expected_revision: FIRST_REVISION,
          secret: apiSecret,
        }),
      () =>
        f.updateMetadata("github", {
          expected_revision: FIRST_REVISION,
          metadata: null,
        }),
      () => f.revoke("github", FIRST_REVISION),
      () => f.archive("github"),
    ])
      fails(call, HttpStatus.NotFound, CREDENTIAL_NOT_FOUND_CODE);
    assert.deepEqual(
      (
        f.list({ include_archived: "true" }) as { items: CredentialAnswer[] }
      ).items.map(({ name }) => name),
      ["anthropic"],
    );
    assert.deepEqual(
      (f.list({ platform: "github" }) as { items: CredentialAnswer[] }).items,
      [],
    );
  } finally {
    f.store.close();
  }
});

test("get lists the agent providers that name the credential", () => {
  const calls: string[] = [];
  const f = fixture({
    agentProvidersDependentOn: (tx, name) => {
      assert.ok(tx.database.isTransaction);
      calls.push(name);
      return [{ agent_name: "swe@1", provider_name: "default" }];
    },
  });
  try {
    f.create(inputs[0]);
    const answer = f.get("anthropic") as CredentialAnswer & {
      agent_providers: unknown;
    };
    assert.deepEqual(answer.agent_providers, [
      { agent: "swe@1", name: "default" },
    ]);
    assert.equal(answer.revisions.length, FIRST_REVISION);
    assert.deepEqual(calls, ["anthropic"]);
    noSecret(answer);
  } finally {
    f.store.close();
  }
});

test("rotation of an openai-compatible credential may set a new base URL", () => {
  const f = fixture();
  try {
    f.create(inputs[1]);
    const changed = f.rotate("openai", {
      expected_revision: FIRST_REVISION,
      secret: apiSecret,
      metadata: {
        base_url: ROTATED_BASE_URL,
        models: [{ id: "new" }],
      },
    }) as { revisions: { id: string; metadata: { base_url: string } }[] };
    assert.equal(changed.revisions[0]!.metadata.base_url, ROTATED_BASE_URL);
    noSecret(changed);
  } finally {
    f.store.close();
  }
});

test("offline OAuth login persists the maximum aggregate credential and sanitizes the next byte", async (t) => {
  const overhead = Buffer.byteLength(
    canonicalJSON({
      type: "oauth",
      refresh: "r",
      access: "",
      expires: CLOCK_START,
    }),
  );
  const access = "a".repeat(EXECUTION_CREDENTIAL_MAX_BYTES - overhead);
  for (const extra of ["", "x"]) {
    const gate = gatedLogin();
    const f = fixture({ oauthProviders: () => [gate.provider] });
    t.after(async () => {
      await f.component.stop();
      f.store.close();
    });
    const pending = await f.login(LOGIN_BODY);
    gate.result.resolve({
      type: "oauth",
      refresh: "r",
      access: access + extra,
      expires: CLOCK_START,
    });
    const status = await terminalStatus(f, pending.session_id);
    if (extra.length) {
      assert.equal(status.state, LoginSessionState.Failed);
      assert.equal(status.failure_reason, LOGIN_FAILED_MESSAGE);
      assert.equal(credentialCount(f), NO_CREDENTIALS);
      assert.ok(!JSON.stringify(status).includes(access));
    } else {
      assert.equal(status.state, LoginSessionState.Completed);
      assert.equal(credentialCount(f), FIRST_REVISION);
    }
  }
});
test("metadata edits re-encrypt under new identity and enforce base URL and revision", () => {
  const f = fixture();
  try {
    f.create(inputs[1]);
    const metadata = { ...inputs[1]!.metadata, models: [{ id: "added" }] };
    const answer = f.updateMetadata("openai", {
      expected_revision: FIRST_REVISION,
      metadata,
    }) as { revisions: { id: string; revision: number; metadata: unknown }[] };
    assert.equal(answer.revisions[0]!.revision, NEXT_REVISION);
    assert.deepEqual(answer.revisions[0]!.metadata, metadata);
    assert.notEqual(answer.revisions[0]!.id, answer.revisions[1]!.id);
    const row = f.store.database
      .prepare("SELECT id, nonce, ciphertext FROM credential WHERE id = ?")
      .get(answer.revisions[0]!.id) as {
      id: string;
      nonce: Buffer;
      ciphertext: Buffer;
    };
    assert.deepEqual(
      decrypt(
        key,
        row.id,
        Platform.OpenAICompatible,
        row.nonce,
        row.ciphertext,
      ),
      apiSecret,
    );
    noSecret(answer);
    fails(
      () =>
        f.updateMetadata("openai", {
          expected_revision: NEXT_REVISION,
          metadata: { ...metadata, base_url: ROTATED_BASE_URL },
        }),
      HttpStatus.Conflict,
      BASE_URL_FIXED_CODE,
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expected_revision: FIRST_REVISION,
          metadata,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
    fails(
      () =>
        f.updateMetadata("missing", {
          expected_revision: FIRST_REVISION,
          metadata,
        }),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expected_revision: NEXT_REVISION,
          metadata: {},
        }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    assert.equal(f.logs.at(-1)?.credential_id, row.id);
    assert.equal(f.logs.at(-1)?.human_identity, HUMAN_ACCOUNT_ID);
    assert.ok(!JSON.stringify(f.logs).includes(secretValue));
  } finally {
    f.store.close();
  }
});

test("a repeated approved model id answers invalid input at create, rotate and update-metadata and stores nothing", () => {
  const f = fixture();
  try {
    const duplicated = {
      base_url: "https://example.com/v1",
      models: [{ id: "same" }, { id: "same", max_tokens: 1000 }],
    };
    fails(
      () => f.create({ ...inputs[1], name: "dup", metadata: duplicated }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
    assert.equal(credentialCount(f), NO_CREDENTIALS);
    f.create(inputs[1]);
    fails(
      () =>
        f.rotate("openai", {
          expected_revision: FIRST_REVISION,
          secret: apiSecret,
          metadata: duplicated,
        }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expected_revision: FIRST_REVISION,
          metadata: duplicated,
        }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
    assert.equal(credentialCount(f), FIRST_REVISION);
  } finally {
    f.store.close();
  }
});

test("openrouter takes an api key with null metadata and differs from openai-compatible", () => {
  const f = fixture();
  try {
    f.create({
      name: "router",
      platform: Platform.OpenRouter,
      secret: apiSecret,
      metadata: null,
    });
    fails(
      () =>
        f.create({
          name: "router-meta",
          platform: Platform.OpenRouter,
          secret: apiSecret,
          metadata: { base_url: "https://example.com/v1", models: [] },
        }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
    fails(
      () =>
        f.store.transaction((tx) =>
          f.custody.custodySuitability(tx, {
            credential: "router",
            platform: Platform.OpenAICompatible,
          }),
        ),
      HttpStatus.BadRequest,
      PLATFORM_MISMATCH_CODE,
    );
    f.store.transaction((tx) =>
      f.custody.custodySuitability(tx, {
        credential: "router",
        platform: Platform.OpenRouter,
      }),
    );
  } finally {
    f.store.close();
  }
});

for (const mode of Object.values(RemovalMode)) {
  test(`${mode} refuses dependent model removal and permits unused model removal`, () => {
    const calls: {
      tx: Transaction;
      credentialName: string;
      modelId: string;
    }[] = [];
    let dependents = [{ agent_name: DEPENDENT_AGENT }];
    const f = fixture({
      enablementsDependentOnModel: (tx, credentialName, modelId) => {
        calls.push({ tx, credentialName, modelId });
        return dependents;
      },
    });
    try {
      f.create(inputs[1]);
      const baseUrl = (inputs[1]!.metadata as { base_url: string }).base_url;
      const existing = {
        base_url: baseUrl,
        models: [{ id: REMOVED_MODEL }, { id: KEPT_MODEL }],
      };
      f.updateMetadata("openai", {
        expected_revision: FIRST_REVISION,
        metadata: existing,
      });
      const next = { base_url: baseUrl, models: [{ id: KEPT_MODEL }] };
      const change = () =>
        mode === RemovalMode.Rotation
          ? f.rotate("openai", {
              expected_revision: NEXT_REVISION,
              secret: apiSecret,
              metadata: next,
            })
          : f.updateMetadata("openai", {
              expected_revision: NEXT_REVISION,
              metadata: next,
            });
      assert.throws(change, (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.status, HttpStatus.Conflict);
        assert.equal(error.code, MODEL_IN_USE_CODE);
        assert.deepEqual(error.details, {
          models: [{ model: REMOVED_MODEL, agents: [DEPENDENT_AGENT] }],
        });
        return true;
      });
      assert.strictEqual(calls[0]!.tx, f.lastTransaction());
      assert.equal(
        (f.get("openai") as { revisions: unknown[] }).revisions.length,
        NEXT_REVISION,
      );
      assert.equal(calls.length, FIRST_REVISION);
      assert.deepEqual(
        calls.map(({ credentialName, modelId }) => ({
          credentialName,
          modelId,
        })),
        [{ credentialName: "openai", modelId: REMOVED_MODEL }],
      );
      dependents = [];
      const result = change() as { revisions: { revision: number }[] };
      assert.equal(result.revisions.length, THIRD_REVISION);
      assert.equal(result.revisions[0]!.revision, THIRD_REVISION);
      assert.equal(calls.length, NEXT_REVISION);
      assert.deepEqual(
        calls.map(({ credentialName, modelId }) => ({
          credentialName,
          modelId,
        })),
        [
          { credentialName: "openai", modelId: REMOVED_MODEL },
          { credentialName: "openai", modelId: REMOVED_MODEL },
        ],
      );
      assert.strictEqual(calls[1]!.tx, f.lastTransaction());
    } finally {
      f.store.close();
    }
  });
}

const LOGIN_NAME = "copilot";
const LOGIN_BODY = { platform: Platform.GitHubCopilot, name: LOGIN_NAME };
const LOGIN_ADDRESS = "https://github.com/login/device";
const LOGIN_CODE = "ABCD-EFGH";
const LOGIN_PENDING = "credential.login.pending";
const LOGIN_NOT_FOUND = "credential.login.not_found";
const LOGIN_VALUE_NOT_AWAITED = "credential.login.value_not_awaited";
const LOGIN_FAILED_MESSAGE = "login failed";
const INVALID_INPUT_CODE = "credential.input.invalid";
const UNSUPPORTED_ENTRY_CODE = "credential.entry.unsupported";
const UNSUPPORTED_PLATFORM_CODE = "credential.platform.unsupported";
const EMPTY_DOMAIN = "";
const DEVICE_OPTION = "device_code";
const MANUAL_VALUE = "manual-answer";
const LAST_MESSAGE = "Waiting for authorization";
const NO_CREDENTIALS = 0;
const CLOCK_START = 1700000000000;
const MAX_TURNS = 20;
const oauthCredential: OAuthCredential = {
  type: "oauth",
  refresh: "private-refresh-token",
  access: "private-access-token",
  expires: CLOCK_START + SESSION_EXPIRY_MS,
  availableModelIds: ["not-stored"],
};

function fakeProvider(
  login: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>,
  id: string = Platform.GitHubCopilot,
): Provider {
  return createProvider({
    id,
    models: [],
    api: {},
    auth: {
      oauth: {
        name: "Fake OAuth",
        login,
        refresh: async () => {
          throw new Error("unexpected refresh");
        },
        toAuth: async () => {
          throw new Error("unexpected auth resolution");
        },
      },
    },
  });
}

function deviceAddress(interaction: ProviderAuthInteraction): void {
  interaction.notify({
    type: "device_code",
    verificationUri: LOGIN_ADDRESS,
    userCode: LOGIN_CODE,
  });
}

function gatedLogin() {
  const result = Promise.withResolvers<OAuthCredential>();
  const entered = Promise.withResolvers<ProviderAuthInteraction>();
  const provider = fakeProvider(async (interaction) => {
    entered.resolve(interaction);
    deviceAddress(interaction);
    return await result.promise;
  });
  return { result, entered, provider };
}

async function terminalStatus(
  f: ReturnType<typeof fixture>,
  sessionId: string,
) {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const status = f.loginStatus(sessionId);
    if (status.state !== LoginSessionState.Pending) return status;
    await setImmediate();
  }
  assert.fail("Login did not finish within the bounded event-loop turns");
}

function credentialCount(f: ReturnType<typeof fixture>): number {
  return (
    f.store.database
      .prepare("SELECT COUNT(*) AS count FROM credential")
      .get() as { count: number }
  ).count;
}

function noOAuthSecret(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes(oauthCredential.access));
  assert.ok(!serialized.includes(oauthCredential.refresh));
  assert.ok(!serialized.includes('"ciphertext"'));
  assert.ok(!serialized.includes('"access"'));
  assert.ok(!serialized.includes('"refresh"'));
}

function rejectsWith(status: number, code: string) {
  return (error: unknown) =>
    error instanceof OperationError &&
    error.status === status &&
    error.code === code;
}

test("Copilot built-in OAuth prompt matches the enterprise placeholder", async (t) => {
  const originalFetch = globalThis.fetch;
  const textPromptType = "text";
  const noFetchCalls = 0;
  let fetchCalls = noFetchCalls;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("OAuth prompt test must not fetch");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const controller = new AbortController();
  let firstPrompt: AuthPrompt | undefined;
  const models = createModels();
  models.setProvider(githubCopilotProvider());
  await assert.rejects(
    models.login(OAUTH_PROVIDER_IDS[Platform.GitHubCopilot]!, "oauth", {
      signal: controller.signal,
      prompt: async (prompt) => {
        firstPrompt ??= prompt;
        controller.abort();
        throw new Error("Stop before network access");
      },
      notify: () => {},
    }),
  );
  assert.equal(firstPrompt?.type, textPromptType);
  assert.equal(
    firstPrompt?.type === textPromptType ? firstPrompt.placeholder : undefined,
    COPILOT_ENTERPRISE_DOMAIN_PLACEHOLDER,
  );
  assert.equal(fetchCalls, noFetchCalls);
});

test("OAuth uses real pi-ai modify, defaults Copilot enterprise, and stores only the encrypted secret", async (t) => {
  const finish = Promise.withResolvers<OAuthCredential>();
  const prompted = Promise.withResolvers<void>();
  let selected: string | undefined;
  let domain: string | undefined;
  const provider = fakeProvider(async (interaction) => {
    domain = await interaction.prompt({
      type: "text",
      message: "GitHub Enterprise URL/domain (blank for github.com)",
      placeholder: COPILOT_ENTERPRISE_DOMAIN_PLACEHOLDER,
    });
    selected = await interaction.prompt({
      type: "select",
      message: "Mode",
      options: [{ id: DEVICE_OPTION, label: "Device" }],
    });
    interaction.notify({ type: "info", message: "Starting" });
    deviceAddress(interaction);
    interaction.notify({ type: "progress", message: LAST_MESSAGE });
    prompted.resolve();
    return await finish.promise;
  });
  const f = fixture({
    oauthProviders: () => [provider],
    now: () => CLOCK_START,
  });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login({ ...LOGIN_BODY, mode: "browser" });
  await prompted.promise;
  assert.match(answer.session_id, /^login_session_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(answer.address, LOGIN_ADDRESS);
  assert.equal(answer.code, LOGIN_CODE);
  assert.equal(answer.expires_at, CLOCK_START + SESSION_EXPIRY_MS);
  assert.equal(domain, EMPTY_DOMAIN);
  assert.equal(selected, DEVICE_OPTION);
  assert.equal(f.loginStatus(answer.session_id).last_message, LAST_MESSAGE);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  fails(
    () => f.loginCode(answer.session_id, MANUAL_VALUE),
    HttpStatus.Conflict,
    LOGIN_VALUE_NOT_AWAITED,
  );
  await assert.rejects(
    f.login({ ...LOGIN_BODY, name: "second" }),
    rejectsWith(HttpStatus.Conflict, LOGIN_PENDING),
  );
  finish.resolve(oauthCredential);
  const status = await terminalStatus(f, answer.session_id);
  assert.equal(status.state, LoginSessionState.Completed);
  assert.equal(status.failure_reason, null);
  assert.equal(credentialCount(f), FIRST_REVISION);
  const row = f.store.database.prepare("SELECT * FROM credential").get() as {
    id: string;
    revision: number;
    metadata: null;
    platform: string;
    ended_at: null;
    nonce: Buffer;
    ciphertext: Buffer;
  };
  assert.equal(row.revision, FIRST_REVISION);
  assert.equal(row.metadata, null);
  assert.equal(row.ended_at, null);
  assert.equal(row.platform, Platform.GitHubCopilot);
  assert.deepEqual(
    decrypt(key, row.id, row.platform, row.nonce, row.ciphertext),
    {
      refresh: oauthCredential.refresh,
      access: oauthCredential.access,
      expires: oauthCredential.expires,
    },
  );
  assert.deepEqual(f.logs, [
    { credential_id: row.id, human_identity: HUMAN_ACCOUNT_ID },
  ]);
  noOAuthSecret([answer, status, f.logs]);
  fails(
    () => f.loginCode(answer.session_id, MANUAL_VALUE),
    HttpStatus.Conflict,
    LOGIN_VALUE_NOT_AWAITED,
  );
});

test("openai-codex login offers both modes and stores only refresh, access and expires", async (t) => {
  let selected: string | undefined;
  const provider = fakeProvider(async (interaction) => {
    selected = await interaction.prompt({
      type: "select",
      message: "Mode",
      options: [
        { id: DEVICE_OPTION, label: "Device" },
        { id: "browser", label: "Browser" },
      ],
    });
    deviceAddress(interaction);
    return { ...oauthCredential, accountId: "account-extra" };
  }, Platform.OpenAICodex);
  const f = fixture({
    oauthProviders: () => [provider],
    now: () => CLOCK_START,
  });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login({
    platform: Platform.OpenAICodex,
    name: "codex",
    mode: "device",
  });
  const status = await terminalStatus(f, answer.session_id);
  assert.equal(status.state, LoginSessionState.Completed);
  assert.equal(selected, DEVICE_OPTION);
  const row = f.store.database.prepare("SELECT * FROM credential").get() as {
    id: string;
    platform: string;
    metadata: null;
    nonce: Buffer;
    ciphertext: Buffer;
  };
  assert.equal(row.platform, Platform.OpenAICodex);
  assert.equal(row.metadata, null);
  assert.deepEqual(
    decrypt(key, row.id, row.platform, row.nonce, row.ciphertext),
    {
      refresh: oauthCredential.refresh,
      access: oauthCredential.access,
      expires: oauthCredential.expires,
    },
  );
  fails(
    () =>
      f.create({
        name: "codex-direct",
        platform: Platform.OpenAICodex,
        secret: apiSecret,
        metadata: null,
      }),
    HttpStatus.BadRequest,
    UNSUPPORTED_ENTRY_CODE,
  );
});

test("OAuth validates entry, name, mode and start-time name conflict before starting a provider", async (t) => {
  const f = fixture({
    oauthProviders: () => {
      assert.fail("Invalid input must not start OAuth");
    },
  });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const cases = [
    {
      body: { ...LOGIN_BODY, platform: Platform.Anthropic },
      code: UNSUPPORTED_ENTRY_CODE,
    },
    {
      body: { ...LOGIN_BODY, platform: "github" },
      code: UNSUPPORTED_PLATFORM_CODE,
    },
    {
      body: { ...LOGIN_BODY, platform: "unknown" },
      code: UNSUPPORTED_PLATFORM_CODE,
    },
    { body: { ...LOGIN_BODY, name: "login" }, code: INVALID_INPUT_CODE },
    { body: { ...LOGIN_BODY, name: "platform" }, code: INVALID_INPUT_CODE },
    { body: { ...LOGIN_BODY, name: "check" }, code: INVALID_INPUT_CODE },
    { body: { ...LOGIN_BODY, name: "Bad Name" }, code: INVALID_INPUT_CODE },
    { body: { ...LOGIN_BODY, mode: "unknown" }, code: INVALID_INPUT_CODE },
  ];
  for (const { body, code } of cases)
    await assert.rejects(
      f.login(body),
      rejectsWith(HttpStatus.BadRequest, code),
    );
  const existing = f.create({ ...inputs[0], name: LOGIN_NAME }) as {
    revisions: { id: string }[];
  };
  await assert.rejects(f.login(LOGIN_BODY), (error) => {
    assert.ok(rejectsWith(HttpStatus.Conflict, NAME_CONFLICT_CODE)(error));
    assert.deepEqual((error as OperationError).details, {
      id: existing.revisions[0]!.id,
    });
    return true;
  });
  fails(
    () => f.loginCode("unknown", MANUAL_VALUE),
    HttpStatus.NotFound,
    LOGIN_NOT_FOUND,
  );
  fails(() => f.loginStatus("unknown"), HttpStatus.NotFound, LOGIN_NOT_FOUND);
});

test("OAuth commit-time name conflict survives pi-ai's error wrapper without storing another row", async (t) => {
  const gate = gatedLogin();
  const f = fixture({ oauthProviders: () => [gate.provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login(LOGIN_BODY);
  f.create({ ...inputs[0], name: LOGIN_NAME });
  gate.result.resolve(oauthCredential);
  const status = await terminalStatus(f, answer.session_id);
  assert.equal(status.state, LoginSessionState.Failed);
  assert.equal(status.failure_reason, NAME_CONFLICT_CODE);
  assert.equal(credentialCount(f), FIRST_REVISION);
  noOAuthSecret([answer, status, f.logs]);
});

for (const type of ["manual_code", "text", "secret"] as const) {
  test(`OAuth ${type} prompt waits for login_code, including unrelated pre-address text`, async (t) => {
    const awaiting = Promise.withResolvers<void>();
    const received = Promise.withResolvers<string>();
    const provider = fakeProvider(async (interaction) => {
      const pending = interaction.prompt({
        type,
        message: "Supply a value",
        placeholder: "unrelated",
      });
      awaiting.resolve();
      deviceAddress(interaction);
      received.resolve(await pending);
      return oauthCredential;
    });
    const f = fixture({ oauthProviders: () => [provider] });
    t.after(async () => {
      await f.component.stop();
      f.store.close();
    });
    const answer = await f.login(LOGIN_BODY);
    await awaiting.promise;
    assert.equal(
      f.loginStatus(answer.session_id).state,
      LoginSessionState.Pending,
    );
    assert.deepEqual(f.loginCode(answer.session_id, MANUAL_VALUE), {
      session_id: answer.session_id,
    });
    assert.equal(await received.promise, MANUAL_VALUE);
    assert.equal(
      (await terminalStatus(f, answer.session_id)).state,
      LoginSessionState.Completed,
    );
    noOAuthSecret([answer, f.loginStatus(answer.session_id), f.logs]);
  });
}

test("OAuth provider failure records a non-secret reason and no credential", async (t) => {
  const gate = gatedLogin();
  const f = fixture({ oauthProviders: () => [gate.provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login(LOGIN_BODY);
  gate.result.reject(new Error(oauthCredential.access));
  const status = await terminalStatus(f, answer.session_id);
  assert.equal(status.state, LoginSessionState.Failed);
  assert.equal(status.failure_reason, LOGIN_FAILED_MESSAGE);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  noOAuthSecret([answer, status, f.logs]);
});

test("OAuth expiry aborts an unanswered prompt and never writes credentials", async (t) => {
  let now = CLOCK_START;
  const entered = Promise.withResolvers<ProviderAuthInteraction>();
  const provider = fakeProvider(async (interaction) => {
    entered.resolve(interaction);
    deviceAddress(interaction);
    await interaction.prompt({ type: "manual_code", message: "Code" });
    return oauthCredential;
  });
  const f = fixture({ oauthProviders: () => [provider], now: () => now });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login(LOGIN_BODY);
  now = answer.expires_at;
  fails(
    () => f.loginStatus(answer.session_id),
    HttpStatus.NotFound,
    LOGIN_NOT_FOUND,
  );
  fails(
    () => f.loginCode(answer.session_id, MANUAL_VALUE),
    HttpStatus.NotFound,
    LOGIN_NOT_FOUND,
  );
  assert.ok((await entered.promise).signal.aborted);
  await setImmediate();
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  noOAuthSecret(f.logs);
});

test("OAuth expiry timer cancels a pre-address wait without any status polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: CLOCK_START });
  const entered = Promise.withResolvers<ProviderAuthInteraction>();
  const provider = fakeProvider(async (interaction) => {
    entered.resolve(interaction);
    await interaction.prompt({ type: "manual_code", message: "Code" });
    return oauthCredential;
  });
  const f = fixture({ oauthProviders: () => [provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const pending = f.login(LOGIN_BODY);
  const rejected = assert.rejects(
    pending,
    rejectsWith(HttpStatus.NotFound, LOGIN_NOT_FOUND),
  );
  const interaction = await entered.promise;
  t.mock.timers.tick(SESSION_EXPIRY_MS);
  await rejected;
  assert.ok(interaction.signal.aborted);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
});

test("OAuth rechecks expiry on completion before a delayed expiry timer fires", async (t) => {
  let now = CLOCK_START;
  const gate = gatedLogin();
  const f = fixture({ oauthProviders: () => [gate.provider], now: () => now });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login(LOGIN_BODY);
  now = answer.expires_at;
  gate.result.resolve(oauthCredential);
  await setImmediate();
  assert.ok((await gate.entered.promise).signal.aborted);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  assert.deepEqual(f.logs, []);
  fails(
    () => f.loginStatus(answer.session_id),
    HttpStatus.NotFound,
    LOGIN_NOT_FOUND,
  );
});

test("OAuth rejects an invalid returned secret without logging or storing it", async (t) => {
  const gate = gatedLogin();
  const f = fixture({ oauthProviders: () => [gate.provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login(LOGIN_BODY);
  gate.result.resolve({ ...oauthCredential, expires: Number.NaN });
  const status = await terminalStatus(f, answer.session_id);
  assert.equal(status.state, LoginSessionState.Failed);
  assert.equal(status.failure_reason, LOGIN_FAILED_MESSAGE);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  assert.deepEqual(f.logs, []);
  noOAuthSecret([answer, status]);
});

test("OAuth a failed insert never completes the session or emits a success log", async (t) => {
  const gate = gatedLogin();
  const f = fixture({ oauthProviders: () => [gate.provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  f.store.database.exec(
    "CREATE TRIGGER refuse_login BEFORE INSERT ON credential BEGIN SELECT RAISE(ABORT, 'private-access-token'); END",
  );
  const answer = await f.login(LOGIN_BODY);
  gate.result.resolve(oauthCredential);
  const status = await terminalStatus(f, answer.session_id);
  assert.equal(status.state, LoginSessionState.Failed);
  assert.equal(status.failure_reason, LOGIN_FAILED_MESSAGE);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  assert.deepEqual(f.logs, []);
  noOAuthSecret([answer, status]);
});

test("OAuth the enterprise-shaped prompt after an address still requires login_code", async (t) => {
  const received = Promise.withResolvers<string>();
  const provider = fakeProvider(async (interaction) => {
    deviceAddress(interaction);
    received.resolve(
      await interaction.prompt({
        type: "text",
        message: "Another domain",
        placeholder: COPILOT_ENTERPRISE_DOMAIN_PLACEHOLDER,
      }),
    );
    return oauthCredential;
  });
  const f = fixture({ oauthProviders: () => [provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login(LOGIN_BODY);
  assert.equal(
    f.loginStatus(answer.session_id).state,
    LoginSessionState.Pending,
  );
  f.loginCode(answer.session_id, MANUAL_VALUE);
  assert.equal(await received.promise, MANUAL_VALUE);
  assert.equal(
    (await terminalStatus(f, answer.session_id)).state,
    LoginSessionState.Completed,
  );
});

for (const shutdown of ["stop", "quiesce"] as const) {
  test(`OAuth ${shutdown} aborts running work and refuses late persistence`, async (t) => {
    const gate = gatedLogin();
    const f = fixture({ oauthProviders: () => [gate.provider] });
    t.after(async () => {
      await f.component.stop();
      f.store.close();
    });
    const answer = await f.login(LOGIN_BODY);
    await f.component[shutdown]();
    assert.ok((await gate.entered.promise).signal.aborted);
    gate.result.resolve(oauthCredential);
    const status = await terminalStatus(f, answer.session_id);
    await setImmediate();
    assert.equal(status.state, LoginSessionState.Failed);
    assert.equal(credentialCount(f), NO_CREDENTIALS);
    await assert.rejects(f.login({ ...LOGIN_BODY, name: "after-stop" }));
  });
}

test("OAuth waiting for an address observes caller cancellation", async (t) => {
  const entered = Promise.withResolvers<ProviderAuthInteraction>();
  const provider = fakeProvider(async (interaction) => {
    entered.resolve(interaction);
    await interaction.prompt({ type: "manual_code", message: "Code" });
    return oauthCredential;
  });
  const f = fixture({ oauthProviders: () => [provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const context = new CancellationContext();
  f.caller.context = context;
  const pending = f.login(LOGIN_BODY);
  const rejected = assert.rejects(pending, (error) => error === context.err());
  const interaction = await entered.promise;
  context.cancel();
  await rejected;
  assert.ok(interaction.signal.aborted);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
});

test("OAuth pre-address failures preserve OperationError and sanitize arbitrary provider errors", async (t) => {
  for (const original of [
    new OperationError(
      HttpStatus.Conflict,
      NAME_CONFLICT_CODE,
      "Credential name already exists.",
    ),
    new Error(oauthCredential.refresh),
  ]) {
    const provider = fakeProvider(async () => {
      throw original;
    });
    const f = fixture({ oauthProviders: () => [provider] });
    t.after(async () => {
      await f.component.stop();
      f.store.close();
    });
    await assert.rejects(f.login(LOGIN_BODY), (error) => {
      if (original instanceof OperationError) assert.equal(error, original);
      else {
        assert.ok(error instanceof Error);
        assert.equal(error.message, LOGIN_FAILED_MESSAGE);
      }
      noOAuthSecret(error);
      return true;
    });
    assert.equal(credentialCount(f), NO_CREDENTIALS);
  }
});

test("OAuth unsupported select options fail without an address or a credential", async (t) => {
  const provider = fakeProvider(async (interaction) => {
    await interaction.prompt({
      type: "select",
      message: "Mode",
      options: [{ id: "unsupported", label: "Unsupported" }],
    });
    return oauthCredential;
  });
  const f = fixture({ oauthProviders: () => [provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  await assert.rejects(f.login(LOGIN_BODY), { message: LOGIN_FAILED_MESSAGE });
  assert.equal(credentialCount(f), NO_CREDENTIALS);
});

test("OAuth auth_url records a browser address with a null code", async (t) => {
  const gate = Promise.withResolvers<OAuthCredential>();
  const provider = fakeProvider(async (interaction) => {
    interaction.notify({ type: "auth_url", url: LOGIN_ADDRESS });
    return await gate.promise;
  });
  const f = fixture({ oauthProviders: () => [provider] });
  t.after(async () => {
    await f.component.stop();
    f.store.close();
  });
  const answer = await f.login(LOGIN_BODY);
  assert.equal(answer.address, LOGIN_ADDRESS);
  assert.equal(answer.code, null);
  assert.equal(
    f.loginStatus(answer.session_id).state,
    LoginSessionState.Pending,
  );
});

test("lifecycle aborts logins and joins cancellation", async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.component.healthcheck()).login,
      HealthStatus.Unavailable,
    );
    assert.equal(await f.component.start(), null);
    assert.equal((await f.component.healthcheck()).login, HealthStatus.Healthy);
    assert.equal(await f.component.quiesce(), null);
    await assert.rejects(f.login(LOGIN_BODY), {
      code: "llm.lifecycle.stopped",
    });
    assert.equal(await f.component.stop(), null);
    assert.ok((await f.component.start()) instanceof Error);
    const other = fixture();
    const context = new CancellationContext();
    const running = other.component.run(context);
    context.cancel();
    assert.equal(await running, context.err());
    other.store.close();
  } finally {
    f.store.close();
  }
});

test("platform list answers the LLM platform table", (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const answer = f.platformList();
  assert.deepEqual(
    answer.items.map(({ platform }) => platform).toSorted(),
    Object.keys(LLM_PLATFORMS).toSorted(),
  );
  const byPlatform = new Map(
    answer.items.map((entry) => [entry.platform, entry]),
  );
  assert.equal(byPlatform.has("github"), false);
  assert.equal(byPlatform.has("s3"), false);
  assert.deepEqual(byPlatform.get(Platform.OpenAICodex), {
    platform: Platform.OpenAICodex,
    secret_shape: SecretShape.OAuth,
    login_modes: ["browser", "device"],
    metadata_fields: [],
    verifiable: true,
  });
  assert.deepEqual(byPlatform.get(Platform.GitHubCopilot)?.login_modes, [
    "device",
  ]);
  assert.deepEqual(byPlatform.get(Platform.OpenAICompatible)?.metadata_fields, [
    "base_url",
  ]);
  assert.deepEqual(byPlatform.get(Platform.CloudflareAIGateway), {
    platform: Platform.CloudflareAIGateway,
    secret_shape: SecretShape.ApiKey,
    login_modes: [],
    metadata_fields: ["account_id", "gateway_id"],
    verifiable: false,
  });
  assert.equal(byPlatform.get(Platform.OpenAI)?.verifiable, true);
  assert.equal(byPlatform.get("groq")?.verifiable, false);
});

const GROQ = "groq";

test("create accepts a plain api_key record for groq and refuses metadata", (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  fails(
    () =>
      f.create({
        name: GROQ,
        platform: GROQ,
        secret: apiSecret,
        metadata: { region: "x" },
      }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
  fails(
    () =>
      f.create({
        name: GROQ,
        platform: GROQ,
        secret: { access_key_id: "id", secret_access_key: secretValue },
        metadata: null,
      }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
  const answer = f.create({
    name: GROQ,
    platform: GROQ,
    secret: apiSecret,
    metadata: null,
  }) as CredentialAnswer;
  assert.equal(answer.platform, GROQ);
  assert.equal(answer.revisions[0]!.metadata, null);
  noSecret(answer);
});

const llmMetadataCases = [
  {
    platform: Platform.AmazonBedrock,
    metadata: { region: "us-east-1" },
    edited: { region: "eu-west-1" },
  },
  {
    platform: Platform.GoogleVertex,
    metadata: { project: "project", location: "us-central1" },
    edited: { project: "project", location: "europe-west4" },
  },
  {
    platform: Platform.AzureOpenAIResponses,
    metadata: { resource_name: "resource" },
    edited: { resource_name: "other" },
  },
  {
    platform: Platform.CloudflareWorkersAI,
    metadata: { account_id: "account" },
    edited: { account_id: "other" },
  },
  {
    platform: Platform.CloudflareAIGateway,
    metadata: { account_id: "account", gateway_id: "gateway" },
    edited: { account_id: "account", gateway_id: "other" },
  },
];

for (const { platform, metadata, edited } of llmMetadataCases) {
  test(`${platform} create and metadata edit accept its metadata schema and refuse other metadata`, (t) => {
    const f = fixture();
    t.after(() => f.store.close());
    const refused: unknown[] = [
      null,
      {},
      { ...metadata, extra: "x" },
      ...Object.keys(metadata).map((field) => ({ ...metadata, [field]: " " })),
    ];
    for (const invalid of refused)
      fails(
        () =>
          f.create({
            name: "llm",
            platform,
            secret: apiSecret,
            metadata: invalid,
          }),
        HttpStatus.BadRequest,
        INVALID_INPUT_CODE,
      );
    const created = f.create({
      name: "llm",
      platform,
      secret: apiSecret,
      metadata,
    }) as CredentialAnswer;
    assert.deepEqual(created.revisions[0]!.metadata, metadata);
    for (const invalid of refused)
      fails(
        () =>
          f.updateMetadata("llm", {
            expected_revision: FIRST_REVISION,
            metadata: invalid,
          }),
        HttpStatus.BadRequest,
        INVALID_INPUT_CODE,
      );
    const updated = f.updateMetadata("llm", {
      expected_revision: FIRST_REVISION,
      metadata: edited,
    }) as CredentialAnswer;
    assert.equal(updated.revisions[0]!.revision, NEXT_REVISION);
    assert.deepEqual(updated.revisions[0]!.metadata, edited);
    noSecret(updated);
  });
}

const HEALTH_SECRET = "test_private-resource-health-secret";
const HEALTH_BASE_URL = "https://models.example/v1";
const healthCredentials = [
  {
    name: "anthropic",
    platform: Platform.Anthropic,
    metadata: null,
    capability: "model-list read",
    url: "https://api.anthropic.com/v1/models",
  },
  {
    name: "compatible",
    platform: Platform.OpenAICompatible,
    metadata: { base_url: HEALTH_BASE_URL, models: [] },
    capability: "model-list read",
    url: `${HEALTH_BASE_URL}/models`,
  },
  {
    name: "openai",
    platform: Platform.OpenAI,
    metadata: null,
    capability: "model-list read",
    url: "https://api.openai.com/v1/models",
  },
  {
    name: "groq",
    platform: "groq",
    metadata: null,
    capability: "none",
    url: null,
  },
];

test("inventory lists only LLM records with their capability and dispatches each probe", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  for (const credential of healthCredentials)
    f.create({
      name: credential.name,
      platform: credential.platform,
      secret: { key: HEALTH_SECRET },
      metadata: credential.metadata,
    });
  f.store.transaction((tx) => {
    f.custody.create(
      tx,
      { platforms: REPOSITORY_PLATFORMS },
      {
        name: "github",
        platform: "github",
        secret: { key: HEALTH_SECRET },
        metadata: null,
      },
      undefined,
    );
    f.custody.createLoginRevision(
      tx,
      { platforms: LLM_PLATFORMS },
      "copilot",
      Platform.GitHubCopilot,
      { refresh: "refresh", access: "access", expires: 0 },
      CLOCK_START,
    );
  });
  const urls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    urls.push(url);
    return Response.json({ object: "list", data: [] });
  });
  const entries = f.store.transaction((tx) =>
    f.component.resourceInventory(tx),
  );
  assert.deepEqual(
    entries.map(({ name, capability }) => ({ name, capability })),
    [
      { name: "anthropic", capability: "model-list read" },
      { name: "compatible", capability: "model-list read" },
      { name: "copilot", capability: "copilot token read" },
      { name: "groq", capability: "none" },
      { name: "openai", capability: "model-list read" },
    ],
  );
  const results = await Promise.all(
    entries.map(({ check }) => check(background)),
  );
  assert.deepEqual(results, [
    "healthy",
    "healthy",
    "unknown",
    "unknown",
    "healthy",
  ]);
  assert.deepEqual(
    urls,
    healthCredentials.flatMap(({ url }) => (url === null ? [] : [url])),
  );
  assert.ok(!JSON.stringify(entries).includes(HEALTH_SECRET));
});

test("provider capability answers the capability of the LLM provider of a credential", (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  for (const credential of healthCredentials)
    f.create({
      name: credential.name,
      platform: credential.platform,
      secret: { key: HEALTH_SECRET },
      metadata: credential.metadata,
    });
  const capability = (name: string) =>
    f.store.transaction((tx) => f.component.providerCapability(tx, name));
  assert.equal(capability("anthropic"), CAPABILITY_MODEL_LIST_READ);
  assert.equal(capability("groq"), CAPABILITY_NONE);
  assert.equal(capability("missing"), CAPABILITY_NONE);
});

test("provider healthchecks call the LLM provider check of every LLM platform with a check", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.create({
    name: "anthropic",
    platform: Platform.Anthropic,
    secret: { key: HEALTH_SECRET },
    metadata: null,
  });
  f.create({
    name: "groq",
    platform: "groq",
    secret: { key: HEALTH_SECRET },
    metadata: null,
  });
  f.store.transaction((tx) => {
    f.custody.create(
      tx,
      { platforms: REPOSITORY_PLATFORMS },
      {
        name: "github",
        platform: "github",
        secret: { key: HEALTH_SECRET },
        metadata: null,
      },
      undefined,
    );
    f.custody.createLoginRevision(
      tx,
      { platforms: LLM_PLATFORMS },
      "copilot",
      Platform.GitHubCopilot,
      {
        refresh: "refresh",
        access: "access",
        expires: Date.now() + SESSION_EXPIRY_MS,
      },
      CLOCK_START,
    );
  });
  const urls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    urls.push(url);
    return new Response(null, {
      status:
        url === ANTHROPIC_MODELS_URL ? HttpStatus.Forbidden : HttpStatus.OK,
    });
  });
  const checks = f.store.transaction((tx) =>
    ["anthropic", "groq", "copilot", "github", "missing"].map((name) =>
      f.component.providerHealthCheck(tx, name),
    ),
  );
  const results = await Promise.all(checks.map((check) => check(background)));
  assert.deepEqual(results, [
    "unhealthy",
    "unknown",
    "healthy",
    "unknown",
    "unknown",
  ]);
  assert.deepEqual(urls, [ANTHROPIC_MODELS_URL, GITHUB_COPILOT_TOKEN_URL]);
});

const NO_FETCH_CALLS = 0;
const PROVIDER_INVALID_INPUT_CODE = "llm.provider.invalid_input";
const PROVIDER_CHECK_UNSUPPORTED_CODE = "llm.provider.check_unsupported";
const PROVIDER_CREDENTIAL_NOT_FOUND_CODE = "llm.provider.credential_not_found";

async function failsAsync(
  fn: () => Promise<unknown>,
  status: number,
  code: string,
) {
  await assert.rejects(
    fn,
    (error) =>
      error instanceof OperationError &&
      error.status === status &&
      error.code === code,
  );
}

test("provider check answers the connection and model list of an LLM credential without its key", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.create({
    name: "compatible",
    platform: Platform.OpenAICompatible,
    secret: { key: HEALTH_SECRET },
    metadata: { base_url: HEALTH_BASE_URL, models: [] },
  });
  const requests: { url: unknown; signal: unknown }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, options?: RequestInit) => {
      requests.push({ url, signal: options?.signal });
      return Response.json({
        object: "list",
        data: [{ id: "alpha", owned_by: "lab", created: 1 }],
      });
    },
  );
  const answer = await f.providerCheck({ credential: "compatible" });
  assert.deepEqual(answer, {
    connection: "ok",
    models: [{ id: "alpha", owned_by: "lab", created: 1 }],
  });
  assert.deepEqual(
    requests.map(({ url }) => url),
    [`${HEALTH_BASE_URL}/models`],
  );
  assert.ok(requests[0]!.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(answer).includes(HEALTH_SECRET));
});

test("provider check refuses invalid input, an unknown or foreign credential and a platform without a check", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  f.create({
    name: "groq",
    platform: "groq",
    secret: { key: HEALTH_SECRET },
    metadata: null,
  });
  f.store.transaction((tx) =>
    f.custody.create(
      tx,
      { platforms: REPOSITORY_PLATFORMS },
      {
        name: "github",
        platform: "github",
        secret: { key: HEALTH_SECRET },
        metadata: null,
      },
      undefined,
    ),
  );
  for (const body of [
    null,
    {},
    { credential: "" },
    { credential: 1 },
    {
      credential: "groq",
      extra: true,
    },
  ])
    await failsAsync(
      () => f.providerCheck(body),
      HttpStatus.BadRequest,
      PROVIDER_INVALID_INPUT_CODE,
    );
  for (const credential of ["missing", "github"])
    await failsAsync(
      () => f.providerCheck({ credential }),
      HttpStatus.NotFound,
      PROVIDER_CREDENTIAL_NOT_FOUND_CODE,
    );
  await failsAsync(
    () => f.providerCheck({ credential: "groq" }),
    HttpStatus.BadRequest,
    PROVIDER_CHECK_UNSUPPORTED_CODE,
  );
  assert.equal(fetch.mock.callCount(), NO_FETCH_CALLS);
});

test("approved models answer the openai-compatible metadata models with defaults and nothing for another credential", (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.create({
    name: "compatible",
    platform: Platform.OpenAICompatible,
    secret: { key: HEALTH_SECRET },
    metadata: { base_url: HEALTH_BASE_URL, models: [] },
  });
  f.updateMetadata("compatible", {
    expected_revision: FIRST_REVISION,
    metadata: {
      base_url: HEALTH_BASE_URL,
      models: [{ id: KEPT_MODEL, reasoning_levels: ["high"] }],
    },
  });
  f.create({
    name: "anthropic",
    platform: Platform.Anthropic,
    secret: { key: HEALTH_SECRET },
    metadata: null,
  });
  const answers = f.store.transaction((tx) =>
    ["compatible", "anthropic", "missing"].map((name) =>
      f.component.approvedModels(tx, name),
    ),
  );
  assert.deepEqual(answers, [
    [
      {
        id: KEPT_MODEL,
        context_window: 128000,
        max_tokens: 16384,
        reasoning_levels: ["high"],
      },
    ],
    null,
    null,
  ]);
});

const CHECK_UNSUPPORTED_CODE = "credential.check.unsupported";
const NO_ROWS = 0;

function rowCount(f: ReturnType<typeof fixture>): number {
  return (
    f.store.database.prepare("SELECT COUNT(*) AS n FROM credential").get() as {
      n: number;
    }
  ).n;
}

test("check answers healthy, unhealthy and unknown through the LLM provider without a row, a log or an answer that holds the key", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const statuses = [
    [HttpStatus.OK, "healthy"],
    [HttpStatus.Forbidden, "unhealthy"],
    [HttpStatus.InternalServerError, "unknown"],
  ] as const;
  const requests: unknown[] = [];
  let next = 0;
  const statusFetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown) => {
      requests.push(url);
      return new Response(null, { status: statuses[next++]![0] });
    },
  );
  for (const [, expected] of statuses) {
    const answer = await f.credentialCheck({
      platform: Platform.Anthropic,
      secret: { key: HEALTH_SECRET },
      metadata: null,
    });
    assert.deepEqual(answer, {
      status: expected,
      capability: CAPABILITY_MODEL_LIST_READ,
    });
    assert.ok(!JSON.stringify(answer).includes(HEALTH_SECRET));
  }
  assert.deepEqual(requests.slice(), [
    ANTHROPIC_MODELS_URL,
    ANTHROPIC_MODELS_URL,
    ANTHROPIC_MODELS_URL,
  ]);
  statusFetch.mock.restore();
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    requests.push(url);
    throw new Error(`failed with ${HEALTH_SECRET}`);
  });
  assert.deepEqual(
    await f.credentialCheck({
      platform: Platform.OpenAICompatible,
      secret: { key: HEALTH_SECRET },
      metadata: { base_url: HEALTH_BASE_URL, models: [] },
    }),
    { status: "unknown", capability: CAPABILITY_MODEL_LIST_READ },
  );
  assert.equal(requests.at(-1), `${HEALTH_BASE_URL}/models`);
  assert.equal(rowCount(f), NO_ROWS);
  assert.ok(!JSON.stringify(f.logs).includes(HEALTH_SECRET));
});

test("check refuses an OAuth platform, a platform without a check, a platform of another component and invalid input", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  const key = { key: HEALTH_SECRET };
  for (const platform of [Platform.GitHubCopilot, "groq"])
    await failsAsync(
      () => f.credentialCheck({ platform, secret: key, metadata: null }),
      HttpStatus.BadRequest,
      CHECK_UNSUPPORTED_CODE,
    );
  for (const platform of ["github", "s3", "unknown"])
    await failsAsync(
      () => f.credentialCheck({ platform, secret: key, metadata: null }),
      HttpStatus.BadRequest,
      UNSUPPORTED_PLATFORM_CODE,
    );
  for (const body of [
    { platform: Platform.Anthropic, secret: { key: "" }, metadata: null },
    { platform: Platform.Anthropic, secret: { key: " " }, metadata: null },
    { platform: Platform.Anthropic, secret: key, metadata: {} },
    { platform: Platform.OpenAICompatible, secret: key, metadata: null },
    {
      platform: Platform.OpenAICompatible,
      secret: key,
      metadata: { base_url: HEALTH_BASE_URL, models: "none" },
    },
  ])
    await failsAsync(
      () => f.credentialCheck(body),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
  assert.throws(() =>
    llmOperations.check.input.parse({
      params: {},
      query: {},
      body: {
        name: "anthropic",
        platform: Platform.Anthropic,
        secret: key,
        metadata: null,
      },
    }),
  );
  assert.equal(fetch.mock.callCount(), NO_FETCH_CALLS);
  assert.equal(rowCount(f), NO_ROWS);
});

const CHECK_PATH = "/api/llm/credential/check";

test("check takes no mutation key", () => {
  assert.equal(llmOperations.check.mutation, false);
  assert.equal(llmOperations.check.method, HttpMethod.Post);
  assert.equal(llmOperations.check.path, CHECK_PATH);
});

const VERIFY_PATH = "/api/llm/credential/:credential_name/verify";
const ARCHIVED_CODE = "credential.credential.archived";

const credentialVerify = (f: ReturnType<typeof fixture>, name: string) =>
  f.invoke(llmOperations.verify, {
    params: { credential_name: name },
    query: {},
    body: null,
  }) as Promise<typeof llmOperations.verify.output._output>;

function credentialRows(f: ReturnType<typeof fixture>): string {
  return JSON.stringify(
    f.store.database.prepare("SELECT * FROM credential ORDER BY id").all(),
  );
}

test("verify answers healthy, unhealthy and unknown like the health report without a write, a log or an answer that holds the key", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.create({
    name: "anthropic",
    platform: Platform.Anthropic,
    secret: { key: HEALTH_SECRET },
    metadata: null,
  });
  const statuses = [
    [HttpStatus.OK, "healthy"],
    [HttpStatus.Forbidden, "unhealthy"],
    [HttpStatus.InternalServerError, "unknown"],
  ] as const;
  const requests: unknown[] = [];
  let next = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    requests.push(url);
    return new Response(null, {
      status: statuses[Math.floor(next++ / 2)]![0],
    });
  });
  const before = credentialRows(f);
  for (const [, expected] of statuses) {
    const answer = await credentialVerify(f, "anthropic");
    const [entry] = f.store.transaction((tx) =>
      f.component.resourceInventory(tx),
    );
    assert.deepEqual(answer, {
      status: expected,
      capability: CAPABILITY_MODEL_LIST_READ,
    });
    assert.equal(await entry!.check(background), expected);
    assert.ok(!JSON.stringify(answer).includes(HEALTH_SECRET));
  }
  assert.equal(requests.length, statuses.length * 2);
  assert.equal(credentialRows(f), before);
  assert.ok(!JSON.stringify(f.logs).includes(HEALTH_SECRET));
});

test("verify answers unknown when the request throws", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.create({
    name: "compatible",
    platform: Platform.OpenAICompatible,
    secret: { key: HEALTH_SECRET },
    metadata: { base_url: HEALTH_BASE_URL, models: [] },
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(`failed with ${HEALTH_SECRET}`);
  });
  assert.deepEqual(await credentialVerify(f, "compatible"), {
    status: "unknown",
    capability: CAPABILITY_MODEL_LIST_READ,
  });
  assert.ok(!JSON.stringify(f.logs).includes(HEALTH_SECRET));
});

test("verify refuses an archived record, a platform without a check, an unknown name and a name of another component", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  f.create({
    name: GROQ,
    platform: GROQ,
    secret: { key: HEALTH_SECRET },
    metadata: null,
  });
  f.create({
    name: "anthropic",
    platform: Platform.Anthropic,
    secret: { key: HEALTH_SECRET },
    metadata: null,
  });
  f.store.transaction((tx) =>
    f.custody.create(
      tx,
      { platforms: REPOSITORY_PLATFORMS },
      {
        name: "github",
        platform: "github",
        secret: { key: HEALTH_SECRET },
        metadata: null,
      },
      undefined,
    ),
  );
  await failsAsync(
    () => credentialVerify(f, GROQ),
    HttpStatus.BadRequest,
    CHECK_UNSUPPORTED_CODE,
  );
  for (const name of ["github", "missing"])
    await failsAsync(
      () => credentialVerify(f, name),
      HttpStatus.NotFound,
      CREDENTIAL_NOT_FOUND_CODE,
    );
  f.archive("anthropic");
  await failsAsync(
    () => credentialVerify(f, "anthropic"),
    HttpStatus.Conflict,
    ARCHIVED_CODE,
  );
  assert.equal(fetch.mock.callCount(), NO_FETCH_CALLS);
});

test("verify takes no body and no mutation key", () => {
  assert.equal(llmOperations.verify.mutation, false);
  assert.equal(llmOperations.verify.method, HttpMethod.Post);
  assert.equal(llmOperations.verify.path, VERIFY_PATH);
  assert.equal(llmOperations.verify.access, AccessPolicy.Human);
  assert.throws(() =>
    llmOperations.verify.input.parse({
      params: { credential_name: "anthropic" },
      query: {},
      body: {},
    }),
  );
});
