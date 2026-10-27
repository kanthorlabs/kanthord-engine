import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino, { type Logger } from "pino";
import { CustodyComponent, custodyMigrations } from "../custody/index.ts";
import {
  CUSTODY_SERVICE_NAME,
  SecretShape,
  type CredentialAnswer,
} from "../custody/contract.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  HealthScope,
  ResourceFailureReason,
  ResourceStatus,
} from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationRegistry,
  type CallerContext,
} from "../kernel/operation.ts";
import { AUTHORIZATION_HEADER } from "../kernel/probe.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { LLM_PLATFORMS } from "../llm/index.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryOperations } from "./contract.ts";
import {
  CAPABILITY_RATE_LIMIT_READ,
  CAPABILITY_SSH_IDENTITY,
  GITHUB_RATE_LIMIT_URL,
  Platform,
  probeGitHub,
  REPOSITORY_PLATFORMS,
} from "./credential-platform.ts";
import { RepositoryCredentials } from "./credential.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import { PROJECT_SERVICE_NAME } from "../project/contract.ts";
import { decrypt, encrypt } from "../custody/envelope.ts";
import { createIdentity } from "../kernel/identity.ts";
import { temporary } from "../kernel/test-support.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { generateSshKey, sshFingerprintOf, sshPublicKeyOf } from "./ssh-key.ts";

const SECRET = "test_private-github-token";
const FIRST_REVISION = 1;
const ONE_CALL = 1;
const UNSUPPORTED_PLATFORM_CODE = "credential.platform.unsupported";
const NOT_FOUND_CODE = "credential.credential.not_found";
const BINDINGS = [
  {
    binding_id: "binding_one",
    project_id: "project_one",
    project_name: "alpha",
    name: "repo",
  },
];
const BINDINGS_ANSWER = [
  {
    binding_id: "binding_one",
    project_id: "project_one",
    project_name: "alpha",
    name: "repo",
  },
];

function fixture(
  t: TestContext,
  logger: Logger = pino({ enabled: false }),
  database = IN_MEMORY_DATABASE,
) {
  const store = new Store(database);
  t.after(() => store.close());
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const unexpected = () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  };
  const namings: string[] = [];
  const custody = new CustodyComponent({
    executions: {
      requireRunning: unexpected,
      pinCredential: unexpected,
      liveExecutionsPinning: () => [],
    },
    authorization: { authorizeModelInference: unexpected },
    missionAuthorization: {
      frozenAction: unexpected,
      serviceMerge: unexpected,
      requestEvidence: unexpected,
      evidenceAsset: unexpected,
      objectPut: unexpected,
    },
    clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
    store,
    platforms: { ...LLM_PLATFORMS, ...REPOSITORY_PLATFORMS },
    envelopeKey: Buffer.alloc(32, 7),
    logger,
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    intakeServiceName: INTAKE_SERVICE_NAME,
    projectServiceName: PROJECT_SERVICE_NAME,
  });
  const component = new RepositoryCredentials({
    store,
    records: custody,
    bindingsNaming: (tx, name) => {
      assert.ok(tx.database.isTransaction);
      namings.push(name);
      return BINDINGS;
    },
  });
  const registry = new OperationRegistry();
  component.declare(registry);
  const caller: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    commit: (write) => store.transaction(write),
  };
  const invoke = (
    operation: (typeof repositoryOperations)[keyof typeof repositoryOperations],
    input: unknown,
  ) => registry.get(operation.id).handler(operation.input.parse(input), caller);
  return { store, custody, component, invoke, namings };
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

test("the GitHub probe reads the rate limit with the stored token", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (
      url: Parameters<typeof globalThis.fetch>[0],
      options?: RequestInit,
    ) => {
      assert.equal(url, GITHUB_RATE_LIMIT_URL);
      assert.equal(options?.method, HttpMethod.Get);
      assert.deepEqual(options?.headers, {
        [AUTHORIZATION_HEADER]: `Bearer ${SECRET}`,
      });
      return new Response(null, { status: HttpStatus.OK });
    },
  );
  assert.equal(await probeGitHub(SECRET, background), ResourceStatus.Healthy);
  assert.equal(fetch.mock.callCount(), ONE_CALL);
});

