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
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { HealthStatus } from "../kernel/service.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  custodyOperations,
  EXECUTION_CREDENTIAL_MAX_BYTES,
  CUSTODY_SERVICE_NAME,
  type CredentialMetadataFn,
  type CustodySuitabilityFn,
  type AgentProvidersDependentOnFn,
  type BindingsNamingFn,
  type InboundsNamingFn,
  type EnablementsDependentOnModelFn,
  type CredentialAnswer,
} from "./contract.ts";
import { decrypt } from "./envelope.ts";
import { custodyMigrations } from "./migrations.ts";
import {
  Platform,
  PLATFORM_VALIDATORS,
  PlatformKind,
  SecretShape,
} from "./platforms.ts";
import { CustodyComponent, type Dependencies } from "./service.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { FacilityError } from "./facility.ts";
import {
  COPILOT_ENTERPRISE_DOMAIN_PLACEHOLDER,
  OAUTH_PROVIDER_IDS,
} from "./login.ts";
import { LoginSessionState, SESSION_EXPIRY_MS } from "./sessions.ts";

const FIRST_REVISION = 1;
const HUMAN_ACCOUNT_ID = "alice";
const NAME_CONFLICT_CODE = "credential.name.conflict";
const REVISION_CONFLICT_CODE = "credential.revision.conflict";
const CREDENTIAL_NOT_FOUND_CODE = "credential.credential.not_found";
const PLATFORM_MISMATCH_CODE = "credential.platform.mismatch";
const MODEL_IN_USE_CODE = "credential.metadata.model_in_use";
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

