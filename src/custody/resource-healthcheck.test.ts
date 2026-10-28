import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { CredentialStore } from "@earendil-works/pi-ai";
import pino from "pino";
import { z } from "zod";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  HealthScope,
  ResourceFailureReason,
  ResourceStatus,
} from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { redactingLogger } from "../kernel/test-support.ts";
import {
  type CredentialPlatform,
  type CredentialPlatformSet,
  CUSTODY_SERVICE_NAME,
  type PlatformProbe,
  SecretShape,
} from "./contract.ts";
import { decrypt, encrypt } from "./envelope.ts";
import { custodyMigrations } from "./migrations.ts";
import { CustodyComponent } from "./service.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import { PROJECT_SERVICE_NAME } from "../project/contract.ts";

const SECRET = "test_private-resource-health-secret";
const ENVELOPE_KEY = Buffer.alloc(32, 7);
const PROBED_PLATFORM = "probed-platform";
const UNPROBED_PLATFORM = "unprobed-platform";
const FOREIGN_PLATFORM = "foreign-platform";
const PROBED_CAPABILITY = "probe read";
const UNPROBED_CAPABILITY = "none";
const TARGET_KIND_CREDENTIAL = "credential";
const NO_CALLS = 0;
const ONE_CALL = 1;
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const THIRD_REVISION = 3;
const METADATA = { endpoint: "https://probe.example" };
const FAILURE_REASON = "status=500";
const PROBED_NAME = "probed";
const VERIFY_FAILED_MESSAGE = "credential verify failed";
const BEFORE_REMOTE_CALL = "probe failed before the remote call";

type ProbeCall = { secret: unknown; metadata: unknown };

function platformSet(calls: ProbeCall[]): CredentialPlatformSet {
  const probe: PlatformProbe = async (secret, metadata, context) => {
    if (context.signal.aborted) return ResourceStatus.Unknown;
    calls.push({ secret, metadata });
    return ResourceStatus.Healthy;
  };
  return {
    platforms: {
      [PROBED_PLATFORM]: {
        secret_shape: SecretShape.ApiKey,
        login_modes: [],
        metadata_schema: z.strictObject({ endpoint: z.url() }),
        capability: PROBED_CAPABILITY,
        probe,
      },
      [UNPROBED_PLATFORM]: {
        secret_shape: SecretShape.ApiKey,
        login_modes: [],
        metadata_schema: null,
        capability: UNPROBED_CAPABILITY,
        probe: null,
      },
    },
  };
}

function fixture(
  t: TestContext,
  logger: pino.Logger = pino({ enabled: false }),
  owned: {
    platforms: Record<string, CredentialPlatform>;
    pinning: string[];
  } = {
    platforms: {},
    pinning: [],
  },
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => {
    if (store.database.isOpen) store.close();
  });
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const component = new CustodyComponent({
    executions: {
      requireRunning: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      pinCredential: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      liveExecutionsPinning: () => owned.pinning,
    },
    authorization: {
      authorizeModelInference: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
    },
    missionAuthorization: {
      frozenAction: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      serviceMerge: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      requestEvidence: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      evidenceAsset: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      objectPut: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
    },
    clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
    store,
    platforms: owned.platforms,
    envelopeKey: ENVELOPE_KEY,
    logger,
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    intakeServiceName: INTAKE_SERVICE_NAME,
    projectServiceName: PROJECT_SERVICE_NAME,
  });
  const calls: ProbeCall[] = [];
  return { store, component, calls, set: platformSet(calls) };
}

function insert(
  store: Store,
  platform: string,
  name: string,
  revision = FIRST_REVISION,
  endedAt: number | null = null,
  secret: unknown = { key: SECRET },
): string {
  const id = `${name}-${revision}`;
  const { nonce, ciphertext } = encrypt(ENVELOPE_KEY, id, platform, secret);
  store.transaction(({ database }) =>
    database
      .prepare(
        "INSERT INTO credential (id, name, platform, holder, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, 'server', ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        name,
        platform,
        revision,
        nonce,
        ciphertext,
        platform === PROBED_PLATFORM ? JSON.stringify(METADATA) : null,
        Date.now(),
        endedAt,
      ),
  );
  return id;
}