test("platform list answers github and ssh", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.invoke(repositoryOperations.platform_list, {
      params: {},
      query: {},
      body: null,
    }),
    {
      items: [
        {
          platform: "github",
          secret_shape: SecretShape.ApiKey,
          login_modes: [],
          metadata_fields: [],
          verifiable: true,
        },
        {
          platform: "ssh",
          secret_shape: SecretShape.SshKey,
          login_modes: [],
          metadata_fields: ["public_key", "fingerprint"],
          verifiable: true,
        },
      ],
    },
  );
});

test("create refuses a platform of another component and get lists the bindings that name the credential", (t) => {
  const f = fixture(t);
  for (const platform of ["anthropic", "s3"])
    fails(
      () =>
        f.invoke(repositoryOperations.create, {
          params: {},
          query: {},
          body: {
            name: "other",
            platform,
            secret: { key: SECRET },
            metadata: null,
          },
        }),
      HttpStatus.BadRequest,
      UNSUPPORTED_PLATFORM_CODE,
    );
  f.invoke(repositoryOperations.create, {
    params: {},
    query: {},
    body: {
      name: "github",
      platform: "github",
      secret: { key: SECRET },
      metadata: null,
    },
  });
  const answer = f.invoke(repositoryOperations.get, {
    params: { credential_name: "github" },
    query: {},
    body: null,
  }) as CredentialAnswer & { bindings: unknown };
  assert.equal(answer.revisions.length, FIRST_REVISION);
  assert.deepEqual(answer.bindings, BINDINGS_ANSWER);
  assert.deepEqual(f.namings, ["github"]);
  assert.ok(!JSON.stringify(answer).includes(SECRET));
});

test("a name of another component answers not found and the inventory holds only github records", async (t) => {
  const f = fixture(t);
  f.store.transaction((tx) =>
    f.custody.create(
      tx,
      { platforms: LLM_PLATFORMS },
      {
        name: "anthropic",
        platform: "anthropic",
        secret: { key: SECRET },
        metadata: null,
      },
      undefined,
    ),
  );
  for (const [operation, params] of [
    [repositoryOperations.get, { credential_name: "anthropic" }],
    [repositoryOperations.archive, { credential_name: "anthropic" }],
    [
      repositoryOperations.revoke,
      { credential_name: "anthropic", revision: FIRST_REVISION },
    ],
  ] as const)
    fails(
      () => f.invoke(operation, { params, query: {}, body: null }),
      HttpStatus.NotFound,
      NOT_FOUND_CODE,
    );
  const created = f.invoke(repositoryOperations.create, {
    params: {},
    query: {},
    body: {
      name: "github",
      platform: "github",
      secret: { key: SECRET },
      metadata: null,
    },
  }) as CredentialAnswer;
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: HttpStatus.OK }),
  );
  const entries = f.store.transaction((tx) =>
    f.component.resourceInventory(tx),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      scope: HealthScope.Global,
      project: null,
      name: "github",
      target: `credential:${created.revisions[0]!.id}`,
      capability: CAPABILITY_RATE_LIMIT_READ,
    },
  ]);
  assert.equal(await entries[0]!.check(background), ResourceStatus.Healthy);
  assert.equal(fetch.mock.callCount(), ONE_CALL);
});

const OTHER_PLATFORM_CODE = "credential.platform.unsupported";
const INVALID_INPUT_CODE = "credential.input.invalid";
const NO_ROWS = 0;
const CHECK_PATH = "/api/repository/credential/check";

function rowCount(f: ReturnType<typeof fixture>): number {
  return (
    f.store.database.prepare("SELECT COUNT(*) AS n FROM credential").get() as {
      n: number;
    }
  ).n;
}

async function rejects(fn: () => unknown, status: number, code: string) {
  await assert.rejects(
    async () => fn(),
    (error) =>
      error instanceof OperationError &&
      error.status === status &&
      error.code === code,
  );
}

