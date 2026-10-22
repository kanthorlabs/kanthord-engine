import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Logger } from "pino";
import { CustodyComponent, custodyMigrations } from "../custody/index.ts";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
  CUSTODY_SERVICE_NAME,
  type InstanceKey,
} from "../custody/contract.ts";
import { decrypt } from "../custody/envelope.ts";
import { background } from "../kernel/context.ts";
import {
  generateX25519KeyPair,
  keyFingerprint,
  openJSON,
  sealedObjectSchema,
  sealJSON,
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
  InstanceLoginState,
  llmOperations,
  type LoginReportBody,
} from "./contract.ts";
import { LLM_PLATFORMS, Platform } from "./platforms.ts";
import {
  LoginSessionMode,
  LoginSessionState,
  SESSION_EXPIRY_MS,
} from "./sessions.ts";
import { LlmComponent } from "./service.ts";

const INSTANCE = "laptop";
const OTHER_INSTANCE = "desktop";
const CREDENTIAL_NAME = "claude";
const CLOCK_START = 1700000000000;
const AUTHORIZATION_URL = "https://claude.ai/oauth/authorize?state=abc";
const DEVICE_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE = "ABCD-EFGH";
const DEVICE_MESSAGE = "Waiting for authorization";
const COPY_CODE_VALUE = "authorization-code#state-value";
const FIRST_REVISION = 1;
const NO_CREDENTIALS = 0;
const ONE_ROW = 1;
const KEPT_METADATA = { note: "kept" };
const VERSION_STEP = 1;
const OAUTH_SECRET = {
  refresh: "private-refresh-token",
  access: "private-access-token",
  expires: CLOCK_START + SESSION_EXPIRY_MS,
};
const Code = {
  InstanceUnavailable: "credential.login.instance_unavailable",
  InstanceUnknown: "llm.credential.instance_unknown",
  LoginPending: "credential.login.pending",
  BrowserUnavailable: "credential.login.browser_unavailable",
  NotFound: "credential.login.not_found",
  ValueNotAwaited: "credential.login.value_not_awaited",
  SealedInvalid: "credential.sealed.invalid",
  InvalidInput: "credential.input.invalid",
  NameConflict: "credential.name.conflict",
  Archived: "credential.credential.archived",
} as const;
const envelopeKey = Buffer.alloc(32, 7);

function unexpectedCollaboration(): never {
  throw new Error("UNEXPECTED_COLLABORATION");
}

