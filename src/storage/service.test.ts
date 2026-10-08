import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
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
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { REPOSITORY_PLATFORMS } from "../repository/index.ts";
import { storageOperations } from "./contract.ts";
import { CAPABILITY_BUCKET_HEAD, STORAGE_PLATFORMS } from "./platforms.ts";
import { StorageComponent } from "./service.ts";

const SECRET = "test_private-s3-secret";
const ACCESS_KEY_ID = "test_private-s3-access-id";
const FIRST_REVISION = 1;
const ONE_CALL = 1;
const UNSUPPORTED_PLATFORM_CODE = "credential.platform.unsupported";
const NOT_FOUND_CODE = "credential.credential.not_found";
const METADATA = {
  endpoint: "https://storage.example",
  bucket: "test-bucket",
  region: "us-east-1",
};
const S3_BODY = {
  name: "evidence",
  platform: "s3",
  secret: { access_key_id: ACCESS_KEY_ID, secret_access_key: SECRET },
  metadata: METADATA,
};
const BINDINGS = [
  {
    binding_id: "binding_one",
    project_id: "project_one",
    project_name: "alpha",
    name: "evidence",
  },
];
const BINDINGS_ANSWER = [
  {
    binding_id: "binding_one",
    project_id: "project_one",
    project_name: "alpha",
    name: "evidence",
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
  const custody = new CustodyComponent({
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
    platforms: { ...REPOSITORY_PLATFORMS, ...STORAGE_PLATFORMS },
    envelopeKey: Buffer.alloc(32, 7),
    logger,
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
  });
  const component = new StorageComponent({
    records: custody,
    bindingsNaming: () => BINDINGS,
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
    operation: (typeof storageOperations)[keyof typeof storageOperations],
    input: unknown,
  ) => registry.get(operation.id).handler(operation.input.parse(input), caller);
  return { store, custody, component, invoke };
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

test("platform list answers s3 alone", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.invoke(storageOperations.platform_list, {
      params: {},
      query: {},
      body: null,
    }),
    {
      items: [
        {
          platform: "s3",
          secret_shape: SecretShape.S3AccessKey,
          login_modes: [],
          metadata_fields: ["endpoint", "bucket", "region"],
          verifiable: true,
        },
      ],
    },
  );
});

test("create refuses a platform of another component and get lists the bindings that name the credential", (t) => {
  const f = fixture(t);
  for (const platform of ["github", "anthropic"])
    fails(
      () =>
        f.invoke(storageOperations.create, {
          params: {},
          query: {},
          body: { ...S3_BODY, platform },
        }),
      HttpStatus.BadRequest,
      UNSUPPORTED_PLATFORM_CODE,
    );
  f.invoke(storageOperations.create, { params: {}, query: {}, body: S3_BODY });
  const answer = f.invoke(storageOperations.get, {
    params: { credential_name: S3_BODY.name },
    query: {},
    body: null,
  }) as CredentialAnswer & { bindings: unknown };
  assert.equal(answer.revisions.length, FIRST_REVISION);
  assert.deepEqual(answer.revisions[0]!.metadata, METADATA);
  assert.deepEqual(answer.bindings, BINDINGS_ANSWER);
  assert.ok(!JSON.stringify(answer).includes(SECRET));
});

test("a name of another component answers not found and the inventory heads the bucket of each s3 record", async (t) => {
  const f = fixture(t);
  f.store.transaction((tx) =>
    f.custody.create(
      tx,
      { platforms: REPOSITORY_PLATFORMS },
      {
        name: "github",
        platform: "github",
        secret: { key: SECRET },
        metadata: null,
      },
      undefined,
    ),
  );
  fails(
    () =>
      f.invoke(storageOperations.get, {
        params: { credential_name: "github" },
        query: {},
        body: null,
      }),
    HttpStatus.NotFound,
    NOT_FOUND_CODE,
  );
  fails(
    () =>
      f.invoke(storageOperations.update_metadata, {
        params: { credential_name: "github" },
        query: {},
        body: { expected_revision: FIRST_REVISION, metadata: null },
      }),
    HttpStatus.NotFound,
    NOT_FOUND_CODE,
  );
  const created = f.invoke(storageOperations.create, {
    params: {},
    query: {},
    body: S3_BODY,
  }) as CredentialAnswer;
  const send = t.mock.method(
    S3Client.prototype,
    "send",
    async (command: HeadBucketCommand) => {
      assert.deepEqual(command.input, { Bucket: METADATA.bucket });
      return { $metadata: { httpStatusCode: HttpStatus.OK } };
    },
  );
  t.mock.method(S3Client.prototype, "destroy", () => {});
  const entries = f.store.transaction((tx) =>
    f.component.resourceInventory(tx),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      scope: HealthScope.Global,
      project: null,
      name: S3_BODY.name,
      target: `credential:${created.revisions[0]!.id}`,
      capability: CAPABILITY_BUCKET_HEAD,
    },
  ]);
  assert.equal(await entries[0]!.check(background), ResourceStatus.Healthy);
  assert.equal(send.mock.callCount(), ONE_CALL);
  assert.ok(!JSON.stringify(entries).includes(SECRET));
});