test("inventory snapshots one newest live revision per name of the platform set, encodes names and excludes ended and foreign names", async (t) => {
  const { store, component, calls, set } = fixture(t);
  const name = "team/a key";
  insert(store, PROBED_PLATFORM, name);
  const liveId = insert(store, PROBED_PLATFORM, name, SECOND_REVISION);
  insert(store, PROBED_PLATFORM, name, THIRD_REVISION, Date.now());
  insert(store, PROBED_PLATFORM, "ended", FIRST_REVISION, Date.now());
  insert(store, PROBED_PLATFORM, "ended", SECOND_REVISION, Date.now());
  insert(store, FOREIGN_PLATFORM, "foreign");
  const entries = store.transaction((tx) =>
    component.resourceInventory(tx, set),
  );
  assert.equal(calls.length, NO_CALLS);
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      scope: HealthScope.Global,
      project: null,
      name: encodeURIComponent(name),
      target: `${TARGET_KIND_CREDENTIAL}:${liveId}`,
      capability: PROBED_CAPABILITY,
    },
  ]);
  store.database
    .prepare("UPDATE credential SET metadata = ?, ciphertext = ?")
    .run("{}", Buffer.alloc(1));
  store.close();
  assert.equal(await entries[0]!.check(background), ResourceStatus.Healthy);
  assert.deepEqual(calls, [{ secret: { key: SECRET }, metadata: METADATA }]);
  assert.ok(!JSON.stringify(entries).includes(SECRET));
});

test("a platform without a probe reports unknown with its capability and no probe call", async (t) => {
  const { store, component, calls, set } = fixture(t);
  const id = insert(store, UNPROBED_PLATFORM, "plain");
  const entries = store.transaction((tx) =>
    component.resourceInventory(tx, set),
  );
  const check = store.transaction((tx) =>
    component.resourceCheck(tx, set, "plain"),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      scope: HealthScope.Global,
      project: null,
      name: "plain",
      target: `${TARGET_KIND_CREDENTIAL}:${id}`,
      capability: UNPROBED_CAPABILITY,
    },
  ]);
  store.close();
  assert.equal(await entries[0]!.check(background), ResourceStatus.Unknown);
  assert.equal(await check(background), ResourceStatus.Unknown);
  assert.equal(calls.length, NO_CALLS);
});

test("inventory and resource checks return unknown on corrupted ciphertext without leaking secrets", async (t) => {
  const { store, component, calls, set } = fixture(t);
  insert(store, PROBED_PLATFORM, "probed");
  store.database
    .prepare("UPDATE credential SET ciphertext = ?")
    .run(Buffer.from(SECRET));
  const entry = store.transaction((tx) =>
    component.resourceInventory(tx, set),
  )[0]!;
  const check = store.transaction((tx) =>
    component.resourceCheck(tx, set, "probed"),
  );
  store.close();
  const observed: string[] = [];
  const observe = (reason: string, failureReason: string) =>
    observed.push(`${reason}:${failureReason}`);
  assert.equal(await entry.check(background, observe), ResourceStatus.Unknown);
  assert.equal(await check(background, observe), ResourceStatus.Unknown);
  assert.equal(calls.length, NO_CALLS);
  assert.deepEqual(observed, [
    `${BEFORE_REMOTE_CALL}:${ResourceFailureReason.Unclassified}`,
    `${BEFORE_REMOTE_CALL}:${ResourceFailureReason.Unclassified}`,
  ]);
  assert.ok(!JSON.stringify(entry).includes(SECRET));
});

test("resource checks for absent, fully ended or foreign credentials make no probe call", async (t) => {
  const { store, component, calls, set } = fixture(t);
  insert(store, PROBED_PLATFORM, "ended", FIRST_REVISION, Date.now());
  insert(store, FOREIGN_PLATFORM, "foreign");
  const checks = store.transaction((tx) =>
    ["missing", "ended", "foreign"].map((name) =>
      component.resourceCheck(tx, set, name),
    ),
  );
  store.close();
  for (const check of checks)
    assert.equal(await check(background), ResourceStatus.Unknown);
  assert.equal(calls.length, NO_CALLS);
});