test("check answers healthy, unhealthy and unknown for github without a row, a log or an answer that holds the token", async (t) => {
  const lines: string[] = [];
  const f = fixture(
    t,
    pino({ level: "info" }, { write: (line: string) => lines.push(line) }),
  );
  const statuses = [
    [HttpStatus.OK, ResourceStatus.Healthy, null],
    [
      HttpStatus.Unauthorized,
      ResourceStatus.Unhealthy,
      ResourceFailureReason.Unauthorized,
    ],
    [
      HttpStatus.Forbidden,
      ResourceStatus.Unknown,
      ResourceFailureReason.Forbidden,
    ],
  ] as const;
  const requests: unknown[] = [];
  let next = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, options?: RequestInit) => {
      requests.push({ url, headers: options?.headers });
      return new Response(null, { status: statuses[next++]![0] });
    },
  );
  for (const [, expected, failureReason] of statuses) {
    const answer = await f.invoke(repositoryOperations.check, {
      params: {},
      query: {},
      body: { platform: "github", secret: { key: SECRET }, metadata: null },
    });
    assert.deepEqual(answer, {
      status: expected,
      capability: CAPABILITY_RATE_LIMIT_READ,
      failure_reason: failureReason,
    });
  }
  assert.equal(requests.length, statuses.length);
  assert.deepEqual(requests[0], {
    url: GITHUB_RATE_LIMIT_URL,
    headers: { [AUTHORIZATION_HEADER]: `Bearer ${SECRET}` },
  });
  assert.equal(rowCount(f), NO_ROWS);
  assert.ok(lines.length > NO_ROWS);
  assert.ok(!lines.join("").includes(SECRET));
});

test("check answers unknown when the request fails", async (t) => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(`failed with ${SECRET}`);
  });
  assert.deepEqual(
    await f.invoke(repositoryOperations.check, {
      params: {},
      query: {},
      body: { platform: "github", secret: { key: SECRET }, metadata: null },
    }),
    {
      status: ResourceStatus.Unknown,
      capability: CAPABILITY_RATE_LIMIT_READ,
      failure_reason: ResourceFailureReason.Unreachable,
    },
  );
});

test("check refuses a platform of another component, invalid input and a body with a name", async (t) => {
  const f = fixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("UNEXPECTED_REQUEST");
  });
  for (const platform of ["anthropic", "s3"])
    await rejects(
      () =>
        f.invoke(repositoryOperations.check, {
          params: {},
          query: {},
          body: { platform, secret: { key: SECRET }, metadata: null },
        }),
      HttpStatus.BadRequest,
      OTHER_PLATFORM_CODE,
    );
  for (const body of [
    { platform: "github", secret: { key: "" }, metadata: null },
    { platform: "github", secret: { key: SECRET, extra: 1 }, metadata: null },
    { platform: "github", secret: { key: SECRET }, metadata: {} },
  ])
    await rejects(
      () =>
        f.invoke(repositoryOperations.check, { params: {}, query: {}, body }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
  for (const body of [
    {
      name: "github",
      platform: "github",
      secret: { key: SECRET },
      metadata: null,
    },
    { platform: "github", metadata: null },
  ])
    assert.throws(() =>
      repositoryOperations.check.input.parse({ params: {}, query: {}, body }),
    );
  assert.equal(fetch.mock.callCount(), NO_ROWS);
  assert.equal(rowCount(f), NO_ROWS);
});

