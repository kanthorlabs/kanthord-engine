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
import { HttpStatus } from "../kernel/http.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { gatewayFixture } from "../gateway/test-support.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import { REPOSITORY_PLATFORMS } from "../repository/index.ts";
import { STORAGE_PLATFORMS } from "../storage/index.ts";
import { environmentSecretOperations, projectOperations } from "./contract.ts";
import { EnvironmentSecretRoutes } from "./environment-secret.ts";
import {
  ENVIRONMENT_SECRET_PLATFORM,
  ENVIRONMENT_SECRET_PLATFORMS,
} from "./environment-secret-platform.ts";

const SECRET = "test_private-registry-secret";
const ROTATED_SECRET = "test_private-registry-rotated";
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const NAME = "registry-auth";
const UNSUPPORTED_PLATFORM_CODE = "credential.platform.unsupported";
const NOT_FOUND_CODE = "credential.credential.not_found";
const CHECK_UNSUPPORTED_CODE = "credential.check.unsupported";
const INVALID_INPUT_CODE = "credential.input.invalid";
const REVISION_ENDED_CODE = "credential.revision.ended";
const NEWEST_LIVE_CODE = "credential.revision.newest_live";
const ARCHIVED_CODE = "credential.credential.archived";
const BODY = {
  name: NAME,
  platform: ENVIRONMENT_SECRET_PLATFORM,
  secret: { key: SECRET },
  metadata: null,
};
const BINDINGS = [
  {
    binding_id: "binding_one",
    project_id: "project_one",
    project_name: "alpha",
    name: "build",
  },
];
const PLATFORM_SET = { platforms: ENVIRONMENT_SECRET_PLATFORMS };

function custodyOf(store: Store) {
  const unexpected = () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  };
  return new CustodyComponent({
    executions: {
      requireRunning: unexpected,
      pinCredential: unexpected,
      liveExecutionsPinning: () => [],
    },
    authorization: { authorizeModelInference: unexpected },
    missionAuthorization: {
      frozenAction: unexpected,
      requestEvidence: unexpected,
      evidenceAsset: unexpected,
      objectPut: unexpected,
    },
    clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
    store,
    platforms: {
      ...REPOSITORY_PLATFORMS,
      ...STORAGE_PLATFORMS,
      ...ENVIRONMENT_SECRET_PLATFORMS,
    },
    envelopeKey: Buffer.alloc(32, 7),
    logger: pino({ enabled: false }),
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    intakeServiceName: INTAKE_SERVICE_NAME,
  });
}

function fixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const custody = custodyOf(store);
  const routes = new EnvironmentSecretRoutes({
    records: custody,
    bindingsNaming: () => BINDINGS,
  });
  const registry = new OperationRegistry();
  routes.declare(registry);
  const caller: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    commit: (write) => store.transaction(write),
  };
  const invoke = (
    operation: (typeof environmentSecretOperations)[keyof typeof environmentSecretOperations],
    input: unknown,
  ) => registry.get(operation.id).handler(operation.input.parse(input), caller);
  return { store, custody, routes, registry, invoke };
}

function params(credentialName: string) {
  return { params: { credential_name: credentialName }, query: {}, body: null };
}

function create(f: ReturnType<typeof fixture>, body: unknown = BODY) {
  return f.invoke(environmentSecretOperations.create, {
    params: {},
    query: {},
    body,
  }) as CredentialAnswer;
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

async function rejects(fn: () => unknown, status: number, code: string) {
  await assert.rejects(
    async () => fn(),
    (error) =>
      error instanceof OperationError &&
      error.status === status &&
      error.code === code,
  );
}

test("platform list answers environment_secret alone with the api_key shape and no probe", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.invoke(environmentSecretOperations.platform_list, {
      params: {},
      query: {},
      body: null,
    }),
    {
      items: [
        {
          platform: ENVIRONMENT_SECRET_PLATFORM,
          secret_shape: SecretShape.ApiKey,
          login_modes: [],
          metadata_fields: [],
          verifiable: false,
        },
      ],
    },
  );
});