test("credential creation and rotation enforce the serialized budget before any write", (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const overhead = Buffer.byteLength(
    canonicalJSON({ type: "api_key", key: "" }),
  );
  const maximum = {
    key: "x".repeat(EXECUTION_CREDENTIAL_MAX_BYTES - overhead),
  };
  const oversized = { key: maximum.key + "x" };
  fails(
    () => f.create({ ...inputs[0], secret: oversized }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  const created = f.create({
    ...inputs[0],
    secret: maximum,
  }) as CredentialAnswer;
  const before = f.store.database.prepare("SELECT * FROM credential").all();
  fails(
    () =>
      f.rotate(created.name, {
        expectedRevision: FIRST_REVISION,
        secret: oversized,
      }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
  assert.deepEqual(
    f.store.database.prepare("SELECT * FROM credential").all(),
    before,
  );
  const rotated = f.rotate(created.name, {
    expectedRevision: FIRST_REVISION,
    secret: maximum,
  }) as CredentialAnswer;
  assert.equal(rotated.revisions[0]?.revision, NEXT_REVISION);
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
    const status = await terminalStatus(f, pending.sessionId);
    if (extra.length) {
      assert.equal(status.state, LoginSessionState.Failed);
      assert.equal(status.failureReason, LOGIN_FAILED_MESSAGE);
      assert.equal(credentialCount(f), NO_CREDENTIALS);
      assert.ok(!JSON.stringify(status).includes(access));
    } else {
      assert.equal(status.state, LoginSessionState.Completed);
      assert.equal(credentialCount(f), FIRST_REVISION);
    }
  }
});
const unusedExecutionDependencies = {
  executions: {
    requireRunning: unexpectedCollaboration,
    pinCredential: unexpectedCollaboration,
    liveExecutionsPinning: () => [],
  },
  authorization: { authorizeModelInference: unexpectedCollaboration },
  clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
};
const inputs = [
  {
    name: "github",
    platform: Platform.GitHub,
    secret: apiSecret,
    metadata: null,
  },
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
    metadata: { baseUrl: "https://example.com/v1", models: [] },
  },
  {
    name: "storage",
    platform: Platform.S3,
    secret: { accessKeyId: "id", secretAccessKey: secretValue },
    metadata: {
      endpoint: "https://example.com",
      bucket: "bucket",
      region: "region",
    },
  },
];

function fixture(
  collaborations: {
    oauthProviders?: () => readonly Provider[];
    now?: () => number;
    agentProvidersDependentOn?: AgentProvidersDependentOnFn;
    bindingsNaming?: BindingsNamingFn;
    inboundsNaming?: InboundsNamingFn;
    enablementsDependentOnModel?: EnablementsDependentOnModelFn;
    pins?: Map<string, string[]>;
    authorization?: Dependencies["authorization"];
    executions?: Dependencies["executions"];
  } = {},
) {
  const store = new Store(IN_MEMORY_DATABASE);
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const logs: { credentialId: string; humanIdentity: string }[] = [];
  const logger = {
    info: (record: { credentialId: string; humanIdentity: string }) =>
      logs.push(record),
  } as unknown as Logger;
  const health = new HealthRegistry();
  const component = new CustodyComponent({
    ...unusedExecutionDependencies,
    authorization:
      collaborations.authorization ?? unusedExecutionDependencies.authorization,
    executions: collaborations.executions ?? {
      requireRunning: unexpectedCollaboration,
      pinCredential: (_tx, executionId, credentialId) => {
        collaborations.pins?.set(credentialId, [executionId]);
      },
      liveExecutionsPinning: (_tx, credentialId) =>
        collaborations.pins?.get(credentialId) ?? [],
    },
    store,
    oauthProviders: collaborations.oauthProviders,
    now: collaborations.now,
    envelopeKey: key,
    logger,
    health,
    agentProvidersDependentOn:
      collaborations.agentProvidersDependentOn ?? (() => []),
    bindingsNaming: collaborations.bindingsNaming ?? (() => []),
    inboundsNaming: collaborations.inboundsNaming ?? (() => []),
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
    operation: (typeof custodyOperations)[keyof typeof custodyOperations],
    input: unknown,
  ): unknown {
    const parsed = operation.input.parse(input);
    return registry.get(operation.id).handler(parsed, caller);
  }
  const create = (body: unknown) =>
    invoke(custodyOperations.create, { params: {}, query: {}, body });
  const get = (name: string) =>
    invoke(custodyOperations.get, {
      params: { credentialName: name },
      query: {},
      body: null,
    });
  const list = (query: Record<string, unknown> = {}) =>
    invoke(custodyOperations.list, { params: {}, query, body: null });
  const rotate = (name: string, body: unknown) =>
    invoke(custodyOperations.rotate, {
      params: { credentialName: name },
      query: {},
      body,
    });
  const updateMetadata = (name: string, body: unknown) =>
    invoke(custodyOperations.update_metadata, {
      params: { credentialName: name },
      query: {},
      body,
    });
  const platformList = () =>
    invoke(custodyOperations.platform_list, {
      params: {},
      query: {},
      body: null,
    }) as typeof custodyOperations.platform_list.output._output;
  const revoke = (name: string, revision: number) =>
    invoke(custodyOperations.revoke, {
      params: { credentialName: name, revision },
      query: {},
      body: null,
    });
  const login = async (body: unknown) =>
    (await invoke(custodyOperations.login, {
      params: {},
      query: {},
      body,
    })) as typeof custodyOperations.login.output._output;
  const loginCode = (sessionId: string, value: string) =>
    invoke(custodyOperations.login_code, {
      params: { sessionId },
      query: {},
      body: { value },
    });
  const loginStatus = (sessionId: string) =>
    invoke(custodyOperations.login_status, {
      params: { sessionId },
      query: {},
      body: null,
    }) as typeof custodyOperations.login_status.output._output;
  return {
    store,
    component,
    caller,
    login,
    loginCode,
    loginStatus,
    lastTransaction: () => lastTransaction,
    registry,
    health,
    logs,
    create,
    get,
    list,
    rotate,
    updateMetadata,
    revoke,
    platformList,
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

test("create validates platforms, schema, conflicts and encrypts each first revision", () => {
  const f = fixture();
  try {
    for (const input of inputs) {
      const answer = f.create(input) as {
        revisions: { id: string; revision: number }[];
      };
      assert.equal(answer.revisions.length, FIRST_REVISION);
      assert.equal(answer.revisions[0]!.revision, FIRST_REVISION);
      noSecret(answer);
      const row = f.store.database
        .prepare("SELECT nonce, ciphertext FROM credential WHERE id = ?")
        .get(answer.revisions[0]!.id) as { nonce: Buffer; ciphertext: Buffer };
      assert.deepEqual(
        decrypt(
          key,
          answer.revisions[0]!.id,
          input.platform,
          row.nonce,
          row.ciphertext,
        ),
        input.secret,
      );
      assert.equal(f.logs.at(-1)?.credentialId, answer.revisions[0]!.id);
      assert.equal(f.logs.at(-1)?.humanIdentity, HUMAN_ACCOUNT_ID);
    }
    const id = (f.get("github") as { revisions: { id: string }[] })
      .revisions[0]!.id;
    assert.throws(
      () => f.create(inputs[0]),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === NAME_CONFLICT_CODE &&
        (error.details as { id: string }).id === id,
    );
    fails(
      () => f.create({ ...inputs[0], name: "login" }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () => f.create({ ...inputs[0], name: "platform" }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () =>
        f.create({
          ...inputs[2],
          name: "nonempty-models",
          metadata: { ...inputs[2]!.metadata, models: [{ id: "gpt" }] },
        }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () => f.create({ ...inputs[0], platform: Platform.GitHubCopilot }),
      HttpStatus.BadRequest,
      "credential.entry.unsupported",
    );
    fails(
      () => f.create({ ...inputs[0], platform: "unknown" }),
      HttpStatus.BadRequest,
      "credential.platform.unsupported",
    );
    fails(
      () => f.create({ ...inputs[0], name: "invalid-secret", secret: {} }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    fails(
      () => f.create({ ...inputs[0], name: "invalid-metadata", metadata: {} }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    assert.ok(!JSON.stringify(f.logs).includes(secretValue));
  } finally {
    f.store.close();
  }
});

test("get orders revisions and list paginates sorted names with filters", () => {
  const f = fixture();
  try {
    for (const input of inputs) f.create(input);
    const first = f.get("github") as { revisions: { id: string }[] };
    f.store.database
      .prepare(
        "INSERT INTO credential SELECT ?, name, platform, ?, nonce, ciphertext, metadata, created_at + ?, ended_at FROM credential WHERE id = ?",
      )
      .run("credential_second", 2, 1, first.revisions[0]!.id);
    const got = f.get("github") as { revisions: { id: string }[] };
    assert.deepEqual(
      got.revisions.map((revision) => revision.id),
      ["credential_second", first.revisions[0]!.id],
    );
    noSecret(got);
    fails(
      () => f.get("missing"),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    const filtered = f.list({ platform: Platform.S3 }) as {
      items: { name: string }[];
    };
    assert.deepEqual(
      filtered.items.map((item) => item.name),
      ["storage"],
    );
    assert.deepEqual(
      (f.list({ platform: "invalid" }) as { items: unknown[] }).items,
      [],
    );
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const page = f.list({
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      }) as { items: { name: string }[]; nextCursor: string | null };
      noSecret(page);
      names.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor !== null && names.length < inputs.length + 1);
    assert.deepEqual(names, ["anthropic", "github", "openai", "storage"]);
    assert.equal(cursor, null);
    fails(
      () => f.list({ cursor: "%%%" }),
      HttpStatus.BadRequest,
      "system.pagination.cursor_invalid",
    );
  } finally {
    f.store.close();
  }
});

test("rotate copies or replaces metadata, allows new base URL and guards revisions", () => {
  const f = fixture();
  try {
    f.create(inputs[3]);
    const copied = f.rotate("storage", {
      expectedRevision: FIRST_REVISION,
      secret: inputs[3]!.secret,
    }) as { revisions: { id: string; revision: number; metadata: unknown }[] };
    assert.deepEqual(copied.revisions[0]!.metadata, inputs[3]!.metadata);
    assert.equal(copied.revisions[0]!.revision, NEXT_REVISION);
    noSecret(copied);
    const replacement = { ...inputs[3]!.metadata, bucket: "other" };
    const replaced = f.rotate("storage", {
      expectedRevision: NEXT_REVISION,
      secret: inputs[3]!.secret,
      metadata: replacement,
    }) as { revisions: { id: string; revision: number; metadata: unknown }[] };
    assert.deepEqual(replaced.revisions[0]!.metadata, replacement);
    assert.equal(replaced.revisions[0]!.revision, THIRD_REVISION);
    noSecret(replaced);
    assert.throws(
      () =>
        f.rotate("storage", {
          expectedRevision: FIRST_REVISION,
          secret: apiSecret,
        }),
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === REVISION_CONFLICT_CODE &&
        (error.details as { revision: number }).revision === THIRD_REVISION,
    );
    f.create(inputs[2]);
    const changed = f.rotate("openai", {
      expectedRevision: FIRST_REVISION,
      secret: apiSecret,
      metadata: {
        baseUrl: ROTATED_BASE_URL,
        models: [{ id: "new" }],
      },
    }) as { revisions: { id: string; metadata: { baseUrl: string } }[] };
    assert.equal(changed.revisions[0]!.metadata.baseUrl, ROTATED_BASE_URL);
    noSecret(changed);
    fails(
      () =>
        f.rotate("missing", {
          expectedRevision: FIRST_REVISION,
          secret: apiSecret,
        }),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    fails(
      () =>
        f.rotate("storage", { expectedRevision: THIRD_REVISION, secret: {} }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    assert.equal(f.logs.at(-1)?.credentialId, changed.revisions[0]!.id);
    assert.equal(f.logs.at(-1)?.humanIdentity, HUMAN_ACCOUNT_ID);
    assert.ok(!JSON.stringify(f.logs).includes(secretValue));
  } finally {
    f.store.close();
  }
});

test("two rotations with the same expected revision reject the second", () => {
  const f = fixture();
  try {
    f.create(inputs[0]);
    noSecret(
      f.rotate("github", {
        expectedRevision: FIRST_REVISION,
        secret: apiSecret,
      }),
    );
    fails(
      () =>
        f.rotate("github", {
          expectedRevision: FIRST_REVISION,
          secret: apiSecret,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
  } finally {
    f.store.close();
  }
});

test("metadata edits re-encrypt under new identity and enforce base URL and revision", () => {
  const f = fixture();
  try {
    f.create(inputs[2]);
    const metadata = { ...inputs[2]!.metadata, models: [{ id: "added" }] };
    const answer = f.updateMetadata("openai", {
      expectedRevision: FIRST_REVISION,
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
          expectedRevision: NEXT_REVISION,
          metadata: { ...metadata, baseUrl: ROTATED_BASE_URL },
        }),
      HttpStatus.Conflict,
      "credential.metadata.base_url_fixed",
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expectedRevision: FIRST_REVISION,
          metadata,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
    fails(
      () =>
        f.updateMetadata("missing", {
          expectedRevision: FIRST_REVISION,
          metadata,
        }),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expectedRevision: NEXT_REVISION,
          metadata: {},
        }),
      HttpStatus.BadRequest,
      "credential.input.invalid",
    );
    assert.equal(f.logs.at(-1)?.credentialId, row.id);
    assert.equal(f.logs.at(-1)?.humanIdentity, HUMAN_ACCOUNT_ID);
    assert.ok(!JSON.stringify(f.logs).includes(secretValue));
  } finally {
    f.store.close();
  }
});

test("two metadata edits with the same expected revision reject the second", () => {
  const f = fixture();
  try {
    f.create(inputs[0]);
    noSecret(
      f.updateMetadata("github", {
        expectedRevision: FIRST_REVISION,
        metadata: null,
      }),
    );
    fails(
      () =>
        f.updateMetadata("github", {
          expectedRevision: FIRST_REVISION,
          metadata: null,
        }),
      HttpStatus.Conflict,
      REVISION_CONFLICT_CODE,
    );
  } finally {
    f.store.close();
  }
});

test("rotation drains unpinned revisions while reads drain released pins", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    const first = created.revisions[0]!.id;
    pins.set(first, ["live-execution"]);
    const rotated = f.rotate("github", {
      expectedRevision: FIRST_REVISION,
      secret: apiSecret,
    }) as CredentialAnswer;
    assert(rotated.revisions.every((row) => row.endedAt === null));
    pins.clear();
    const read = f.get("github") as CredentialAnswer;
    assert.notEqual(read.revisions[1]!.endedAt, null);
    assert.equal(read.revisions[0]!.endedAt, null);
    const again = f.rotate("github", {
      expectedRevision: NEXT_REVISION,
      secret: apiSecret,
    }) as CredentialAnswer;
    assert.notEqual(again.revisions[1]!.endedAt, null);
    assert.equal(again.revisions[0]!.endedAt, null);
    fails(
      () => f.revoke("github", NEXT_REVISION),
      HttpStatus.Conflict,
      "credential.revision.ended",
    );
  } finally {
    f.store.close();
  }
});

test("list drains every returned name and revoke drains other unpinned revisions", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    for (const input of inputs.slice(0, 2)) {
      const created = f.create(input) as CredentialAnswer;
      pins.set(created.revisions[0]!.id, ["live-execution"]);
      f.rotate(input.name, {
        expectedRevision: FIRST_REVISION,
        secret: apiSecret,
      });
    }
    pins.clear();
    const page = f.list() as { items: CredentialAnswer[] };
    for (const item of page.items) {
      assert.notEqual(item.revisions[1]!.endedAt, null);
      assert.equal(item.revisions[0]!.endedAt, null);
    }
    const current = f.get("github") as CredentialAnswer;
    pins.set(current.revisions[0]!.id, ["live-execution"]);
    const third = f.rotate("github", {
      expectedRevision: NEXT_REVISION,
      secret: apiSecret,
    }) as CredentialAnswer;
    pins.set(third.revisions[0]!.id, ["live-execution"]);
    f.rotate("github", { expectedRevision: THIRD_REVISION, secret: apiSecret });
    pins.clear();
    const revoked = f.revoke("github", THIRD_REVISION) as CredentialAnswer;
    assert.equal(revoked.revisions[0]!.endedAt, null);
    assert(revoked.revisions.slice(1).every((row) => row.endedAt !== null));
  } finally {
    f.store.close();
  }
});

test("pinned metadata retains a rotated revision without creating a pin and refuses revocation", () => {
  const noPins = 0;
  const credentials: string[] = [];
  const execution = {
    executionId: "execution-one",
    runtimeIdentity: createIdentity("worker_instance"),
  };
  const f = fixture({
    executions: {
      requireRunning: (tx, executionId, runtimeIdentity) => {
        assert.ok(tx.database.isTransaction);
        assert.equal(executionId, execution.executionId);
        assert.equal(runtimeIdentity, execution.runtimeIdentity);
        return {
          ...execution,
          projectId: createIdentity("project"),
          workerBindingId: "binding-one",
          resourceIdentity: "worker:kanthord:general",
          credentials,
        };
      },
      pinCredential: unexpectedCollaboration,
      liveExecutionsPinning: (_tx, id) =>
        credentials.includes(id) ? [execution.executionId] : [],
    },
  });
  const metadata = () =>
    f.store.transaction((tx) =>
      f.component.pinnedCredentialMetadata(tx, execution, "github", Date.now()),
    );
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    assert.equal(metadata(), null);
    assert.equal(credentials.length, noPins);
    credentials.push(created.revisions[0]!.id);
    f.rotate("github", { expectedRevision: FIRST_REVISION, secret: apiSecret });
    assert.deepEqual(metadata(), {
      id: created.revisions[0]!.id,
      name: "github",
      platform: Platform.GitHub,
      metadata: null,
    });
    assert.deepEqual(credentials, [created.revisions[0]!.id]);
    f.revoke("github", FIRST_REVISION);
    fails(metadata, HttpStatus.Conflict, "credential.revision.revoked");
    assert.deepEqual(credentials, [created.revisions[0]!.id]);
  } finally {
    f.store.close();
  }
});

test("protected release pins once, keeps rotation overlap and refuses revoked or unauthorized material", () => {
  const pins = new Map<string, string[]>();
  const credentials: string[] = [];
  const execution = {
    executionId: "execution-one",
    projectId: createIdentity("project"),
    workerBindingId: "binding-one",
    resourceIdentity: "worker:kanthord:general",
    runtimeIdentity: createIdentity("worker_instance"),
    credentials,
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: execution.projectId,
      resourceIdentity: execution.resourceIdentity,
      name: "machine",
      issuedAt: 0,
    },
    "jti",
    execution.runtimeIdentity,
  );
  let platform: string = Platform.GitHub;
  let refused = false;
  const f = fixture({
    pins,
    authorization: {
      authorizeModelInference: () => {
        if (refused) throw new Error("authorization refused");
        return {
          credential: "github",
          platform,
          providerId: platform,
          agentProvider: "default",
        };
      },
    },
    executions: {
      requireRunning: unexpectedCollaboration,
      pinCredential: (_tx, executionId, credentialId) => {
        credentials.push(credentialId);
        pins.set(credentialId, [executionId]);
      },
      liveExecutionsPinning: (_tx, credentialId) =>
        pins.get(credentialId) ?? [],
    },
  });
  const release = () =>
    f.store.transaction((tx) => {
      const grant = f.component.authorize(tx, identity, execution);
      const material = f.component.release(tx, grant, Date.now());
      try {
        assert.deepEqual(material.value(), apiSecret);
        assert.throws(
          () => f.component.release(tx, grant, Date.now()),
          FacilityError,
        );
        return material.credentialId;
      } finally {
        material.drop();
      }
    });
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    assert.equal(release(), created.revisions[0]!.id);
    assert.deepEqual(credentials, [created.revisions[0]!.id]);
    f.rotate("github", { expectedRevision: FIRST_REVISION, secret: apiSecret });
    assert.equal(release(), created.revisions[0]!.id);
    assert.deepEqual(credentials, [created.revisions[0]!.id]);
    platform = Platform.S3;
    fails(release, HttpStatus.BadRequest, PLATFORM_MISMATCH_CODE);
    platform = Platform.GitHub;
    refused = true;
    assert.throws(release, /authorization refused/);
    refused = false;
    f.revoke("github", FIRST_REVISION);
    fails(release, HttpStatus.Conflict, "credential.revision.revoked");
    credentials.length = 0;
    const latest = f.get("github") as CredentialAnswer;
    execution.executionId = "execution-two";
    assert.equal(release(), latest.revisions[0]!.id);
    noSecret(f.logs);
  } finally {
    f.store.close();
  }
});

test("revoke ends only an older live revision", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    pins.set(created.revisions[0]!.id, ["live-execution"]);
    f.rotate("github", { expectedRevision: FIRST_REVISION, secret: apiSecret });
    fails(
      () => f.revoke("github", NEXT_REVISION),
      HttpStatus.Conflict,
      "credential.revision.newest_live",
    );
    const answer = f.revoke("github", FIRST_REVISION) as {
      revisions: { revision: number; endedAt: number | null }[];
    };
    assert.equal(answer.revisions[0]!.endedAt, null);
    assert.equal(answer.revisions[1]!.revision, FIRST_REVISION);
    assert.ok(answer.revisions[1]!.endedAt !== null);
    noSecret(answer);
    fails(
      () => f.revoke("github", FIRST_REVISION),
      HttpStatus.Conflict,
      "credential.revision.ended",
    );
    fails(
      () => f.revoke("github", THIRD_REVISION),
      HttpStatus.NotFound,
      "credential.revision.not_found",
    );
  } finally {
    f.store.close();
  }
});

test("a repeated approved model id answers invalid input at create, rotate and update-metadata and stores nothing", () => {
  const f = fixture({ pins: new Map() });
  try {
    const duplicated = {
      baseUrl: "https://example.com/v1",
      models: [{ id: "same" }, { id: "same", maxTokens: 1000 }],
    };
    fails(
      () => f.create({ ...inputs[2], name: "dup", metadata: duplicated }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
    assert.equal(credentialCount(f), NO_CREDENTIALS);
    f.create(inputs[2]);
    fails(
      () =>
        f.rotate("openai", {
          expectedRevision: FIRST_REVISION,
          secret: apiSecret,
          metadata: duplicated,
        }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
    fails(
      () =>
        f.updateMetadata("openai", {
          expectedRevision: FIRST_REVISION,
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
  const f = fixture({ pins: new Map() });
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
          metadata: { baseUrl: "https://example.com/v1", models: [] },
        }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
    fails(
      () =>
        f.store.transaction((tx) =>
          f.component.custodySuitability(tx, {
            credential: "router",
            platform: Platform.OpenAICompatible,
          }),
        ),
      HttpStatus.BadRequest,
      PLATFORM_MISMATCH_CODE,
    );
    f.store.transaction((tx) =>
      f.component.custodySuitability(tx, {
        credential: "router",
        platform: Platform.OpenRouter,
      }),
    );
  } finally {
    f.store.close();
  }
});

test("custody suitability checks the newest live revision and platform", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const suitability: CustodySuitabilityFn = f.component.custodySuitability;
    const created = f.create(inputs[0]) as CredentialAnswer;
    pins.set(created.revisions[0]!.id, ["live-execution"]);
    f.store.transaction((tx) =>
      suitability(tx, { credential: "github", platform: Platform.GitHub }),
    );
    fails(
      () =>
        f.store.transaction((tx) =>
          suitability(tx, { credential: "missing", platform: Platform.GitHub }),
        ),
      HttpStatus.NotFound,
      CREDENTIAL_NOT_FOUND_CODE,
    );
    fails(
      () =>
        f.store.transaction((tx) =>
          suitability(tx, { credential: "github", platform: Platform.S3 }),
        ),
      HttpStatus.BadRequest,
      PLATFORM_MISMATCH_CODE,
    );
    f.rotate("github", { expectedRevision: FIRST_REVISION, secret: apiSecret });
    f.revoke("github", FIRST_REVISION);
    f.store.transaction((tx) =>
      suitability(tx, { credential: "github", platform: Platform.GitHub }),
    );
  } finally {
    f.store.close();
  }
});

test("credential metadata returns only nonsecret fields from the newest live revision", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const metadata: CredentialMetadataFn = f.component.credentialMetadata;
    const created = f.create(inputs[2]) as CredentialAnswer;
    pins.set(created.revisions[0]!.id, ["live-execution"]);
    f.create(inputs[0]);
    const openai = f.store.transaction((tx) => metadata(tx, "openai"));
    assert.deepEqual(openai?.metadata, inputs[2]!.metadata);
    assert.deepEqual(Object.keys(openai!), [
      "id",
      "name",
      "platform",
      "metadata",
    ]);
    assert.equal(openai?.name, inputs[2]!.name);
    assert.equal(openai?.platform, Platform.OpenAICompatible);
    noSecret(openai);
    const github = f.store.transaction((tx) => metadata(tx, "github"));
    assert.equal(github?.metadata, null);
    assert.deepEqual(Object.keys(github!), [
      "id",
      "name",
      "platform",
      "metadata",
    ]);
    assert.equal(
      f.store.transaction((tx) => metadata(tx, "missing")),
      null,
    );
    const rotated = f.rotate("openai", {
      expectedRevision: FIRST_REVISION,
      secret: apiSecret,
      metadata: { baseUrl: ROTATED_BASE_URL, models: [] },
    }) as { revisions: { id: string }[] };
    const newest = f.store.transaction((tx) => metadata(tx, "openai"));
    assert.equal(newest?.id, rotated.revisions[0]!.id);
    assert.deepEqual(newest?.metadata, {
      baseUrl: ROTATED_BASE_URL,
      models: [],
    });
    f.revoke("openai", FIRST_REVISION);
    assert.equal(
      f.store.transaction((tx) => metadata(tx, "openai"))?.id,
      rotated.revisions[0]!.id,
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
    let dependents = [{ agentName: DEPENDENT_AGENT }];
    const f = fixture({
      enablementsDependentOnModel: (tx, credentialName, modelId) => {
        calls.push({ tx, credentialName, modelId });
        return dependents;
      },
    });
    try {
      f.create(inputs[2]);
      const baseUrl = (inputs[2]!.metadata as { baseUrl: string }).baseUrl;
      const existing = {
        baseUrl,
        models: [{ id: REMOVED_MODEL }, { id: KEPT_MODEL }],
      };
      f.updateMetadata("openai", {
        expectedRevision: FIRST_REVISION,
        metadata: existing,
      });
      const next = { baseUrl, models: [{ id: KEPT_MODEL }] };
      const change = () =>
        mode === RemovalMode.Rotation
          ? f.rotate("openai", {
              expectedRevision: NEXT_REVISION,
              secret: apiSecret,
              metadata: next,
            })
          : f.updateMetadata("openai", {
              expectedRevision: NEXT_REVISION,
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

test("credentialDependents returns both injected collaborations' results", () => {
  const agentProviders = [{ agentName: "agent", providerName: "provider" }];
  const bindings = [{ bindingId: "binding", projectId: "project" }];
  const inbounds = [{ inboundId: "inbound" }];
  const calls: { tx: Transaction; name: string }[] = [];
  const f = fixture({
    agentProvidersDependentOn: (tx, name) => {
      calls.push({ tx, name });
      return agentProviders;
    },
    bindingsNaming: (tx, name) => {
      calls.push({ tx, name });
      return bindings;
    },
    inboundsNaming: (tx, name) => {
      calls.push({ tx, name });
      return inbounds;
    },
  });
  try {
    f.store.transaction((tx) => {
      assert.deepEqual(f.component.credentialDependents(tx, "openai"), {
        agentProviders,
        bindings,
        inbounds,
      });
      assert.deepEqual(calls, [
        { tx, name: "openai" },
        { tx, name: "openai" },
        { tx, name: "openai" },
      ]);
    });
  } finally {
    f.store.close();
  }
});

const IN_USE_CODE = "credential.credential.in_use";
const GITHUB_NAME = "github";
const CHECKS_OF_TWO_ARCHIVES = 6;

function archiveCall(f: ReturnType<typeof fixture>, name: string) {
  return () =>
    f.registry.get(custodyOperations.archive.id).handler(
      custodyOperations.archive.input.parse({
        params: { credentialName: name },
        query: {},
        body: null,
      }),
      f.caller,
    );
}

function inUseDetails(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, HttpStatus.Conflict);
    assert.equal(error.code, IN_USE_CODE);
    return error.details;
  }
  return assert.fail("archive must refuse");
}

const NO_DEPENDENTS = { agentProviders: [], bindings: [], inbounds: [] };
const AGENT_DEPENDENT = [{ agentName: "agent", providerName: "provider" }];
const BINDING_DEPENDENT = [{ bindingId: "binding", projectId: "project" }];
const INBOUND_DEPENDENT = [{ inboundId: "inbound" }];

for (const [kind, collaboration, dependents] of [
  [
    "agent provider",
    { agentProvidersDependentOn: () => AGENT_DEPENDENT },
    { ...NO_DEPENDENTS, agentProviders: AGENT_DEPENDENT },
  ],
  [
    "binding",
    { bindingsNaming: () => BINDING_DEPENDENT },
    { ...NO_DEPENDENTS, bindings: BINDING_DEPENDENT },
  ],
  [
    "inbound",
    { inboundsNaming: () => INBOUND_DEPENDENT },
    { ...NO_DEPENDENTS, inbounds: INBOUND_DEPENDENT },
  ],
] as const) {
  test(`archive refuses a ${kind} dependent with its details`, () => {
    const f = fixture(collaboration);
    try {
      f.create(inputs[0]);
      assert.deepEqual(inUseDetails(archiveCall(f, "github")), dependents);
      const read = f.get("github") as CredentialAnswer;
      assert(read.revisions.every((row) => row.endedAt === null));
    } finally {
      f.store.close();
    }
  });
}

test("archive ends every live revision and keeps every row", () => {
  const pins = new Map<string, string[]>();
  const f = fixture({ pins });
  try {
    const created = f.create(inputs[0]) as CredentialAnswer;
    pins.set(created.revisions[0]!.id, ["live-execution"]);
    f.rotate("github", { expectedRevision: FIRST_REVISION, secret: apiSecret });
    const archived = archiveCall(f, "github")() as CredentialAnswer;
    assert.equal(archived.name, GITHUB_NAME);
    assert.equal(archived.revisions.length, NEXT_REVISION);
    assert(archived.revisions.every((row) => row.endedAt !== null));
    const read = f.get("github") as CredentialAnswer;
    assert.equal(read.revisions.length, NEXT_REVISION);
    noSecret(archived);
  } finally {
    f.store.close();
  }
});

test("archive answers not found for an unknown name", () => {
  const f = fixture();
  try {
    fails(
      archiveCall(f, "missing"),
      HttpStatus.NotFound,
      "credential.credential.not_found",
    );
  } finally {
    f.store.close();
  }
});

const ARCHIVED_CODE = "credential.credential.archived";
const REVOKE_ENDED_CODE = "credential.revision.ended";
const EVERY_ARCHIVE_STEP = 3;
const PAGE_OF_ONE = 1;

function archivedFixture() {
  const f = fixture();
  f.create(inputs[0]);
  archiveCall(f, "github")();
  return f;
}

test("an archived name refuses rotate, update-metadata and a second archive", () => {
  const f = archivedFixture();
  try {
    fails(
      () =>
        f.rotate("github", {
          expectedRevision: FIRST_REVISION,
          secret: apiSecret,
        }),
      HttpStatus.Conflict,
      ARCHIVED_CODE,
    );
    fails(
      () =>
        f.updateMetadata("github", {
          expectedRevision: FIRST_REVISION,
          metadata: null,
        }),
      HttpStatus.Conflict,
      ARCHIVED_CODE,
    );
    fails(archiveCall(f, "github"), HttpStatus.Conflict, ARCHIVED_CODE);
    fails(
      () => f.revoke("github", FIRST_REVISION),
      HttpStatus.Conflict,
      REVOKE_ENDED_CODE,
    );
  } finally {
    f.store.close();
  }
});

test("an archived name stays taken", () => {
  const f = archivedFixture();
  try {
    fails(() => f.create(inputs[0]), HttpStatus.Conflict, NAME_CONFLICT_CODE);
  } finally {
    f.store.close();
  }
});

test("get answers an archived name unchanged", () => {
  const f = archivedFixture();
  try {
    const read = f.get("github") as CredentialAnswer;
    assert.equal(read.name, GITHUB_NAME);
    assert(read.revisions.every((row) => row.endedAt !== null));
  } finally {
    f.store.close();
  }
});

test("a rotation never archives a name", () => {
  const f = fixture();
  try {
    f.create(inputs[0]);
    for (let step = 0; step < EVERY_ARCHIVE_STEP; step += 1) {
      const read = f.get("github") as CredentialAnswer;
      const answer = f.rotate("github", {
        expectedRevision: read.revisions[0]!.revision,
        secret: apiSecret,
      }) as CredentialAnswer;
      assert(answer.revisions.some((row) => row.endedAt === null));
      assert.equal(answer.revisions[0]!.endedAt, null);
    }
  } finally {
    f.store.close();
  }
});

test("list leaves out an archived name unless includeArchived is true and pages correctly", () => {
  const f = fixture();
  try {
    for (const input of [inputs[0], inputs[1], inputs[2]]) f.create(input);
    archiveCall(f, "anthropic")();
    const names = (value: unknown) =>
      (value as { items: CredentialAnswer[] }).items.map(({ name }) => name);
    assert.deepEqual(names(f.list()), ["github", "openai"]);
    assert.deepEqual(names(f.list({ includeArchived: "false" })), [
      "github",
      "openai",
    ]);
    assert.deepEqual(names(f.list({ includeArchived: "true" })), [
      "anthropic",
      "github",
      "openai",
    ]);
    const first = f.list({ limit: PAGE_OF_ONE }) as {
      items: CredentialAnswer[];
      nextCursor: string | null;
    };
    assert.deepEqual(names(first), ["github"]);
    const second = f.list({
      limit: PAGE_OF_ONE,
      cursor: first.nextCursor,
    }) as { items: CredentialAnswer[]; nextCursor: string | null };
    assert.deepEqual(names(second), ["openai"]);
    assert.equal(second.nextCursor, null);
  } finally {
    f.store.close();
  }
});

test("archive checks every dependent in the transaction of the write", () => {
  const seen: Transaction[] = [];
  const dependents: { inbounds: { inboundId: string }[] } = { inbounds: [] };
  const f = fixture({
    agentProvidersDependentOn: (tx) => {
      seen.push(tx);
      return [];
    },
    bindingsNaming: (tx) => {
      seen.push(tx);
      return [];
    },
    inboundsNaming: (tx) => {
      seen.push(tx);
      return dependents.inbounds;
    },
  });
  try {
    f.create(inputs[0]);
    dependents.inbounds = INBOUND_DEPENDENT;
    assert.deepEqual(inUseDetails(archiveCall(f, "github")), {
      ...NO_DEPENDENTS,
      inbounds: INBOUND_DEPENDENT,
    });
    dependents.inbounds = [];
    archiveCall(f, "github")();
    assert.equal(seen.length, CHECKS_OF_TWO_ARCHIVES);
    assert.strictEqual(seen[3], f.lastTransaction());
    assert.strictEqual(seen[4], f.lastTransaction());
    assert.strictEqual(seen[5], f.lastTransaction());
    assert.notStrictEqual(seen[0], seen[3]);
  } finally {
    f.store.close();
  }
});

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
  assert.match(answer.sessionId, /^login_session_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(answer.address, LOGIN_ADDRESS);
  assert.equal(answer.code, LOGIN_CODE);
  assert.equal(answer.expiresAt, CLOCK_START + SESSION_EXPIRY_MS);
  assert.equal(domain, EMPTY_DOMAIN);
  assert.equal(selected, DEVICE_OPTION);
  assert.equal(f.loginStatus(answer.sessionId).lastMessage, LAST_MESSAGE);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  fails(
    () => f.loginCode(answer.sessionId, MANUAL_VALUE),
    HttpStatus.Conflict,
    LOGIN_VALUE_NOT_AWAITED,
  );
  await assert.rejects(
    f.login({ ...LOGIN_BODY, name: "second" }),
    rejectsWith(HttpStatus.Conflict, LOGIN_PENDING),
  );
  finish.resolve(oauthCredential);
  const status = await terminalStatus(f, answer.sessionId);
  assert.equal(status.state, LoginSessionState.Completed);
  assert.equal(status.failureReason, null);
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
    { credentialId: row.id, humanIdentity: HUMAN_ACCOUNT_ID },
  ]);
  noOAuthSecret([answer, status, f.logs]);
  fails(
    () => f.loginCode(answer.sessionId, MANUAL_VALUE),
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
  const status = await terminalStatus(f, answer.sessionId);
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
      body: { ...LOGIN_BODY, platform: Platform.GitHub },
      code: UNSUPPORTED_ENTRY_CODE,
    },
    {
      body: { ...LOGIN_BODY, platform: "unknown" },
      code: UNSUPPORTED_PLATFORM_CODE,
    },
    { body: { ...LOGIN_BODY, name: "login" }, code: INVALID_INPUT_CODE },
    { body: { ...LOGIN_BODY, name: "platform" }, code: INVALID_INPUT_CODE },
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
  const status = await terminalStatus(f, answer.sessionId);
  assert.equal(status.state, LoginSessionState.Failed);
  assert.equal(status.failureReason, NAME_CONFLICT_CODE);
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
      f.loginStatus(answer.sessionId).state,
      LoginSessionState.Pending,
    );
    assert.deepEqual(f.loginCode(answer.sessionId, MANUAL_VALUE), {
      sessionId: answer.sessionId,
    });
    assert.equal(await received.promise, MANUAL_VALUE);
    assert.equal(
      (await terminalStatus(f, answer.sessionId)).state,
      LoginSessionState.Completed,
    );
    noOAuthSecret([answer, f.loginStatus(answer.sessionId), f.logs]);
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
  const status = await terminalStatus(f, answer.sessionId);
  assert.equal(status.state, LoginSessionState.Failed);
  assert.equal(status.failureReason, LOGIN_FAILED_MESSAGE);
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
  now = answer.expiresAt;
  fails(
    () => f.loginStatus(answer.sessionId),
    HttpStatus.NotFound,
    LOGIN_NOT_FOUND,
  );
  fails(
    () => f.loginCode(answer.sessionId, MANUAL_VALUE),
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
  now = answer.expiresAt;
  gate.result.resolve(oauthCredential);
  await setImmediate();
  assert.ok((await gate.entered.promise).signal.aborted);
  assert.equal(credentialCount(f), NO_CREDENTIALS);
  assert.deepEqual(f.logs, []);
  fails(
    () => f.loginStatus(answer.sessionId),
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
  const status = await terminalStatus(f, answer.sessionId);
  assert.equal(status.state, LoginSessionState.Failed);
  assert.equal(status.failureReason, LOGIN_FAILED_MESSAGE);
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
  const status = await terminalStatus(f, answer.sessionId);
  assert.equal(status.state, LoginSessionState.Failed);
  assert.equal(status.failureReason, LOGIN_FAILED_MESSAGE);
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
    f.loginStatus(answer.sessionId).state,
    LoginSessionState.Pending,
  );
  f.loginCode(answer.sessionId, MANUAL_VALUE);
  assert.equal(await received.promise, MANUAL_VALUE);
  assert.equal(
    (await terminalStatus(f, answer.sessionId)).state,
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
    const status = await terminalStatus(f, answer.sessionId);
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
    f.loginStatus(answer.sessionId).state,
    LoginSessionState.Pending,
  );
});

test("lifecycle reports health and joins cancellation", async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.health.check()).custody?.credential,
      HealthStatus.Unavailable,
    );
    assert.equal(await f.component.start(), null);
    assert.equal(
      (await f.health.check()).custody?.credential,
      HealthStatus.Healthy,
    );
    assert.equal(await f.component.quiesce(), null);
    assert.equal(await f.component.stop(), null);
    assert.equal(
      (await f.health.check()).custody?.credential,
      HealthStatus.Unavailable,
    );
    assert.ok((await f.component.start()) instanceof Error);
    const other = new CustodyComponent({
      ...unusedExecutionDependencies,
      store: f.store,
      envelopeKey: key,
      logger: { info() {} } as unknown as Logger,
      agentProvidersDependentOn: () => [],
      bindingsNaming: () => [],
      inboundsNaming: () => [],
      enablementsDependentOnModel: () => [],
    });
    const context = new CancellationContext();
    const running = other.run(context);
    context.cancel();
    assert.equal(await running, context.err());
  } finally {
    f.store.close();
  }
});

test("platform list answers the platform table grouped by kind in kind order", (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const answer = f.platformList();
  assert.deepEqual(
    answer.items.map(({ kind }) => kind),
    [PlatformKind.Git, PlatformKind.Storage, PlatformKind.Llm],
  );
  const listed = answer.items.flatMap(({ kind, platforms }) =>
    platforms.map((entry) => ({ kind, ...entry })),
  );
  assert.deepEqual(
    listed.map(({ platform }) => platform).toSorted(),
    Object.keys(PLATFORM_VALIDATORS).toSorted(),
  );
  for (const entry of listed) {
    const validator = PLATFORM_VALIDATORS[entry.platform as Platform];
    assert.equal(entry.kind, validator.kind);
    assert.equal(entry.secretShape, validator.secretShape);
    assert.deepEqual(entry.loginModes, validator.loginModes);
    assert.equal(entry.verifiable, validator.verifiable);
  }
  const byPlatform = new Map(listed.map((entry) => [entry.platform, entry]));
  assert.deepEqual(answer.items[0]!.platforms, [
    {
      platform: Platform.GitHub,
      secretShape: SecretShape.ApiKey,
      loginModes: [],
      metadataFields: [],
      verifiable: true,
    },
  ]);
  assert.deepEqual(answer.items[1]!.platforms, [
    {
      platform: Platform.S3,
      secretShape: SecretShape.S3AccessKey,
      loginModes: [],
      metadataFields: ["endpoint", "bucket", "region"],
      verifiable: true,
    },
  ]);
  assert.deepEqual(byPlatform.get(Platform.OpenAICodex), {
    kind: PlatformKind.Llm,
    platform: Platform.OpenAICodex,
    secretShape: SecretShape.OAuth,
    loginModes: ["browser", "device"],
    metadataFields: [],
    verifiable: true,
  });
  assert.deepEqual(byPlatform.get(Platform.GitHubCopilot)?.loginModes, [
    "device",
  ]);
  assert.deepEqual(byPlatform.get(Platform.OpenAICompatible)?.metadataFields, [
    "baseUrl",
  ]);
  assert.deepEqual(byPlatform.get(Platform.CloudflareAIGateway), {
    kind: PlatformKind.Llm,
    platform: Platform.CloudflareAIGateway,
    secretShape: SecretShape.ApiKey,
    loginModes: [],
    metadataFields: ["account_id", "gateway_id"],
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
        secret: { accessKeyId: "id", secretAccessKey: secretValue },
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
            expectedRevision: FIRST_REVISION,
            metadata: invalid,
          }),
        HttpStatus.BadRequest,
        INVALID_INPUT_CODE,
      );
    const updated = f.updateMetadata("llm", {
      expectedRevision: FIRST_REVISION,
      metadata: edited,
    }) as CredentialAnswer;
    assert.equal(updated.revisions[0]!.revision, NEXT_REVISION);
    assert.deepEqual(updated.revisions[0]!.metadata, edited);
    noSecret(updated);
  });
}
