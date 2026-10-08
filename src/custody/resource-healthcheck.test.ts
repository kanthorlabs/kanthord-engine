import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { z } from "zod";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthScope, ResourceStatus } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  CUSTODY_SERVICE_NAME,
  SecretShape,
  type CredentialPlatformSet,
  type PlatformProbe,
} from "./contract.ts";
import { encrypt } from "./envelope.ts";
import { custodyMigrations } from "./migrations.ts";
import { CustodyComponent } from "./service.ts";

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

type ProbeCall = { secret: unknown; metadata: unknown };

function platformSet(calls: ProbeCall[]): CredentialPlatformSet {
  const probe: PlatformProbe = async (secret, metadata, context) => {
    if (context.err()) return ResourceStatus.Unknown;
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

function fixture(t: TestContext) {
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
      liveExecutionsPinning: () => [],
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
    platforms: {},
    envelopeKey: ENVELOPE_KEY,
    logger: pino({ enabled: false }),
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
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
        "INSERT INTO credential (id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
  assert.equal(await entry.check(background), ResourceStatus.Unknown);
  assert.equal(await check(background), ResourceStatus.Unknown);
  assert.equal(calls.length, NO_CALLS);
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
  });
  assert.equal(await check(background), answer.status);
  assert.deepEqual(calls, [
    { secret: { key: "newest" }, metadata: METADATA },
    { secret: { key: "newest" }, metadata: METADATA },
  ]);
  assert.equal(rowsSnapshot(store), before);
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
  });
  store.database
    .prepare("UPDATE credential SET ciphertext = ?")
    .run(Buffer.from(SECRET));
  assert.deepEqual(await component.verify(set, "probed", background), {
    status: ResourceStatus.Unknown,
    capability: PROBED_CAPABILITY,
  });
  assert.equal(calls.length, NO_CALLS);
});

test("verify answers unknown when the probe exceeds the 10 s deadline", async (t) => {
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
  });
});