async function fixture(t: TestContext) {
  const pairs = new Map<
    string,
    { id: string; key: InstanceKey; private_key: Buffer; public_key: Buffer }
  >();
  for (const name of [INSTANCE, OTHER_INSTANCE]) {
    const pair = await generateX25519KeyPair();
    pairs.set(name, {
      id: createIdentity("worker_instance"),
      key: {
        name,
        public_key: pair.public_key.toString("base64url"),
        fingerprint: keyFingerprint(pair.public_key),
      },
      private_key: pair.private_key,
      public_key: pair.public_key,
    });
  }
  const instanceKeys = {
    keyOf: (_tx: unknown, name: string) => pairs.get(name)?.key ?? null,
    nameOf: (_tx: unknown, instanceId: string) =>
      [...pairs.values()].find(({ id }) => id === instanceId)?.key.name ?? null,
  };
  const connected = new Set([INSTANCE, OTHER_INSTANCE]);
  const pinned = new Set<string>();
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
      liveExecutionsPinning: (_tx: unknown, id: string) =>
        pinned.has(id) ? ["execution"] : [],
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
  const component = new LlmComponent({
    records: custody,
    store,
    logger,
    now: () => now,
    agentProvidersDependentOn: () => [],
    enablementsDependentOnModel: () => [],
    loadModelRuntime: unexpectedCollaboration,
    instanceKeys,
    instanceConnected: (holder) => connected.has(holder),
  });
  t.after(async () => {
    await component.stop();
    store.close();
  });
  const registry = new OperationRegistry();
  component.declare(registry);
  const human: CallerContext = {
    identity: { kind: "human", accountId: "alice", name: "Alice", jti: "j" },
    context: background,
    requestId: "request",
    host: "kanthord.example:31415",
    commit: (write) => store.transaction(write),
  };
  const invoke = (
    caller: CallerContext,
    operation: (typeof llmOperations)[keyof typeof llmOperations],
    input: unknown,
  ) => registry.get(operation.id).handler(operation.input.parse(input), caller);
  const worker = (name: string): CallerContext => ({
    ...human,
    identity: testWorkerIdentity(pairs.get(name)!.id, name, "jti"),
  });
  const login = (body: Record<string, unknown>) =>
    invoke(human, llmOperations.login, {
      params: {},
      query: {},
      body: { name: CREDENTIAL_NAME, holder: INSTANCE, ...body },
    }) as Promise<typeof llmOperations.login.output._output>;
  const loginCode = (sessionId: string, value: string) =>
    invoke(human, llmOperations.login_code, {
      params: { session_id: sessionId },
      query: {},
      body: { value },
    });
  const loginStatus = (sessionId: string) =>
    invoke(human, llmOperations.login_status, {
      params: { session_id: sessionId },
      query: {},
      body: null,
    }) as typeof llmOperations.login_status.output._output;
  const report = (
    sessionId: string,
    body: Partial<LoginReportBody>,
    name = INSTANCE,
  ) =>
    invoke(worker(name), llmOperations.login_report, {
      params: { session_id: sessionId },
      query: {},
      body: {
        state: InstanceLoginState.Pending,
        address: null,
        code: null,
        message: null,
        failure_reason: null,
        ...body,
      },
    });
  const listed = async (holder = INSTANCE) => {
    for (;;) {
      const [entry] = component.loginSessionsOf(holder);
      if (entry) return entry;
      await setImmediate(undefined, { signal: t.signal });
    }
  };
  const sealFor = async (platform: string, holder = INSTANCE) => {
    const pair = pairs.get(holder)!;
    return {
      sealed: await sealJSON(
        pair.public_key,
        CREDENTIAL_SEAL_INFO,
        credentialSealAad({
          name: CREDENTIAL_NAME,
          platform,
          holder,
          sealed_to: pair.key.fingerprint,
        }),
        OAUTH_SECRET,
      ),
      sealed_to: pair.key.fingerprint,
    };
  };
  const rows = () =>
    store.database
      .prepare(
        "SELECT id, platform, holder, sealed_to, revision, nonce, ciphertext, ended_at FROM credential ORDER BY revision",
      )
      .all() as {
      id: string;
      platform: string;
      holder: string;
      sealed_to: string | null;
      revision: number;
      nonce: Buffer;
      ciphertext: Buffer;
      ended_at: number | null;
    }[];
  const rotateKey = async (name: string) => {
    const pair = await generateX25519KeyPair();
    const current = pairs.get(name)!;
    pairs.set(name, {
      id: current.id,
      key: {
        name,
        public_key: pair.public_key.toString("base64url"),
        fingerprint: keyFingerprint(pair.public_key),
      },
      private_key: pair.private_key,
      public_key: pair.public_key,
    });
  };
  const signIn = async () => {
    const started = login({ platform: Platform.AnthropicSubscription });
    const entry = await listed();
    report(entry.session_id, { address: AUTHORIZATION_URL });
    await started;
    report(entry.session_id, {
      state: InstanceLoginState.Completed,
      address: AUTHORIZATION_URL,
      ...(await sealFor(Platform.AnthropicSubscription)),
    });
    return entry.session_id;
  };
  const copyOf = () =>
    invoke(human, llmOperations.get, {
      params: { credential_name: CREDENTIAL_NAME },
      query: { holder: INSTANCE },
      body: null,
    }) as typeof llmOperations.get.output._output;
  return {
    component,
    store,
    pairs,
    connected,
    logs,
    human,
    invoke,
    login,
    loginCode,
    loginStatus,
    report,
    listed,
    sealFor,
    rows,
    pinned,
    rotateKey,
    signIn,
    copyOf,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("an instance login in copy_code mode runs on the instance, takes the code through the heartbeat entry and stores only the sealed revision 1", async (t) => {
  const f = await fixture(t);
  const started = f.login({ platform: Platform.AnthropicSubscription });
  const entry = await f.listed();
  assert.deepEqual(
    { ...entry, session_id: undefined },
    {
      session_id: undefined,
      name: CREDENTIAL_NAME,
      platform: Platform.AnthropicSubscription,
      mode: LoginSessionMode.CopyCode,
      code: null,
    },
  );
  assert.deepEqual(f.component.loginSessionsOf(OTHER_INSTANCE), []);
  assert.throws(() => f.loginCode(entry.session_id, COPY_CODE_VALUE), {
    code: Code.ValueNotAwaited,
  });
  f.report(entry.session_id, { address: AUTHORIZATION_URL });
  const answer = await started;
  assert.equal(answer.session_id, entry.session_id);
  assert.equal(answer.address, AUTHORIZATION_URL);
  assert.equal(answer.code, null);
  f.loginCode(entry.session_id, COPY_CODE_VALUE);
  assert.equal((await f.listed()).code, COPY_CODE_VALUE);
  assert.throws(() => f.loginCode(entry.session_id, COPY_CODE_VALUE), {
    code: Code.ValueNotAwaited,
  });
  assert.throws(
    () =>
      f.report(
        entry.session_id,
        { address: AUTHORIZATION_URL },
        OTHER_INSTANCE,
      ),
    { code: Code.NotFound, status: HttpStatus.NotFound },
  );
  assert.throws(
    () =>
      f.report(entry.session_id, {
        state: InstanceLoginState.Completed,
        address: AUTHORIZATION_URL,
      }),
    { code: Code.InvalidInput },
  );
  assert.equal(f.rows().length, NO_CREDENTIALS);
  assert.equal(f.component.credentialVersionOf(INSTANCE), CLOCK_START);
  const sealed = await f.sealFor(Platform.AnthropicSubscription);
  f.report(entry.session_id, {
    state: InstanceLoginState.Completed,
    address: AUTHORIZATION_URL,
    ...sealed,
  });
  assert.equal(
    f.loginStatus(entry.session_id).state,
    LoginSessionState.Completed,
  );
  assert.deepEqual(f.component.loginSessionsOf(INSTANCE), []);
  assert.equal(
    f.component.credentialVersionOf(INSTANCE),
    CLOCK_START + VERSION_STEP,
  );
  const [row] = f.rows();
  assert.ok(row);
  assert.deepEqual(
    [row.platform, row.holder, row.sealed_to, row.revision],
    [
      Platform.AnthropicSubscription,
      INSTANCE,
      f.pairs.get(INSTANCE)!.key.fingerprint,
      FIRST_REVISION,
    ],
  );
  const stored = sealedObjectSchema.parse(
    decrypt(envelopeKey, row.id, row.platform, row.nonce, row.ciphertext),
  );
  assert.deepEqual(
    await openJSON(
      f.pairs.get(INSTANCE)!.private_key,
      CREDENTIAL_SEAL_INFO,
      credentialSealAad({
        name: CREDENTIAL_NAME,
        platform: Platform.AnthropicSubscription,
        holder: INSTANCE,
        sealed_to: f.pairs.get(INSTANCE)!.key.fingerprint,
      }),
      stored,
    ),
    OAUTH_SECRET,
  );
  const copy = f.invoke(f.human, llmOperations.get, {
    params: { credential_name: CREDENTIAL_NAME },
    query: { holder: INSTANCE },
    body: null,
  }) as typeof llmOperations.get.output._output;
  assert.deepEqual([copy.holder, copy.sealed_current], [INSTANCE, true]);
  assert.throws(
    () =>
      f.report(entry.session_id, {
        state: InstanceLoginState.Completed,
        address: AUTHORIZATION_URL,
        ...sealed,
      }),
    { code: Code.NotFound },
  );
  const text = JSON.stringify([answer, f.logs]);
  assert.equal(text.includes(OAUTH_SECRET.access), false);
  assert.equal(text.includes(OAUTH_SECRET.refresh), false);
});

test("an instance login of a device platform selects device mode, refuses browser mode and answers the device code", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.login({
      platform: Platform.OpenAICodex,
      mode: LoginSessionMode.Browser,
    }),
    { code: Code.BrowserUnavailable, status: HttpStatus.BadRequest },
  );
  const started = f.login({ platform: Platform.OpenAICodex });
  const entry = await f.listed();
  assert.equal(entry.mode, LoginSessionMode.Device);
  f.report(entry.session_id, {
    address: DEVICE_URL,
    code: DEVICE_CODE,
    message: DEVICE_MESSAGE,
  });
  const answer = await started;
  assert.deepEqual([answer.address, answer.code], [DEVICE_URL, DEVICE_CODE]);
  assert.equal(f.loginStatus(entry.session_id).last_message, DEVICE_MESSAGE);
  assert.throws(() => f.loginCode(entry.session_id, COPY_CODE_VALUE), {
    code: Code.ValueNotAwaited,
  });
  f.report(entry.session_id, {
    state: InstanceLoginState.Completed,
    address: DEVICE_URL,
    code: DEVICE_CODE,
    ...(await f.sealFor(Platform.OpenAICodex)),
  });
  assert.equal(f.rows()[0]?.holder, INSTANCE);
});