test("a resource check captures the newest live revision and its metadata", async (t) => {
  const { store, component, calls, set } = fixture(t);
  const older = { key: "older-key" };
  insert(store, PROBED_PLATFORM, "probed", FIRST_REVISION, null, older);
  insert(store, PROBED_PLATFORM, "probed", SECOND_REVISION);
  insert(store, PROBED_PLATFORM, "probed", THIRD_REVISION, Date.now(), older);
  const check = store.transaction((tx) =>
    component.resourceCheck(tx, set, "probed"),
  );
  store.close();
  assert.equal(await check(background), ResourceStatus.Healthy);
  assert.deepEqual(calls, [{ secret: { key: SECRET }, metadata: METADATA }]);
  const context = new CancellationContext();
  context.cancel();
  assert.equal(await check(context), ResourceStatus.Unknown);
  assert.equal(calls.length, ONE_CALL);
});

const VERIFY_DEADLINE_MS = 10000;
const NOT_FOUND_CODE = "credential.credential.not_found";
const ARCHIVED_CODE = "credential.credential.archived";
const CHECK_UNSUPPORTED_CODE = "credential.check.unsupported";

function operationError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof OperationError &&
    error.status === status &&
    error.code === code;
}

function rowsSnapshot(store: Store): string {
  return JSON.stringify(
    store.database.prepare("SELECT * FROM credential ORDER BY id").all(),
  );
}

test("verify probes the newest live revision, writes no row and agrees with the resource check", async (t) => {
  const { store, component, calls, set } = fixture(t);
  insert(store, PROBED_PLATFORM, "probed", FIRST_REVISION);
  insert(store, PROBED_PLATFORM, "probed", SECOND_REVISION, null, {
    key: "newest",
  });
  const before = rowsSnapshot(store);
  const answer = await component.verify(set, "probed", background);
  const check = store.transaction((tx) =>
    component.resourceCheck(tx, set, "probed"),
  );
  assert.deepEqual(answer, {
    status: ResourceStatus.Healthy,
    capability: PROBED_CAPABILITY,
    failure_reason: null,
  });
  assert.equal(await check(background), answer.status);
  assert.deepEqual(calls, [
    { secret: { key: "newest" }, metadata: METADATA },
    { secret: { key: "newest" }, metadata: METADATA },
  ]);
  assert.equal(rowsSnapshot(store), before);
});

test("verify logs the credential name as credential_name without redaction when the probe reports a failure", async (t) => {
  const lines: string[] = [];
  const { store, component } = fixture(t, redactingLogger(lines));
  insert(store, PROBED_PLATFORM, PROBED_NAME);
  const set: CredentialPlatformSet = {
    platforms: {
      [PROBED_PLATFORM]: {
        ...platformSet([]).platforms[PROBED_PLATFORM]!,
        probe: async (_secret, _metadata, _context, observe) => {
          observe?.(FAILURE_REASON, ResourceFailureReason.Unclassified);
          return ResourceStatus.Unknown;
        },
      },
    },
  };
  await component.verify(set, PROBED_NAME, background);
  const [record] = lines.map((line) => JSON.parse(line));
  assert.equal(record.msg, VERIFY_FAILED_MESSAGE);
  assert.equal(record.credential_name, PROBED_NAME);
  assert.equal(record.reason, FAILURE_REASON);
  assert.ok(!lines.join("").includes("[Redacted]"));
});