test("check takes no mutation key and the credential name check is refused", (t) => {
  const f = fixture(t);
  assert.equal(repositoryOperations.check.mutation, false);
  assert.equal(repositoryOperations.check.method, HttpMethod.Post);
  assert.equal(repositoryOperations.check.path, CHECK_PATH);
  fails(
    () =>
      f.invoke(repositoryOperations.create, {
        params: {},
        query: {},
        body: {
          name: "check",
          platform: "github",
          secret: { key: SECRET },
          metadata: null,
        },
      }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
});

const VERIFY_PATH = "/api/repository/credential/:credential_name/verify";
const ARCHIVED_CODE = "credential.credential.archived";
const REPOSITORY_NAME = "repo";

function verifyInput(credentialName: string) {
  return { params: { credential_name: credentialName }, query: {}, body: null };
}

function credentialRows(f: ReturnType<typeof fixture>): string {
  return JSON.stringify(
    f.store.database.prepare("SELECT * FROM credential ORDER BY id").all(),
  );
}

function createGithub(f: ReturnType<typeof fixture>) {
  f.invoke(repositoryOperations.create, {
    params: {},
    query: {},
    body: {
      name: REPOSITORY_NAME,
      platform: "github",
      secret: { key: SECRET },
      metadata: null,
    },
  });
}

test("verify answers healthy, unhealthy and unknown like the health report without a write, a log or an answer that holds the token", async (t) => {
  const lines: string[] = [];
  const f = fixture(
    t,
    pino({ level: "info" }, { write: (line: string) => lines.push(line) }),
  );
  createGithub(f);
  const statuses = [
    [HttpStatus.OK, ResourceStatus.Healthy, null],
    [
      HttpStatus.Unauthorized,
      ResourceStatus.Unhealthy,
      ResourceFailureReason.Unauthorized,
    ],
    [
      HttpStatus.Forbidden,
      ResourceStatus.Unknown,
      ResourceFailureReason.Forbidden,
    ],
  ] as const;
  const requests: unknown[] = [];
  let next = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, options?: RequestInit) => {
      requests.push({ url, headers: options?.headers });
      return new Response(null, {
        status: statuses[Math.floor(next++ / 2)]![0],
      });
    },
  );
  const before = credentialRows(f);
  for (const [, expected, failureReason] of statuses) {
    const answer = await f.invoke(
      repositoryOperations.verify,
      verifyInput(REPOSITORY_NAME),
    );
    const [entry] = f.store.transaction((tx) =>
      f.component.resourceInventory(tx),
    );
    assert.deepEqual(answer, {
      status: expected,
      capability: CAPABILITY_RATE_LIMIT_READ,
      failure_reason: failureReason,
    });
    assert.equal(await entry!.check(background), expected);
    assert.ok(!JSON.stringify(answer).includes(SECRET));
  }
  assert.equal(requests.length, statuses.length * 2);
  assert.deepEqual(requests[0], {
    url: GITHUB_RATE_LIMIT_URL,
    headers: { [AUTHORIZATION_HEADER]: `Bearer ${SECRET}` },
  });
  assert.equal(credentialRows(f), before);
  assert.ok(lines.length > NO_ROWS);
  assert.ok(!lines.join("").includes(SECRET));
});

test("verify answers unknown when the request fails and logs no token", async (t) => {
  const lines: string[] = [];
  const f = fixture(
    t,
    pino({ level: "info" }, { write: (line: string) => lines.push(line) }),
  );
  createGithub(f);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(`failed with Bearer ${SECRET}`);
  });
  assert.deepEqual(
    await f.invoke(repositoryOperations.verify, verifyInput(REPOSITORY_NAME)),
    {
      status: ResourceStatus.Unknown,
      capability: CAPABILITY_RATE_LIMIT_READ,
      failure_reason: ResourceFailureReason.Unreachable,
    },
  );
  assert.ok(!lines.join("").includes(SECRET));
});

test("verify refuses an archived record, an unknown name and a name of another component", async (t) => {
  const f = fixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("UNEXPECTED_REQUEST");
  });
  f.store.transaction((tx) =>
    f.custody.create(
      tx,
      { platforms: LLM_PLATFORMS },
      {
        name: "anthropic",
        platform: "anthropic",
        secret: { key: SECRET },
        metadata: null,
      },
      undefined,
    ),
  );
  for (const name of ["anthropic", "missing"])
    await rejects(
      () => f.invoke(repositoryOperations.verify, verifyInput(name)),
      HttpStatus.NotFound,
      NOT_FOUND_CODE,
    );
  createGithub(f);
  f.invoke(repositoryOperations.archive, verifyInput(REPOSITORY_NAME));
  await rejects(
    () => f.invoke(repositoryOperations.verify, verifyInput(REPOSITORY_NAME)),
    HttpStatus.Conflict,
    ARCHIVED_CODE,
  );
  assert.equal(fetch.mock.callCount(), NO_ROWS);
});