test("an instance login refuses an unknown holder and an instance with no current connection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.login({ platform: Platform.AnthropicSubscription, holder: "absent" }),
    { code: Code.InstanceUnknown, status: HttpStatus.BadRequest },
  );
  f.connected.delete(INSTANCE);
  await assert.rejects(f.login({ platform: Platform.AnthropicSubscription }), {
    code: Code.InstanceUnavailable,
    status: HttpStatus.Conflict,
  });
  assert.deepEqual(f.component.loginSessionsOf(INSTANCE), []);
});

test("an expired instance session stores nothing and leaves the heartbeat entry", async (t) => {
  const f = await fixture(t);
  const started = f.login({ platform: Platform.AnthropicSubscription });
  const entry = await f.listed();
  f.report(entry.session_id, { address: AUTHORIZATION_URL });
  await started;
  f.loginCode(entry.session_id, COPY_CODE_VALUE);
  const sealed = await f.sealFor(Platform.AnthropicSubscription);
  f.advance(SESSION_EXPIRY_MS);
  assert.deepEqual(f.component.loginSessionsOf(INSTANCE), []);
  assert.throws(
    () =>
      f.report(entry.session_id, {
        state: InstanceLoginState.Completed,
        address: AUTHORIZATION_URL,
        ...sealed,
      }),
    { code: Code.NotFound },
  );
  assert.equal(
    f.loginStatus(entry.session_id).state,
    LoginSessionState.Expired,
  );
  assert.equal(f.rows().length, NO_CREDENTIALS);
});