test("verify answers the failure reason that the probe observes", async (t) => {
  const { store, component, set } = fixture(t);
  insert(store, PROBED_PLATFORM, PROBED_NAME);
  const observing: CredentialPlatformSet = {
    platforms: {
      [PROBED_PLATFORM]: {
        ...set.platforms[PROBED_PLATFORM]!,
        probe: async (_secret, _metadata, _context, observe) => {
          observe?.(FAILURE_REASON, ResourceFailureReason.KeyRefused);
          return ResourceStatus.Unhealthy;
        },
      },
    },
  };
  assert.deepEqual(await component.verify(observing, PROBED_NAME, background), {
    status: ResourceStatus.Unhealthy,
    capability: PROBED_CAPABILITY,
    failure_reason: ResourceFailureReason.KeyRefused,
  });
});

test("verify refuses an archived record, a platform without a probe, a foreign name and an unknown name before any probe call", async (t) => {
  const { store, component, calls, set } = fixture(t);
  insert(store, PROBED_PLATFORM, "ended", FIRST_REVISION, Date.now());
  insert(store, UNPROBED_PLATFORM, "plain");
  insert(store, FOREIGN_PLATFORM, "foreign");
  insert(store, FOREIGN_PLATFORM, "foreign-ended", FIRST_REVISION, Date.now());
  const refusals = [
    ["ended", HttpStatus.Conflict, ARCHIVED_CODE],
    ["plain", HttpStatus.BadRequest, CHECK_UNSUPPORTED_CODE],
    ["foreign", HttpStatus.NotFound, NOT_FOUND_CODE],
    ["foreign-ended", HttpStatus.NotFound, NOT_FOUND_CODE],
    ["missing", HttpStatus.NotFound, NOT_FOUND_CODE],
  ] as const;
  for (const [name, status, code] of refusals)
    await assert.rejects(
      component.verify(set, name, background),
      operationError(status, code),
    );
  assert.equal(calls.length, NO_CALLS);
});

test("verify answers unknown on corrupted ciphertext and on a cancelled caller without a probe call", async (t) => {
  const { store, component, calls, set } = fixture(t);
  insert(store, PROBED_PLATFORM, "probed");
  const cancelled = new CancellationContext();
  cancelled.cancel();
  assert.deepEqual(await component.verify(set, "probed", cancelled), {
    status: ResourceStatus.Unknown,
    capability: PROBED_CAPABILITY,
    failure_reason: ResourceFailureReason.Unclassified,
  });
  store.database
    .prepare("UPDATE credential SET ciphertext = ?")
    .run(Buffer.from(SECRET));
  assert.deepEqual(await component.verify(set, "probed", background), {
    status: ResourceStatus.Unknown,
    capability: PROBED_CAPABILITY,
    failure_reason: ResourceFailureReason.Unclassified,
  });
  assert.equal(calls.length, NO_CALLS);
});

test("verify answers deadline_exceeded when the probe exceeds the 10 s deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { store, component, set } = fixture(t);
  insert(store, PROBED_PLATFORM, "probed");
  const hanging: CredentialPlatformSet = {
    platforms: {
      [PROBED_PLATFORM]: {
        ...set.platforms[PROBED_PLATFORM]!,
        probe: () => new Promise(() => {}),
      },
    },
  };
  const pending = component.verify(hanging, "probed", background);
  t.mock.timers.tick(VERIFY_DEADLINE_MS);
  assert.deepEqual(await pending, {
    status: ResourceStatus.Unknown,
    capability: PROBED_CAPABILITY,
    failure_reason: ResourceFailureReason.DeadlineExceeded,
  });
});

test("verify answers unclassified when the caller cancels the probe", async (t) => {
  const { store, component, set } = fixture(t);
  insert(store, PROBED_PLATFORM, "probed");
  const caller = new CancellationContext();
  const hanging: CredentialPlatformSet = {
    platforms: {
      [PROBED_PLATFORM]: {
        ...set.platforms[PROBED_PLATFORM]!,
        probe: () => {
          caller.cancel();
          return new Promise(() => {});
        },
      },
    },
  };
  assert.deepEqual(await component.verify(hanging, "probed", caller), {
    status: ResourceStatus.Unknown,
    capability: PROBED_CAPABILITY,
    failure_reason: ResourceFailureReason.Unclassified,
  });
});

