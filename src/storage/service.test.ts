import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
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
import { HttpStatus } from "../kernel/http.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
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
  secret: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET },
  metadata: METADATA,
};
const BINDINGS = [
  {
    bindingId: "binding_one",
    projectId: "project_one",
    projectName: "alpha",
    name: "evidence",
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
  const custody = new CustodyComponent({
    executions: {
      requireRunning: unexpected,
      pinCredential: unexpected,
      liveExecutionsPinning: () => [],
    },
    authorization: { authorizeModelInference: unexpected },
    clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
    store,
    platforms: { ...REPOSITORY_PLATFORMS, ...STORAGE_PLATFORMS },
    envelopeKey: Buffer.alloc(32, 7),
    logger: pino({ enabled: false }),
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
          secretShape: SecretShape.S3AccessKey,
          loginModes: [],
          metadataFields: ["endpoint", "bucket", "region"],
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
    params: { credentialName: S3_BODY.name },
    query: {},
    body: null,
  }) as CredentialAnswer & { bindings: unknown };
  assert.equal(answer.revisions.length, FIRST_REVISION);
  assert.deepEqual(answer.revisions[0]!.metadata, METADATA);
  assert.deepEqual(answer.bindings, BINDINGS);
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
        params: { credentialName: "github" },
        query: {},
        body: null,
      }),
    HttpStatus.NotFound,
    NOT_FOUND_CODE,
  );
  fails(
    () =>
      f.invoke(storageOperations.update_metadata, {
        params: { credentialName: "github" },
        query: {},
        body: { expectedRevision: FIRST_REVISION, metadata: null },
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
