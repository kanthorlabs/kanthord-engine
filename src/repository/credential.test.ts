import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
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
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
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

function fixture(t: TestContext) {
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
    logger: pino({ enabled: false }),
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