const OAUTH_PLATFORM = "anthropic-subscription";
const OAUTH_PROVIDER_ID = "anthropic";
const OAUTH_NAME = "subscription";
const EXPIRED_OAUTH = {
  refresh: "test_private-stored-refresh",
  access: "test_private-stored-access",
  expires: 1,
};
const REFRESHED_OAUTH = {
  refresh: "test_private-refreshed-refresh",
  access: "test_private-refreshed-access",
  expires: 4102444800000,
};
const LIVE_EXECUTION = "execution-live";

type RefreshProbeCall = { stored: unknown; refreshStore: boolean };

function oauthPlatform(calls: RefreshProbeCall[]): CredentialPlatform {
  return {
    secret_shape: SecretShape.OAuth,
    login_modes: [],
    metadata_schema: null,
    capability: PROBED_CAPABILITY,
    probe: async (_secret, _metadata, _context, _observe, refreshStore) => {
      calls.push({
        stored: await refreshStore?.read(OAUTH_PROVIDER_ID),
        refreshStore: refreshStore !== undefined,
      });
      await refreshStore?.modify(OAUTH_PROVIDER_ID, async () => ({
        type: SecretShape.OAuth,
        ...REFRESHED_OAUTH,
      }));
      return ResourceStatus.Healthy;
    },
  };
}

function oauthFixture(
  t: TestContext,
  pinning: string[] = [],
  logger: pino.Logger = pino({ enabled: false }),
) {
  const calls: RefreshProbeCall[] = [];
  const platform = oauthPlatform(calls);
  const owned = fixture(t, logger, {
    platforms: { [OAUTH_PLATFORM]: platform },
    pinning,
  });
  const set: CredentialPlatformSet = {
    platforms: { [OAUTH_PLATFORM]: platform },
  };
  const id = insert(
    owned.store,
    OAUTH_PLATFORM,
    OAUTH_NAME,
    FIRST_REVISION,
    null,
    EXPIRED_OAUTH,
  );
  const stored = () => {
    const rows = owned.store.database
      .prepare("SELECT id, revision, nonce, ciphertext FROM credential")
      .all() as {
      id: string;
      revision: number;
      nonce: Buffer;
      ciphertext: Buffer;
    }[];
    return rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      secret: decrypt(
        ENVELOPE_KEY,
        row.id,
        OAUTH_PLATFORM,
        row.nonce,
        row.ciphertext,
      ),
    }));
  };
  return { ...owned, set, calls, id, stored };
}

test("verify hands the probe a refresh store of the OAuth record and writes the refreshed value in place at the same revision", async (t) => {
  const { component, set, calls, id, stored } = oauthFixture(t);
  assert.deepEqual(await component.verify(set, OAUTH_NAME, background), {
    status: ResourceStatus.Healthy,
    capability: PROBED_CAPABILITY,
    failure_reason: null,
  });
  assert.deepEqual(calls, [
    {
      stored: { type: SecretShape.OAuth, ...EXPIRED_OAUTH },
      refreshStore: true,
    },
  ]);
  assert.deepEqual(stored(), [
    { id, revision: FIRST_REVISION, secret: REFRESHED_OAUTH },
  ]);
});

test("verify hands no refresh store while a live execution pins the OAuth revision", async (t) => {
  const { component, set, calls, id, stored } = oauthFixture(t, [
    LIVE_EXECUTION,
  ]);
  await component.verify(set, OAUTH_NAME, background);
  assert.deepEqual(calls, [{ stored: undefined, refreshStore: false }]);
  assert.deepEqual(stored(), [
    { id, revision: FIRST_REVISION, secret: EXPIRED_OAUTH },
  ]);
});

test("verify and the resource check hand no refresh store for an api_key record", async (t) => {
  const { store, component } = fixture(t);
  insert(store, PROBED_PLATFORM, PROBED_NAME);
  const stores: Array<CredentialStore | undefined> = [];
  const recording: CredentialPlatformSet = {
    platforms: {
      [PROBED_PLATFORM]: {
        ...platformSet([]).platforms[PROBED_PLATFORM]!,
        probe: async (_secret, _metadata, _context, _observe, refreshStore) => {
          stores.push(refreshStore);
          return ResourceStatus.Healthy;
        },
      },
    },
  };
  await component.verify(recording, PROBED_NAME, background);
  await store.transaction((tx) =>
    component.resourceCheck(tx, recording, PROBED_NAME),
  )(background);
  assert.deepEqual(stores, [undefined, undefined]);
});