test("create answers the record without the secret and refuses metadata", (t) => {
  const f = fixture(t);
  fails(
    () => create(f, { ...BODY, metadata: {} }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
  const answer = create(f);
  assert.equal(answer.name, NAME);
  assert.equal(answer.platform, ENVIRONMENT_SECRET_PLATFORM);
  assert.equal(answer.revisions.length, FIRST_REVISION);
  assert.equal(answer.revisions[0]!.metadata, null);
  assert.ok(!JSON.stringify(answer).includes(SECRET));
});

test("create refuses a platform of another component", (t) => {
  const f = fixture(t);
  for (const platform of ["s3", "github", "anthropic"])
    fails(
      () => create(f, { ...BODY, platform }),
      HttpStatus.BadRequest,
      UNSUPPORTED_PLATFORM_CODE,
    );
});

test("a name of another component answers not found", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) =>
    f.custody.create(
      tx,
      { platforms: STORAGE_PLATFORMS },
      {
        name: "evidence",
        platform: "s3",
        secret: { access_key_id: "test_private-id", secret_access_key: SECRET },
        metadata: {
          endpoint: "https://storage.example",
          bucket: "test-bucket",
          region: "us-east-1",
        },
      },
      undefined,
    ),
  );
  fails(
    () => f.invoke(environmentSecretOperations.get, params("evidence")),
    HttpStatus.NotFound,
    NOT_FOUND_CODE,
  );
  fails(
    () => f.invoke(environmentSecretOperations.archive, params("evidence")),
    HttpStatus.NotFound,
    NOT_FOUND_CODE,
  );
  assert.deepEqual(
    f.invoke(environmentSecretOperations.list, {
      params: {},
      query: {},
      body: null,
    }),
    { items: [], next_cursor: null },
  );
});

test("get lists the bindings, rotate, revoke, list and archive work", async (t) => {
  const f = fixture(t);
  create(f);
  const rotated = f.invoke(environmentSecretOperations.rotate, {
    params: { credential_name: NAME },
    query: {},
    body: {
      expected_revision: FIRST_REVISION,
      secret: { key: ROTATED_SECRET },
    },
  }) as CredentialAnswer;
  assert.equal(rotated.revisions.length, SECOND_REVISION);
  assert.ok(!JSON.stringify(rotated).includes(ROTATED_SECRET));
  for (const [revision, code] of [
    [FIRST_REVISION, REVISION_ENDED_CODE],
    [SECOND_REVISION, NEWEST_LIVE_CODE],
  ] as const)
    fails(
      () =>
        f.invoke(environmentSecretOperations.revoke, {
          params: { credential_name: NAME, revision },
          query: {},
          body: null,
        }),
      HttpStatus.Conflict,
      code,
    );
  const answer = f.invoke(
    environmentSecretOperations.get,
    params(NAME),
  ) as CredentialAnswer & { bindings: unknown };
  assert.equal(answer.revisions.length, SECOND_REVISION);
  assert.deepEqual(answer.bindings, BINDINGS);
  assert.ok(!JSON.stringify(answer).includes(SECRET));
  const listed = f.invoke(environmentSecretOperations.list, {
    params: {},
    query: {},
    body: null,
  }) as { items: CredentialAnswer[] };
  assert.deepEqual(
    listed.items.map(({ name }) => name),
    [NAME],
  );
  const archived = f.invoke(
    environmentSecretOperations.archive,
    params(NAME),
  ) as CredentialAnswer;
  assert.equal(archived.name, NAME);
  await rejects(
    () => f.invoke(environmentSecretOperations.verify, params(NAME)),
    HttpStatus.Conflict,
    ARCHIVED_CODE,
  );
});

test("verify and check answer unsupported for a platform without a probe", async (t) => {
  const f = fixture(t);
  create(f);
  await rejects(
    () => f.invoke(environmentSecretOperations.verify, params(NAME)),
    HttpStatus.BadRequest,
    CHECK_UNSUPPORTED_CODE,
  );
  await rejects(
    () =>
      f.invoke(environmentSecretOperations.check, {
        params: {},
        query: {},
        body: {
          platform: ENVIRONMENT_SECRET_PLATFORM,
          secret: BODY.secret,
          metadata: null,
        },
      }),
    HttpStatus.BadRequest,
    CHECK_UNSUPPORTED_CODE,
  );
});

test("the gateway router answers the credential routes before the project routes", async (t) => {
  const f = fixture(t);
  const registry = new OperationRegistry();
  const reached: string[] = [];
  registry.register(projectOperations.get, ({ params: { project_id } }) => {
    reached.push(project_id);
    throw new Error("UNEXPECTED_PROJECT_GET");
  });
  f.routes.declare(registry);
  const gateway = await gatewayFixture(t, { registry });
  gateway.store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  gateway.store.transaction((tx) =>
    f.custody.create(tx, PLATFORM_SET, BODY, undefined),
  );
  const headers = { Authorization: `Bearer ${gateway.token}` };
  const list = await gateway.request("/api/project/credential", { headers });
  assert.equal(list.status, HttpStatus.OK);
  const listed = (await list.json()) as { items: CredentialAnswer[] };
  assert.deepEqual(
    listed.items.map(({ name }) => name),
    [NAME],
  );
  const get = await gateway.request(`/api/project/credential/${NAME}`, {
    headers,
  });
  assert.equal(get.status, HttpStatus.OK);
  const record = (await get.json()) as CredentialAnswer;
  assert.equal(record.name, NAME);
  assert.deepEqual(reached, []);
});