const INVALID_INPUT_CODE = "credential.input.invalid";
const NO_ROWS = 0;
const CHECK_PATH = "/api/storage/credential/check";
const CHECK_BODY = {
  platform: S3_BODY.platform,
  secret: S3_BODY.secret,
  metadata: S3_BODY.metadata,
};

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

test("check answers healthy, unhealthy and unknown for s3 without a row, a log or an answer that holds the secret", async (t) => {
  const lines: string[] = [];
  const f = fixture(
    t,
    pino({ level: "info" }, { write: (line: string) => lines.push(line) }),
  );
  const statuses = [
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.NotFound, ResourceStatus.Unhealthy],
    [HttpStatus.InternalServerError, ResourceStatus.Unknown],
  ] as const;
  let next = 0;
  const send = t.mock.method(
    S3Client.prototype,
    "send",
    async (command: HeadBucketCommand) => {
      assert.deepEqual(command.input, { Bucket: METADATA.bucket });
      return { $metadata: { httpStatusCode: statuses[next++]![0] } };
    },
  );
  t.mock.method(S3Client.prototype, "destroy", () => {});
  for (const [, expected] of statuses) {
    const answer = await f.invoke(storageOperations.check, {
      params: {},
      query: {},
      body: CHECK_BODY,
    });
    assert.deepEqual(answer, {
      status: expected,
      capability: CAPABILITY_BUCKET_HEAD,
    });
    assert.ok(!JSON.stringify(answer).includes(SECRET));
  }
  assert.equal(send.mock.callCount(), statuses.length);
  assert.equal(rowCount(f), NO_ROWS);
  assert.ok(lines.length > NO_ROWS);
  assert.ok(!lines.join("").includes(SECRET));
});

test("check answers unknown when the request throws", async (t) => {
  const f = fixture(t);
  t.mock.method(S3Client.prototype, "send", async () => {
    throw new Error(`failed with ${SECRET}`);
  });
  t.mock.method(S3Client.prototype, "destroy", () => {});
  assert.deepEqual(
    await f.invoke(storageOperations.check, {
      params: {},
      query: {},
      body: CHECK_BODY,
    }),
    { status: ResourceStatus.Unknown, capability: CAPABILITY_BUCKET_HEAD },
  );
});

test("check refuses a platform of another component, invalid input and a body with a name", async (t) => {
  const f = fixture(t);
  const send = t.mock.method(S3Client.prototype, "send", async () => {
    throw new Error("UNEXPECTED_REQUEST");
  });
  for (const platform of ["github", "anthropic"])
    await rejects(
      () =>
        f.invoke(storageOperations.check, {
          params: {},
          query: {},
          body: { ...CHECK_BODY, platform },
        }),
      HttpStatus.BadRequest,
      UNSUPPORTED_PLATFORM_CODE,
    );
  for (const body of [
    { ...CHECK_BODY, secret: { access_key_id: ACCESS_KEY_ID } },
    { ...CHECK_BODY, secret: { key: SECRET } },
    { ...CHECK_BODY, metadata: null },
    { ...CHECK_BODY, metadata: { ...METADATA, endpoint: "not a url" } },
  ])
    await rejects(
      () => f.invoke(storageOperations.check, { params: {}, query: {}, body }),
      HttpStatus.BadRequest,
      INVALID_INPUT_CODE,
    );
  assert.throws(() =>
    storageOperations.check.input.parse({
      params: {},
      query: {},
      body: { ...CHECK_BODY, name: "evidence" },
    }),
  );
  assert.equal(send.mock.callCount(), NO_ROWS);
  assert.equal(rowCount(f), NO_ROWS);
});

test("check takes no mutation key and the credential name check is refused", (t) => {
  const f = fixture(t);
  assert.equal(storageOperations.check.mutation, false);
  assert.equal(storageOperations.check.method, HttpMethod.Post);
  assert.equal(storageOperations.check.path, CHECK_PATH);
  fails(
    () =>
      f.invoke(storageOperations.create, {
        params: {},
        query: {},
        body: { ...S3_BODY, name: "check" },
      }),
    HttpStatus.BadRequest,
    INVALID_INPUT_CODE,
  );
});

const VERIFY_PATH = "/api/storage/credential/:credential_name/verify";
const ARCHIVED_CODE = "credential.credential.archived";

