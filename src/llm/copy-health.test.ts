import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Logger } from "pino";
import { CustodyComponent, custodyMigrations } from "../custody/index.ts";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
  CUSTODY_SERVICE_NAME,
  SERVER_HOLDER,
  type InstanceKey,
} from "../custody/contract.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { ResourceFailureReason, ResourceStatus } from "../kernel/health.ts";
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
} from "../kernel/hpke.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { testWorkerIdentity } from "../kernel/test-identity.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import { REPOSITORY_PLATFORMS } from "../repository/index.ts";
import { STORAGE_PLATFORMS } from "../storage/index.ts";
import {
  llmOperations,
  NO_CREDENTIAL_VERSION,
  type CopyReportBody,
} from "./contract.ts";
import {
  CAPABILITY_MODEL_LIST_READ,
  LLM_PLATFORMS,
  Platform,
} from "./platforms.ts";
import { LlmComponent } from "./service.ts";

const INSTANCE = "laptop";
const OTHER_INSTANCE = "desktop";
const CREDENTIAL_NAME = "team-openai";
const BAD_KEY = { key: "bad-key" };
const GOOD_KEY = { key: "good-key" };
const CLOCK_START = 1700000000000;
const REPORT_DELAY_MS = 5000;
const FIRST_REVISION = 1;
const NEXT_REVISION = FIRST_REVISION + 1;
const VERSION_STEP = 1;
const AFTER_CREATE = VERSION_STEP;
const AFTER_ROTATE = AFTER_CREATE + VERSION_STEP;
const AFTER_ARCHIVE = AFTER_ROTATE + VERSION_STEP;
const Code = {
  NotFound: "credential.credential.not_found",
  RevisionConflict: "credential.revision.conflict",
  InvalidInput: "credential.input.invalid",
  InstanceForbidden: "llm.credential.instance_forbidden",
} as const;
const envelopeKey = Buffer.alloc(32, 7);

function unexpectedCollaboration(): never {
  throw new Error("UNEXPECTED_COLLABORATION");
}

type Pair = {
  id: string;
  key: InstanceKey;
  private_key: Buffer;
};

async function pairOf(name: string): Promise<Pair> {
  const pair = await generateX25519KeyPair();
  return {
    id: createIdentity("worker_instance"),
    key: {
      name,
      public_key: pair.public_key.toString("base64url"),
      fingerprint: keyFingerprint(pair.public_key),
    },
    private_key: pair.private_key,
  };
}