test("verify takes no body and no mutation key", () => {
  assert.equal(repositoryOperations.verify.mutation, false);
  assert.equal(repositoryOperations.verify.method, HttpMethod.Post);
  assert.equal(repositoryOperations.verify.path, VERIFY_PATH);
  assert.equal(repositoryOperations.verify.access, AccessPolicy.Human);
  assert.throws(() =>
    repositoryOperations.verify.input.parse({
      params: { credential_name: REPOSITORY_NAME },
      query: {},
      body: {},
    }),
  );
});

async function rejectsWith(
  promise: unknown,
  status: number,
  code: string,
  details?: unknown,
) {
  await assert.rejects(Promise.resolve(promise), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  });
}

const SSH_NAME = "deploy";
const OPENSSH_LABEL = "OPENSSH PRIVATE KEY";
const UNSUPPORTED_ENTRY_CODE = "credential.entry.unsupported";
const CHECK_UNSUPPORTED_CODE = "credential.check.unsupported";
const NAME_CONFLICT_CODE = "credential.name.conflict";
const REVISION_CONFLICT_CODE = "credential.revision.conflict";
const SSH_PUBLIC_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]+=* kanthord-deploy$/;
const ARMOR_LINES = 2;
const NEXT_REVISION = FIRST_REVISION + 1;
const NO_LINES = 0;
const ONE_FILE = 1;
const SSH_KEY_CREATE_PATH = "/api/repository/credential/ssh/key";
const SSH_KEY_ROTATE_PATH =
  "/api/repository/credential/:credential_name/ssh/key";

function sshKeyCreate(name = SSH_NAME) {
  return { params: {}, query: {}, body: { name } };
}

function sshKeyRotate(expected_revision: number, name = SSH_NAME) {
  return {
    params: { credential_name: name },
    query: {},
    body: { expected_revision },
  };
}

function storedPrivateKey(store: Store, name = SSH_NAME): string {
  const row = store.database
    .prepare(
      "SELECT id, platform, nonce, ciphertext FROM credential WHERE name = ? AND ended_at IS NULL ORDER BY revision DESC LIMIT 1",
    )
    .get(name) as {
    id: string;
    platform: string;
    nonce: Buffer;
    ciphertext: Buffer;
  };
  const secret = decrypt(
    Buffer.alloc(32, 7),
    row.id,
    row.platform,
    row.nonce,
    row.ciphertext,
  ) as { private_key: string };
  return secret.private_key;
}

function keyBodyLines(privateKey: string): string[] {
  return privateKey.trim().split("\n").slice(1, -1);
}

const LEGACY_SSH_METADATA = {
  host: "kanthorlabs.github.com",
  hostname: "ssh.github.com",
  port: 443,
  identity_file: "~/.ssh/id_kanthorlabs",
};

function insertLegacy(store: Store, name = SSH_NAME): void {
  const id = createIdentity("credential");
  const { nonce, ciphertext } = encrypt(Buffer.alloc(32, 7), id, "ssh", {});
  store.database
    .prepare(
      "INSERT INTO credential (id, name, platform, holder, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, 'ssh', 'server', 1, ?, ?, ?, ?, NULL)",
    )
    .run(
      id,
      name,
      nonce,
      ciphertext,
      canonicalJSON(LEGACY_SSH_METADATA),
      Date.now(),
    );
}

function capturedLogger(lines: string[]): Logger {
  return pino({ level: "info" }, { write: (line: string) => lines.push(line) });
}

