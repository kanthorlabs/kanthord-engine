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
import { HealthScope, ResourceStatus } from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationRegistry,
  type CallerContext,
} from "../kernel/operation.ts";
import { AUTHORIZATION_HEADER } from "../kernel/probe.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { LLM_PLATFORMS } from "../llm/index.ts";
import { repositoryOperations } from "./contract.ts";
import {
  CAPABILITY_RATE_LIMIT_READ,
  GITHUB_RATE_LIMIT_URL,
  probeGitHub,
  REPOSITORY_PLATFORMS,
} from "./credential-platform.ts";
import { RepositoryCredentials } from "./credential.ts";

const SECRET = "test_private-github-token";
const FIRST_REVISION = 1;
const ONE_CALL = 1;
const UNSUPPORTED_PLATFORM_CODE = "credential.platform.unsupported";
const NOT_FOUND_CODE = "credential.credential.not_found";
const BINDINGS = [
  {
    bindingId: "binding_one",
    projectId: "project_one",
    projectName: "alpha",
    name: "repo",
  },
];

function fixture(t: TestContext, logger: Logger = pino({ enabled: false })) {
  const store = new Store(IN_MEMORY_DATABASE);
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
    clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
    store,
    platforms: { ...LLM_PLATFORMS, ...REPOSITORY_PLATFORMS },
    envelopeKey: Buffer.alloc(32, 7),
    logger,
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
  });
  const component = new RepositoryCredentials({
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

test("platform list answers github alone", (t) => {
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
          secretShape: SecretShape.ApiKey,
          loginModes: [],
          metadataFields: [],
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
    params: { credentialName: "github" },
    query: {},
    body: null,
  }) as CredentialAnswer & { bindings: unknown };
  assert.equal(answer.revisions.length, FIRST_REVISION);
  assert.deepEqual(answer.bindings, BINDINGS);
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
    [repositoryOperations.get, { credentialName: "anthropic" }],
    [repositoryOperations.archive, { credentialName: "anthropic" }],
    [
      repositoryOperations.revoke,
      { credentialName: "anthropic", revision: FIRST_REVISION },
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
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.Unauthorized, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unknown],
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
  for (const [, expected] of statuses) {
    const answer = await f.invoke(repositoryOperations.check, {
      params: {},
      query: {},
      body: { platform: "github", secret: { key: SECRET }, metadata: null },
    });
    assert.deepEqual(answer, {
      status: expected,
      capability: CAPABILITY_RATE_LIMIT_READ,
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
    { status: ResourceStatus.Unknown, capability: CAPABILITY_RATE_LIMIT_READ },
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

const VERIFY_PATH = "/api/repository/credential/:credentialName/verify";
const ARCHIVED_CODE = "credential.credential.archived";
const REPOSITORY_NAME = "repo";

function verifyInput(credentialName: string) {
  return { params: { credentialName }, query: {}, body: null };
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
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.Unauthorized, ResourceStatus.Unhealthy],
    [HttpStatus.Forbidden, ResourceStatus.Unknown],
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
  for (const [, expected] of statuses) {
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
    { status: ResourceStatus.Unknown, capability: CAPABILITY_RATE_LIMIT_READ },
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
      params: { credentialName: REPOSITORY_NAME },
      query: {},
      body: {},
    }),
  );
});