test("the resource check and the inventory check of an OAuth record write the refreshed value in place through the refresh store", async (t) => {
  for (const check of [
    (f: ReturnType<typeof oauthFixture>) =>
      f.store.transaction((tx) =>
        f.component.resourceCheck(tx, f.set, OAUTH_NAME),
      ),
    (f: ReturnType<typeof oauthFixture>) =>
      f.store.transaction(
        (tx) => f.component.resourceInventory(tx, f.set)[0]!.check,
      ),
  ]) {
    const f = oauthFixture(t);
    assert.equal(await check(f)(background), ResourceStatus.Healthy);
    assert.deepEqual(f.calls, [
      {
        stored: { type: SecretShape.OAuth, ...EXPIRED_OAUTH },
        refreshStore: true,
      },
    ]);
    assert.deepEqual(f.stored(), [
      { id: f.id, revision: FIRST_REVISION, secret: REFRESHED_OAUTH },
    ]);
  }
});

test("the resource check, the inventory check and the check material hand no refresh store while a live execution pins the OAuth revision", async (t) => {
  const f = oauthFixture(t, [LIVE_EXECUTION]);
  await f.store.transaction((tx) =>
    f.component.resourceCheck(tx, f.set, OAUTH_NAME),
  )(background);
  await f.store.transaction(
    (tx) => f.component.resourceInventory(tx, f.set)[0]!.check,
  )(background);
  const material = f.store.transaction((tx) =>
    f.component.checkMaterial(tx, f.set, OAUTH_NAME),
  );
  assert.deepEqual(f.calls, [
    { stored: undefined, refreshStore: false },
    { stored: undefined, refreshStore: false },
  ]);
  assert.equal(material?.refreshStore, null);
  assert.deepEqual(f.stored(), [
    { id: f.id, revision: FIRST_REVISION, secret: EXPIRED_OAUTH },
  ]);
});

test("the check material of an OAuth record carries a refresh store that writes in place, and an api_key record carries none", async (t) => {
  const f = oauthFixture(t);
  const material = f.store.transaction((tx) =>
    f.component.checkMaterial(tx, f.set, OAUTH_NAME),
  );
  assert.deepEqual(await material?.refreshStore?.read(OAUTH_PROVIDER_ID), {
    type: SecretShape.OAuth,
    ...EXPIRED_OAUTH,
  });
  await material?.refreshStore?.modify(OAUTH_PROVIDER_ID, async () => ({
    type: SecretShape.OAuth,
    ...REFRESHED_OAUTH,
  }));
  assert.deepEqual(f.stored(), [
    { id: f.id, revision: FIRST_REVISION, secret: REFRESHED_OAUTH },
  ]);
  const plain = fixture(t);
  insert(plain.store, PROBED_PLATFORM, PROBED_NAME);
  assert.equal(
    plain.store.transaction((tx) =>
      plain.component.checkMaterial(tx, plain.set, PROBED_NAME),
    )?.refreshStore,
    null,
  );
});

const STALE_REFRESH_MESSAGE = "credential refresh stale";
const OTHER_OAUTH = {
  refresh: "test_private-other-refresh",
  access: "test_private-other-access",
  expires: 4102444800001,
};