test("ssh_key_create answers the record with the derived public key and fingerprint and no private key", async (t) => {
  const lines: string[] = [];
  const f = fixture(t, capturedLogger(lines));
  const created = (await f.invoke(
    repositoryOperations.ssh_key_create,
    sshKeyCreate(),
  )) as CredentialAnswer;
  assert.equal(created.name, SSH_NAME);
  assert.equal(created.platform, Platform.Ssh);
  assert.equal(created.revisions.length, FIRST_REVISION);
  const metadata = created.revisions[0]!.metadata as {
    public_key: string;
    fingerprint: string;
  };
  assert.deepEqual(Object.keys(metadata).sort(), ["fingerprint", "public_key"]);
  assert.match(metadata.public_key, SSH_PUBLIC_KEY_PATTERN);
  assert.equal(metadata.fingerprint, sshFingerprintOf(metadata.public_key));
  const privateKey = storedPrivateKey(f.store);
  assert.equal(sshPublicKeyOf(privateKey), metadata.public_key);
  const answer = JSON.stringify(created);
  const logged = lines.join("");
  assert.ok(lines.length > NO_LINES);
  for (const text of [answer, logged]) {
    assert.ok(!text.includes(OPENSSH_LABEL));
    for (const line of keyBodyLines(privateKey))
      assert.ok(!text.includes(line));
  }
});

test("ssh_key_create refuses a taken name and the reserved name ssh, and is a mutation", async (t) => {
  const f = fixture(t);
  await f.invoke(repositoryOperations.ssh_key_create, sshKeyCreate());
  fails(
    () => f.invoke(repositoryOperations.ssh_key_create, sshKeyCreate()),
    HttpStatus.Conflict,
    NAME_CONFLICT_CODE,
  );
  fails(
    () => f.invoke(repositoryOperations.ssh_key_create, sshKeyCreate("ssh")),
    HttpStatus.BadRequest,
    "credential.input.invalid",
  );
  assert.equal(repositoryOperations.ssh_key_create.mutation, true);
  assert.equal(repositoryOperations.ssh_key_rotate.mutation, true);
  assert.equal(repositoryOperations.ssh_key_create.path, SSH_KEY_CREATE_PATH);
  assert.equal(repositoryOperations.ssh_key_rotate.path, SSH_KEY_ROTATE_PATH);
});

test("ssh_key_rotate refuses a stale revision, inserts a new key and drains the older revision", async (t) => {
  const f = fixture(t);
  const created = (await f.invoke(
    repositoryOperations.ssh_key_create,
    sshKeyCreate(),
  )) as CredentialAnswer;
  const first = storedPrivateKey(f.store);
  fails(
    () =>
      f.invoke(
        repositoryOperations.ssh_key_rotate,
        sshKeyRotate(NEXT_REVISION),
      ),
    HttpStatus.Conflict,
    REVISION_CONFLICT_CODE,
  );
  const rotated = (await f.invoke(
    repositoryOperations.ssh_key_rotate,
    sshKeyRotate(FIRST_REVISION),
  )) as CredentialAnswer;
  assert.equal(rotated.revisions[0]!.revision, NEXT_REVISION);
  assert.notDeepEqual(
    rotated.revisions[0]!.metadata,
    created.revisions[0]!.metadata,
  );
  assert.notEqual(rotated.revisions[1]!.ended_at, null);
  assert.notEqual(storedPrivateKey(f.store), first);
  assert.equal(
    sshPublicKeyOf(storedPrivateKey(f.store)),
    (rotated.revisions[0]!.metadata as { public_key: string }).public_key,
  );
});

test("a legacy ssh record verifies identity_unavailable and rotates to a generated key", async (t) => {
  const f = fixture(t);
  insertLegacy(f.store);
  const verify = () =>
    f.invoke(repositoryOperations.verify, {
      params: { credential_name: SSH_NAME },
      query: {},
      body: null,
    });
  assert.deepEqual(await verify(), {
    status: ResourceStatus.Unhealthy,
    capability: CAPABILITY_SSH_IDENTITY,
    failure_reason: ResourceFailureReason.IdentityUnavailable,
  });
  const rotated = (await f.invoke(
    repositoryOperations.ssh_key_rotate,
    sshKeyRotate(FIRST_REVISION),
  )) as CredentialAnswer;
  assert.match(
    (rotated.revisions[0]!.metadata as { public_key: string }).public_key,
    SSH_PUBLIC_KEY_PATTERN,
  );
  assert.notEqual(rotated.revisions[1]!.ended_at, null);
  assert.deepEqual(await verify(), {
    status: ResourceStatus.Healthy,
    capability: CAPABILITY_SSH_IDENTITY,
    failure_reason: null,
  });
});