test("a completed report sealed to another key fails the session and stores nothing", async (t) => {
  const f = await fixture(t);
  const started = f.login({ platform: Platform.AnthropicSubscription });
  const entry = await f.listed();
  f.report(entry.session_id, { address: AUTHORIZATION_URL });
  await started;
  const other = await f.sealFor(Platform.AnthropicSubscription, OTHER_INSTANCE);
  assert.throws(
    () =>
      f.report(entry.session_id, {
        state: InstanceLoginState.Completed,
        address: AUTHORIZATION_URL,
        ...other,
      }),
    { code: Code.SealedInvalid },
  );
  assert.equal(f.loginStatus(entry.session_id).state, LoginSessionState.Failed);
  assert.equal(f.rows().length, NO_CREDENTIALS);
});

test("an instance failure report fails the pending login before an address", async (t) => {
  const f = await fixture(t);
  const started = f.login({ platform: Platform.AnthropicSubscription });
  const entry = await f.listed();
  f.report(entry.session_id, {
    state: InstanceLoginState.Failed,
    failure_reason: "login failed",
  });
  await assert.rejects(started, {
    code: "credential.login.failed",
    status: HttpStatus.ServiceUnavailable,
  });
  assert.equal(f.loginStatus(entry.session_id).state, LoginSessionState.Failed);
  assert.equal(f.rows().length, NO_CREDENTIALS);
});

test("an instance report keeps the first address and refuses an address that is no https URL", async (t) => {
  const f = await fixture(t);
  const started = f.login({ platform: Platform.AnthropicSubscription });
  const entry = await f.listed();
  assert.throws(() =>
    f.report(entry.session_id, { address: "http://claude.ai/oauth/authorize" }),
  );
  f.report(entry.session_id, { address: AUTHORIZATION_URL });
  await started;
  assert.throws(() => f.report(entry.session_id, { address: DEVICE_URL }), {
    code: Code.InvalidInput,
  });
  f.report(entry.session_id, {
    address: AUTHORIZATION_URL,
    message: DEVICE_MESSAGE,
  });
  assert.equal(f.loginStatus(entry.session_id).last_message, DEVICE_MESSAGE);
});