function verifyInput(credentialName: string) {
  return { params: { credential_name: credentialName }, query: {}, body: null };
}

function credentialRows(f: ReturnType<typeof fixture>): string {
  return JSON.stringify(
    f.store.database.prepare("SELECT * FROM credential ORDER BY id").all(),
  );
}

test("verify answers healthy, unhealthy and unknown like the health report without a write, a log or an answer that holds the secret", async (t) => {
  const lines: string[] = [];
  const f = fixture(
    t,
    pino({ level: "info" }, { write: (line: string) => lines.push(line) }),
  );
  f.invoke(storageOperations.create, {
    params: {},
    query: {},
    body: S3_BODY,
  });
  const statuses = [
    [HttpStatus.OK, ResourceStatus.Healthy],
    [HttpStatus.NotFound, ResourceStatus.Unhealthy],
    [HttpStatus.InternalServerError, ResourceStatus.Unknown],
  ] as const;
  let next = 0;
  const send = t.mock.method(
    S3Client.prototype,
    "send",
    async (command: HeadBucketCommand) => {
      assert.deepEqual(command.input, { Bucket: METADATA.bucket });
      return {
        $metadata: { httpStatusCode: statuses[Math.floor(next++ / 2)]![0] },
      };
    },
  );
  t.mock.method(S3Client.prototype, "destroy", () => {});
  const before = credentialRows(f);
  for (const [, expected] of statuses) {
    const answer = await f.invoke(
      storageOperations.verify,
      verifyInput(S3_BODY.name),
    );
    const [entry] = f.store.transaction((tx) =>
      f.component.resourceInventory(tx),
    );
    assert.deepEqual(answer, {
      status: expected,
      capability: CAPABILITY_BUCKET_HEAD,
    });
    assert.equal(await entry!.check(background), expected);
    assert.ok(!JSON.stringify(answer).includes(SECRET));
  }
  assert.equal(send.mock.callCount(), statuses.length * 2);
  assert.equal(credentialRows(f), before);
  assert.ok(lines.length > NO_ROWS);
  assert.ok(!lines.join("").includes(SECRET));
});

test("verify answers unknown when the request throws and logs no secret", async (t) => {
  const lines: string[] = [];
  const f = fixture(
    t,
    pino({ level: "info" }, { write: (line: string) => lines.push(line) }),
  );
  f.invoke(storageOperations.create, {
    params: {},
    query: {},
    body: S3_BODY,
  });
  t.mock.method(S3Client.prototype, "send", async () => {
    throw new Error(`failed with ${SECRET}`);
  });
  t.mock.method(S3Client.prototype, "destroy", () => {});
  assert.deepEqual(
    await f.invoke(storageOperations.verify, verifyInput(S3_BODY.name)),
    { status: ResourceStatus.Unknown, capability: CAPABILITY_BUCKET_HEAD },
  );
  assert.ok(!lines.join("").includes(SECRET));
});

test("verify refuses an archived record, an unknown name and a name of another component", async (t) => {
  const f = fixture(t);
  const send = t.mock.method(S3Client.prototype, "send", async () => {
    throw new Error("UNEXPECTED_REQUEST");
  });
  f.invoke(storageOperations.create, {
    params: {},
    query: {},
    body: S3_BODY,
  });
  f.store.transaction((tx) =>
    f.custody.create(
      tx,
      { platforms: REPOSITORY_PLATFORMS },
      {
        name: "github",
        platform: "github",
        secret: { key: SECRET },
        metadata: null,
      },
      undefined,
    ),
  );
  f.store.transaction((tx) =>
    f.custody.archive(tx, { platforms: REPOSITORY_PLATFORMS }, "github"),
  );
  for (const name of ["github", "missing"])
    await rejects(
      () => f.invoke(storageOperations.verify, verifyInput(name)),
      HttpStatus.NotFound,
      NOT_FOUND_CODE,
    );
  f.invoke(storageOperations.archive, verifyInput(S3_BODY.name));
  await rejects(
    () => f.invoke(storageOperations.verify, verifyInput(S3_BODY.name)),
    HttpStatus.Conflict,
    ARCHIVED_CODE,
  );
  assert.equal(send.mock.callCount(), NO_ROWS);
});

test("verify takes no body and no mutation key", () => {
  assert.equal(storageOperations.verify.mutation, false);
  assert.equal(storageOperations.verify.method, HttpMethod.Post);
  assert.equal(storageOperations.verify.path, VERIFY_PATH);
  assert.equal(storageOperations.verify.access, AccessPolicy.Human);
  assert.throws(() =>
    storageOperations.verify.input.parse({
      params: { credential_name: S3_BODY.name },
      query: {},
      body: {},
    }),
  );
});