test("the ssh probe answers identity_unavailable for a public key that differs from the stored one", async () => {
  const key = generateSshKey(SSH_NAME);
  const other = generateSshKey("other");
  const observed: Array<[string, string]> = [];
  const probe = REPOSITORY_PLATFORMS[Platform.Ssh].probe!;
  assert.equal(
    await probe(
      { private_key: key.private_key },
      { public_key: key.public_key, fingerprint: key.fingerprint },
      background,
    ),
    ResourceStatus.Healthy,
  );
  assert.equal(
    await probe(
      { private_key: key.private_key },
      { public_key: other.public_key, fingerprint: other.fingerprint },
      background,
      (reason, failureReason) => void observed.push([reason, failureReason]),
    ),
    ResourceStatus.Unhealthy,
  );
  assert.equal(observed.length, ONE_CALL);
  assert.equal(observed[0]![1], ResourceFailureReason.IdentityUnavailable);
  for (const line of keyBodyLines(key.private_key))
    assert.ok(!observed[0]![0].includes(line));
});

test("the generic create, rotate, metadata edit and check refuse the platform ssh", async (t) => {
  const f = fixture(t);
  const key = generateSshKey(SSH_NAME);
  const secret = { private_key: key.private_key };
  const metadata = { public_key: key.public_key, fingerprint: key.fingerprint };
  fails(
    () =>
      f.invoke(repositoryOperations.create, {
        params: {},
        query: {},
        body: { name: SSH_NAME, platform: "ssh", metadata, secret },
      }),
    HttpStatus.BadRequest,
    UNSUPPORTED_ENTRY_CODE,
  );
  await f.invoke(repositoryOperations.ssh_key_create, sshKeyCreate());
  fails(
    () =>
      f.invoke(repositoryOperations.rotate, {
        params: { credential_name: SSH_NAME },
        query: {},
        body: { expected_revision: FIRST_REVISION, secret },
      }),
    HttpStatus.BadRequest,
    UNSUPPORTED_ENTRY_CODE,
  );
  fails(
    () =>
      f.invoke(repositoryOperations.update_metadata, {
        params: { credential_name: SSH_NAME },
        query: {},
        body: { expected_revision: FIRST_REVISION, metadata },
      }),
    HttpStatus.BadRequest,
    UNSUPPORTED_ENTRY_CODE,
  );
  await rejectsWith(
    f.invoke(repositoryOperations.check, {
      params: {},
      query: {},
      body: { platform: "ssh", metadata, secret },
    }),
    HttpStatus.BadRequest,
    CHECK_UNSUPPORTED_CODE,
  );
});

test("the raw database file holds no text of a generated SSH key", async (t) => {
  const directory = temporary(t);
  const path = join(directory, "kanthord.db");
  const f = fixture(t, undefined, path);
  await f.invoke(repositoryOperations.ssh_key_create, sshKeyCreate());
  const first = storedPrivateKey(f.store);
  await f.invoke(
    repositoryOperations.ssh_key_rotate,
    sshKeyRotate(FIRST_REVISION),
  );
  const second = storedPrivateKey(f.store);
  const files = readdirSync(directory).map((name) =>
    readFileSync(join(directory, name)).toString("latin1"),
  );
  assert.ok(files.length >= ONE_FILE);
  for (const privateKey of [first, second]) {
    const body = keyBodyLines(privateKey);
    assert.ok(body.length >= ARMOR_LINES);
    for (const raw of files) {
      assert.ok(!raw.includes(OPENSSH_LABEL));
      for (const line of body) assert.ok(!raw.includes(line));
    }
  }
});