test("one human holds one pending session for a platform over the server and every instance", async (t) => {
  const f = await fixture(t);
  const started = f.login({ platform: Platform.AnthropicSubscription });
  const entry = await f.listed();
  f.report(entry.session_id, { address: AUTHORIZATION_URL });
  await started;
  await assert.rejects(
    f.login({
      platform: Platform.AnthropicSubscription,
      holder: OTHER_INSTANCE,
      name: "other",
    }),
    { code: Code.LoginPending, status: HttpStatus.Conflict },
  );
  await assert.rejects(
    f.login({
      platform: Platform.AnthropicSubscription,
      holder: "server",
      name: "other",
    }),
    { code: Code.LoginPending, status: HttpStatus.Conflict },
  );
});

test("a sign-in after a key rotation adds revision 2 sealed to the current key with the metadata of revision 1 and ends revision 1", async (t) => {
  const f = await fixture(t);
  await f.signIn();
  f.store.database
    .prepare("UPDATE credential SET metadata = ?")
    .run(JSON.stringify(KEPT_METADATA));
  await f.rotateKey(INSTANCE);
  assert.equal(f.copyOf().sealed_current, false);
  const session = await f.signIn();
  assert.equal(f.loginStatus(session).state, LoginSessionState.Completed);
  const [first, second] = f.rows();
  assert.deepEqual(
    [first?.revision, first?.ended_at === null],
    [FIRST_REVISION, false],
  );
  assert.deepEqual(
    [second?.revision, second?.ended_at, second?.sealed_to],
    [FIRST_REVISION + 1, null, f.pairs.get(INSTANCE)!.key.fingerprint],
  );
  const copy = f.copyOf();
  assert.equal(copy.sealed_current, true);
  assert.equal(copy.revisions[0]?.revision, FIRST_REVISION + 1);
  assert.deepEqual(copy.revisions[0]?.metadata, KEPT_METADATA);
});

test("a sign-in after a revoked revision adds the next revision past it", async (t) => {
  const f = await fixture(t);
  await f.signIn();
  f.pinned.add(f.rows()[0]!.id);
  await f.rotateKey(INSTANCE);
  await f.signIn();
  await f.rotateKey(INSTANCE);
  f.invoke(f.human, llmOperations.revoke, {
    params: { credential_name: CREDENTIAL_NAME, revision: FIRST_REVISION },
    query: { holder: INSTANCE },
    body: null,
  });
  await f.signIn();
  assert.deepEqual(
    f.rows().map(({ revision, ended_at }) => [revision, ended_at === null]),
    [
      [FIRST_REVISION, false],
      [FIRST_REVISION + 1, false],
      [FIRST_REVISION + 2, true],
    ],
  );
  assert.equal(f.copyOf().sealed_current, true);
});

test("a sign-in on a live copy sealed to the current key answers a name conflict and an archived copy stays final", async (t) => {
  const f = await fixture(t);
  await f.signIn();
  await assert.rejects(f.login({ platform: Platform.AnthropicSubscription }), {
    code: Code.NameConflict,
    status: HttpStatus.Conflict,
  });
  f.invoke(f.human, llmOperations.archive, {
    params: { credential_name: CREDENTIAL_NAME },
    query: { holder: INSTANCE },
    body: null,
  });
  await f.rotateKey(INSTANCE);
  await assert.rejects(f.login({ platform: Platform.AnthropicSubscription }), {
    code: Code.Archived,
    status: HttpStatus.Conflict,
  });
  assert.equal(f.rows().length, ONE_ROW);
});

test("a completed report fails when the copy turns live and current during the session", async (t) => {
  const f = await fixture(t);
  await f.signIn();
  const sealedKey = f.pairs.get(INSTANCE)!;
  await f.rotateKey(INSTANCE);
  const started = f.login({ platform: Platform.AnthropicSubscription });
  const entry = await f.listed();
  f.report(entry.session_id, { address: AUTHORIZATION_URL });
  await started;
  f.pairs.set(INSTANCE, sealedKey);
  const sealed = await f.sealFor(Platform.AnthropicSubscription);
  assert.throws(
    () =>
      f.report(entry.session_id, {
        state: InstanceLoginState.Completed,
        address: AUTHORIZATION_URL,
        ...sealed,
      }),
    { code: Code.NameConflict },
  );
  assert.equal(f.loginStatus(entry.session_id).state, LoginSessionState.Failed);
  assert.equal(f.rows().length, ONE_ROW);
});