test("two refresh stores of one record serialize modify, so the second sees the value of the first refresh and refreshes nothing", async (t) => {
  const f = oauthFixture(t);
  const refreshStore = () =>
    f.store.transaction((tx) =>
      f.component.checkMaterial(tx, f.set, OAUTH_NAME),
    )!.refreshStore!;
  const first = refreshStore();
  const second = refreshStore();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: unknown[] = [];
  const refreshing = first.modify(OAUTH_PROVIDER_ID, async (current) => {
    seen.push(current);
    await gate;
    return { type: SecretShape.OAuth, ...REFRESHED_OAUTH };
  });
  const waiting = second.modify(OAUTH_PROVIDER_ID, async (current) => {
    seen.push(current);
    return undefined;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, ONE_CALL);
  release();
  await Promise.all([refreshing, waiting]);
  assert.deepEqual(seen, [
    { type: SecretShape.OAuth, ...EXPIRED_OAUTH },
    { type: SecretShape.OAuth, ...REFRESHED_OAUTH },
  ]);
  assert.deepEqual(f.stored(), [
    { id: f.id, revision: FIRST_REVISION, secret: REFRESHED_OAUTH },
  ]);
});

test("a pin that commits after the check and before modify runs no refresh and keeps the row", async (t) => {
  const pinning: string[] = [];
  const f = oauthFixture(t, pinning);
  const check = f.store.transaction((tx) =>
    f.component.resourceCheck(tx, f.set, OAUTH_NAME),
  );
  const material = f.store.transaction((tx) =>
    f.component.checkMaterial(tx, f.set, OAUTH_NAME),
  );
  pinning.push(LIVE_EXECUTION);
  let refreshes = NO_CALLS;
  assert.equal(await check(background), ResourceStatus.Healthy);
  assert.deepEqual(
    await material!.refreshStore!.modify(OAUTH_PROVIDER_ID, async () => {
      refreshes += ONE_CALL;
      return { type: SecretShape.OAuth, ...REFRESHED_OAUTH };
    }),
    { type: SecretShape.OAuth, ...EXPIRED_OAUTH },
  );
  assert.equal(refreshes, NO_CALLS);
  assert.deepEqual(f.calls, [
    {
      stored: { type: SecretShape.OAuth, ...EXPIRED_OAUTH },
      refreshStore: true,
    },
  ]);
  assert.deepEqual(f.stored(), [
    { id: f.id, revision: FIRST_REVISION, secret: EXPIRED_OAUTH },
  ]);
});

test("a pin that commits during the refresh refuses the write and keeps the row", async (t) => {
  const pinning: string[] = [];
  const f = oauthFixture(t, pinning);
  const material = f.store.transaction((tx) =>
    f.component.checkMaterial(tx, f.set, OAUTH_NAME),
  );
  await assert.rejects(
    material!.refreshStore!.modify(OAUTH_PROVIDER_ID, async () => {
      pinning.push(LIVE_EXECUTION);
      return { type: SecretShape.OAuth, ...REFRESHED_OAUTH };
    }),
    /A live execution holds the credential revision/,
  );
  assert.deepEqual(f.stored(), [
    { id: f.id, revision: FIRST_REVISION, secret: EXPIRED_OAUTH },
  ]);
});

test("a refresh write whose stored value changed during the refresh writes nothing and logs credential refresh stale", async (t) => {
  const lines: string[] = [];
  const f = oauthFixture(t, [], redactingLogger(lines));
  const material = f.store.transaction((tx) =>
    f.component.checkMaterial(tx, f.set, OAUTH_NAME),
  );
  await material!.refreshStore!.modify(OAUTH_PROVIDER_ID, async () => {
    const { nonce, ciphertext } = encrypt(
      ENVELOPE_KEY,
      f.id,
      OAUTH_PLATFORM,
      OTHER_OAUTH,
    );
    f.store.database
      .prepare("UPDATE credential SET nonce = ?, ciphertext = ? WHERE id = ?")
      .run(nonce, ciphertext, f.id);
    return { type: SecretShape.OAuth, ...REFRESHED_OAUTH };
  });
  assert.deepEqual(f.stored(), [
    { id: f.id, revision: FIRST_REVISION, secret: OTHER_OAUTH },
  ]);
  const records = lines.map((line) => JSON.parse(line));
  assert.ok(
    records.some(
      (record) =>
        record.msg === STALE_REFRESH_MESSAGE && record.credential_id === f.id,
    ),
  );
});