async function fixture(t: TestContext) {
  const pairs = new Map<string, Pair>();
  for (const name of [INSTANCE, OTHER_INSTANCE])
    pairs.set(name, await pairOf(name));
  const instanceKeys = {
    keyOf: (_tx: unknown, name: string) => pairs.get(name)?.key ?? null,
    nameOf: (_tx: unknown, instanceId: string) =>
      [...pairs.values()].find(({ id }) => id === instanceId)?.key.name ?? null,
  };
  let now = CLOCK_START;
  const store = new Store(IN_MEMORY_DATABASE);
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const logs: unknown[] = [];
  const logger = {
    info: (record: unknown) => logs.push(record),
  } as unknown as Logger;
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
    envelopeKey,
    logger,
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    intakeServiceName: INTAKE_SERVICE_NAME,
    instanceKeys,
  });
  const start = () => {
    const component = new LlmComponent({
      records: custody,
      store,
      logger,
      now: () => now,
      agentProvidersDependentOn: () => [],
      enablementsDependentOnModel: () => [],
      loadModelRuntime: unexpectedCollaboration,
      instanceKeys,
    });
    const registry = new OperationRegistry();
    component.declare(registry);
    t.after(() => component.stop());
    return { component, registry };
  };
  let server = start();
  t.after(() => store.close());
  const human: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    host: "kanthord.example:31415",
    commit: (write) => store.transaction(write),
  };
  const worker = (name: string): CallerContext => ({
    ...human,
    identity: testWorkerIdentity(pairs.get(name)!.id, name, "jti"),
  });
  const invoke = (
    caller: CallerContext,
    operation: (typeof llmOperations)[keyof typeof llmOperations],
    input: unknown,
  ) =>
    server.registry
      .get(operation.id)
      .handler(operation.input.parse(input), caller);
  const create = (holders: string[], secret = BAD_KEY) =>
    invoke(human, llmOperations.create, {
      params: {},
      query: {},
      body: {
        name: CREDENTIAL_NAME,
        platform: Platform.OpenAI,
        metadata: null,
        secret,
        holders,
      },
    });
  const rotate = (holder: string, expected: number, secret = GOOD_KEY) =>
    invoke(human, llmOperations.rotate, {
      params: { credential_name: CREDENTIAL_NAME },
      query: { holder },
      body: { expected_revision: expected, secret },
    });
  const report = (body: Partial<CopyReportBody> = {}, holder = INSTANCE) =>
    invoke(worker(holder), llmOperations.report, {
      params: { credential_name: CREDENTIAL_NAME },
      query: {},
      body: {
        revision: FIRST_REVISION,
        status: ResourceStatus.Unhealthy,
        capability: CAPABILITY_MODEL_LIST_READ,
        failure_reason: ResourceFailureReason.Unauthorized,
        models: null,
        ...body,
      },
    });
  const sealed = (holder = INSTANCE) =>
    invoke(worker(holder), llmOperations.sealed, {
      params: { credential_name: CREDENTIAL_NAME },
      query: {},
      body: null,
    }) as typeof llmOperations.sealed.output._output;
  const health = (holder = INSTANCE) => {
    const copy = store.transaction((tx) =>
      custody.heldCopy(
        tx,
        { platforms: LLM_PLATFORMS, instance_copies: true },
        CREDENTIAL_NAME,
        holder,
      ),
    );
    assert.ok(copy);
    return server.component.copyHealthOf(holder, copy);
  };
  return {
    pairs,
    logs,
    human,
    invoke,
    create,
    rotate,
    report,
    sealed,
    health,
    version: (holder = INSTANCE) =>
      server.component.credentialVersionOf(holder),
    restart: () => {
      server = start();
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function refuses(fn: () => unknown, status: number, code: string): void {
  assert.throws(
    fn,
    (error) =>
      error instanceof OperationError &&
      error.status === status &&
      error.code === code,
  );
}

test("a bad key report shows unhealthy with the time of the report of the instance", async (t) => {
  const f = await fixture(t);
  await f.create([INSTANCE]);
  assert.deepEqual(f.health(), {
    status: ResourceStatus.Unknown,
    capability: CAPABILITY_MODEL_LIST_READ,
    failure_reason: ResourceFailureReason.HeldByInstance,
    models: null,
    reported_at: null,
  });
  f.advance(REPORT_DELAY_MS);
  assert.equal(f.report(), null);
  assert.deepEqual(f.health(), {
    status: ResourceStatus.Unhealthy,
    capability: CAPABILITY_MODEL_LIST_READ,
    failure_reason: ResourceFailureReason.Unauthorized,
    models: null,
    reported_at: f.now(),
  });
  assert.deepEqual(f.logs.at(-1), {
    credential_name: CREDENTIAL_NAME,
    holder: INSTANCE,
    revision: FIRST_REVISION,
    status: ResourceStatus.Unhealthy,
    failure_reason: ResourceFailureReason.Unauthorized,
  });
});

test("a server restart shows unknown and credential version 0 until the next report", async (t) => {
  const f = await fixture(t);
  await f.create([INSTANCE]);
  f.report();
  assert.equal(f.version(), AFTER_CREATE);
  f.restart();
  assert.equal(f.version(), NO_CREDENTIAL_VERSION);
  assert.equal(f.health().status, ResourceStatus.Unknown);
  assert.equal(f.health().reported_at, null);
  f.advance(REPORT_DELAY_MS);
  f.report({
    status: ResourceStatus.Healthy,
    failure_reason: null,
    models: [{ id: "gpt-5", owned_by: "openai", created: null }],
  });
  assert.deepEqual(f.health(), {
    status: ResourceStatus.Healthy,
    capability: CAPABILITY_MODEL_LIST_READ,
    failure_reason: null,
    models: [{ id: "gpt-5", owned_by: "openai", created: null }],
    reported_at: f.now(),
  });
});

test("each write of an instance copy raises the credential version of that instance only", async (t) => {
  const f = await fixture(t);
  await f.create([SERVER_HOLDER, INSTANCE]);
  assert.equal(f.version(), AFTER_CREATE);
  assert.equal(f.version(OTHER_INSTANCE), NO_CREDENTIAL_VERSION);
  assert.equal(f.version(SERVER_HOLDER), NO_CREDENTIAL_VERSION);
  await f.rotate(SERVER_HOLDER, FIRST_REVISION);
  assert.equal(f.version(), AFTER_CREATE);
  f.report();
  await f.rotate(INSTANCE, FIRST_REVISION);
  assert.equal(f.version(), AFTER_ROTATE);
  assert.equal(f.health().status, ResourceStatus.Unknown);
  f.invoke(f.human, llmOperations.archive, {
    params: { credential_name: CREDENTIAL_NAME },
    query: { holder: INSTANCE },
    body: null,
  });
  assert.equal(f.version(), AFTER_ARCHIVE);
});

test("a report refuses another revision, an inconsistent failure reason, another capability and a copy of another instance", async (t) => {
  const f = await fixture(t);
  await f.create([INSTANCE]);
  refuses(
    () => f.report({ revision: NEXT_REVISION }),
    HttpStatus.Conflict,
    Code.RevisionConflict,
  );
  refuses(
    () => f.report({ status: ResourceStatus.Healthy }),
    HttpStatus.BadRequest,
    Code.InvalidInput,
  );
  refuses(
    () => f.report({ failure_reason: null }),
    HttpStatus.BadRequest,
    Code.InvalidInput,
  );
  refuses(
    () => f.report({ capability: "model call" }),
    HttpStatus.BadRequest,
    Code.InvalidInput,
  );
  refuses(
    () => f.report({}, OTHER_INSTANCE),
    HttpStatus.NotFound,
    Code.NotFound,
  );
  refuses(
    () =>
      f.invoke(f.human, llmOperations.report, {
        params: { credential_name: CREDENTIAL_NAME },
        query: {},
        body: {
          revision: FIRST_REVISION,
          status: ResourceStatus.Healthy,
          capability: CAPABILITY_MODEL_LIST_READ,
          failure_reason: null,
          models: null,
        },
      }),
    HttpStatus.Forbidden,
    Code.InstanceForbidden,
  );
  assert.equal(f.health().reported_at, null);
});

test("the sealed read answers the copy of the instance of the token, which only its key opens", async (t) => {
  const f = await fixture(t);
  await f.create([INSTANCE]);
  const answer = f.sealed();
  assert.deepEqual(
    [answer.name, answer.platform, answer.revision, answer.metadata],
    [CREDENTIAL_NAME, Platform.OpenAI, FIRST_REVISION, null],
  );
  const pair = f.pairs.get(INSTANCE)!;
  assert.deepEqual(
    await openJSON(
      pair.private_key,
      CREDENTIAL_SEAL_INFO,
      credentialSealAad({
        name: CREDENTIAL_NAME,
        platform: Platform.OpenAI,
        holder: INSTANCE,
        sealed_to: pair.key.fingerprint,
      }),
      answer.sealed,
    ),
    BAD_KEY,
  );
  refuses(() => f.sealed(OTHER_INSTANCE), HttpStatus.NotFound, Code.NotFound);
  f.pairs.set(INSTANCE, { ...(await pairOf(INSTANCE)), id: pair.id });
  refuses(() => f.sealed(), HttpStatus.NotFound, Code.NotFound);
  refuses(() => f.report(), HttpStatus.NotFound, Code.NotFound);
});
