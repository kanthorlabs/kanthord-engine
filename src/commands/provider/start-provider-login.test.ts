import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LoginError } from "../../services/provider-auth/index.ts";
import type {
  LoginChallenge,
  OauthVendor,
  ProviderAuth,
  StartLoginInput,
} from "../../services/provider-auth/index.ts";
import { StorageError } from "../../services/storage/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import { createFakeProviderAuth } from "../../../test/helpers/provider-auth.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  isPendingLoginConflict,
  startProviderLogin,
} from "./start-provider-login.ts";
import type {
  StartProviderLoginDependencies,
  StartProviderLoginRefusal,
} from "./start-provider-login.ts";
import { StartProviderLoginError } from "./start-provider-login.ts";

const NOW = 1_700_000_000_000;
const INSTANCE_ID = "daemon_current";
const LOGIN_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const OLD_LOGIN_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const LOGIN_ID = `login_${LOGIN_ULID}`;
const OLD_LOGIN_ID = `login_${OLD_LOGIN_ULID}`;
const PROVIDER = "openai-codex";
const DEVICE_CHALLENGE: LoginChallenge = {
  method: "device-code",
  userCode: "WDJB-MJHT",
  verificationUri: "https://vendor.test/device",
  pollIntervalMs: 7_000,
  expiresAt: NOW + 300_000,
};
const MANUAL_CHALLENGE: LoginChallenge = {
  method: "manual-code",
  authUrl: "https://vendor.test/authorize",
  instructions: "Complete login in your browser.",
  expiresAt: null,
};
const VENDOR: OauthVendor = {
  id: PROVIDER,
  label: "OpenAI Codex",
  isSubscription: true,
};

type LoginReadback = Readonly<{
  id: string;
  provider: string;
  method: string;
  state: string;
  instance_id: string;
  payload_ciphertext: Uint8Array | null;
  payload_iv: Uint8Array | null;
  payload_tag: Uint8Array | null;
  key_version: number | null;
  created_at: number;
  expires_at: number;
}>;

type MutableClock = Clock & Readonly<{ set(value: number): void }>;

type AuthFixture = Readonly<{
  auth: ProviderAuth;
  starts: StartLoginInput[];
  aborts: string[];
}>;

function createAuth(
  startLogin: (
    input: StartLoginInput,
  ) => LoginChallenge | Promise<LoginChallenge> = async () => DEVICE_CHALLENGE,
  vendors: readonly OauthVendor[] = [VENDOR],
): AuthFixture {
  const starts: StartLoginInput[] = [];
  const aborts: string[] = [];
  const auth = createFakeProviderAuth({
    oauthVendors: () => vendors,
    startLogin: async (input) => {
      starts.push(input);
      return startLogin(input);
    },
    abortLogin: (loginId) => {
      aborts.push(loginId);
    },
  });
  return { auth, starts, aborts };
}

function createDependencies(
  storage: Storage,
  providerAuth: ProviderAuth,
  ids: StartProviderLoginDependencies["ids"],
  clock: Clock,
  instanceId = INSTANCE_ID,
): StartProviderLoginDependencies {
  return { storage, providerAuth, ids, clock, instanceId };
}

function countLogins(storage: Storage): number {
  const row = storage.transact((transaction) =>
    transaction.get("SELECT COUNT(*) AS count FROM provider_login"),
  ) as { count: number };
  return row.count;
}

function readLogin(storage: Storage, id?: string): LoginReadback | undefined {
  return storage.transact((transaction) =>
    transaction.get(
      id === undefined
        ? "SELECT id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at FROM provider_login"
        : "SELECT id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at FROM provider_login WHERE id = ?",
      id === undefined ? [] : [id],
    ),
  ) as LoginReadback | undefined;
}

function insertPending(
  storage: Storage,
  input: Readonly<{
    id: string;
    provider?: string;
    method?: "manual-code" | "device-code";
    instanceId?: string;
    createdAt?: number;
    expiresAt?: number;
  }>,
): void {
  storage.transact((transaction) =>
    transaction.run(
      "INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)",
      [
        input.id,
        input.provider ?? PROVIDER,
        input.method ?? "device-code",
        input.instanceId ?? INSTANCE_ID,
        input.createdAt ?? NOW,
        input.expiresAt ?? NOW + 600_000,
      ],
    ),
  );
}

function mutableClock(start: number): MutableClock {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
  };
}

function storageAfterFirstTransaction(
  storage: Storage,
  after: () => void,
): Storage {
  let transactions = 0;
  return {
    transact<T>(work: (transaction: Transaction) => T): T {
      const result = storage.transact(work);
      transactions++;
      if (transactions === 1) after();
      return result;
    },
    migrate: () => storage.migrate(),
    status: () => storage.status(),
    close: () => storage.close(),
    ping: () => storage.ping(),
  };
}

function assertStartRefusal(
  operation: () => Promise<unknown>,
  refusal: StartProviderLoginRefusal,
  detail?: string,
): Promise<StartProviderLoginError> {
  let captured: StartProviderLoginError | undefined;
  return assert
    .rejects(operation, (error: unknown) => {
      if (!(error instanceof StartProviderLoginError)) return false;
      captured = error;
      assert.equal(error.refusal, refusal);
      if (detail !== undefined) assert.equal(error.detail, detail);
      return true;
    })
    .then(() => {
      assert.ok(captured !== undefined);
      return captured;
    });
}

describe("src/commands/provider/start-provider-login.test", () => {
  it("refuses a vendor with no oauth flow and calls the service no further", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth(async () => {
      throw new Error("startLogin must not be called");
    }, []);

    await assertStartRefusal(
      () =>
        startProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockIdGenerator({ ulids: [] }),
            createMockClock({ start: NOW }),
          ),
          { provider: "openai", answers: {} },
        ),
      "provider-not-oauth-capable",
    );
    assert.equal(fixture.starts.length, 0);
    assert.equal(countLogins(temporary.storage), 0);
  });

  it("inserts one pending row and answers the device challenge", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth();

    const result = await startProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockIdGenerator({ ulids: [LOGIN_ULID] }),
        createMockClock({ start: NOW }),
      ),
      { provider: PROVIDER, answers: {} },
    );

    assert.deepEqual(result, {
      loginId: LOGIN_ID,
      method: "device-code",
      expiresAt: NOW + 300_000,
      userCode: "WDJB-MJHT",
      verificationUri: "https://vendor.test/device",
      pollIntervalMs: 7_000,
    });
    assert.deepEqual(fixture.starts, [
      { loginId: LOGIN_ID, vendorId: PROVIDER, answers: {} },
    ]);
    assert.equal(countLogins(temporary.storage), 1);
    const row = readLogin(temporary.storage, LOGIN_ID);
    assert.ok(row !== undefined);
    assert.equal(row.state, "pending");
    assert.equal(row.method, "device-code");
    assert.equal(row.payload_ciphertext, null);
    assert.equal(row.payload_iv, null);
    assert.equal(row.payload_tag, null);
    assert.equal(row.key_version, null);
  });

  it("answers the manual challenge and times its expiry from created_at", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth(async () => MANUAL_CHALLENGE);

    const result = await startProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockIdGenerator({ ulids: [LOGIN_ULID] }),
        createMockClock({ start: NOW }),
      ),
      { provider: PROVIDER, answers: {} },
    );

    assert.deepEqual(result, {
      loginId: LOGIN_ID,
      method: "manual-code",
      expiresAt: NOW + 600_000,
      authUrl: "https://vendor.test/authorize",
      instructions: "Complete login in your browser.",
    });
    const row = readLogin(temporary.storage, LOGIN_ID);
    assert.ok(row !== undefined);
    assert.equal(row.created_at, NOW);
    assert.equal(row.expires_at, NOW + 600_000);
  });

  it("takes the device expiry from the challenge, not from created_at", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const challenge: LoginChallenge = {
      ...DEVICE_CHALLENGE,
      expiresAt: NOW + 300_000,
    };
    const fixture = createAuth(async () => challenge);
    const clock = createMockClock({ start: NOW });

    await startProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockIdGenerator({ ulids: [LOGIN_ULID] }),
        clock,
      ),
      { provider: PROVIDER, answers: {} },
    );

    const row = readLogin(temporary.storage, LOGIN_ID);
    assert.ok(row !== undefined);
    assert.equal(row.expires_at, NOW + 300_000);
    assert.notEqual(row.expires_at, NOW + 600_000);
  });

  it("refuses a second start for the same vendor with login-in-progress", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth();
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      createMockIdGenerator({ ulids: [LOGIN_ULID] }),
      createMockClock({ start: NOW }),
    );

    await startProviderLogin(dependencies, {
      provider: PROVIDER,
      answers: {},
    });
    await assertStartRefusal(
      () =>
        startProviderLogin(dependencies, {
          provider: PROVIDER,
          answers: {},
        }),
      "login-in-progress",
    );
    assert.equal(countLogins(temporary.storage), 1);
    assert.equal(fixture.starts.length, 1);
  });

  it("allows a start for a different vendor", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secondProvider = "anthropic";
    const fixture = createAuth(
      async (input) => ({
        ...DEVICE_CHALLENGE,
        expiresAt:
          input.vendorId === secondProvider ? NOW + 400_000 : NOW + 300_000,
      }),
      [VENDOR, { ...VENDOR, id: secondProvider }],
    );
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      createMockIdGenerator({
        ulids: [LOGIN_ULID, OLD_LOGIN_ULID],
      }),
      createMockClock({ start: NOW }),
    );

    await startProviderLogin(dependencies, {
      provider: PROVIDER,
      answers: {},
    });
    await startProviderLogin(dependencies, {
      provider: secondProvider,
      answers: {},
    });

    assert.equal(countLogins(temporary.storage), 2);
  });

  it("refuses login-expired on an expired pending row, deletes it, and aborts", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, {
      id: OLD_LOGIN_ID,
      expiresAt: NOW + 100,
    });
    const fixture = createAuth();
    const clock = mutableClock(NOW + 100);
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      createMockIdGenerator({ ulids: [LOGIN_ULID] }),
      clock,
    );

    await assertStartRefusal(
      () =>
        startProviderLogin(dependencies, {
          provider: PROVIDER,
          answers: {},
        }),
      "login-expired",
    );
    assert.equal(countLogins(temporary.storage), 0);
    assert.deepEqual(fixture.aborts, [OLD_LOGIN_ID]);

    const result = await startProviderLogin(dependencies, {
      provider: PROVIDER,
      answers: {},
    });
    assert.equal(result.loginId, LOGIN_ID);
    assert.equal(countLogins(temporary.storage), 1);
  });

  it("maps login-input-required with the exact prompt message in detail", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const message = "GitHub Enterprise URL/domain (blank for github.com)";
    const fixture = createAuth(async () => {
      throw new LoginError("login-input-required", "answer required", message);
    });

    await assertStartRefusal(
      () =>
        startProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockIdGenerator({ ulids: [LOGIN_ULID] }),
            createMockClock({ start: NOW }),
          ),
          { provider: PROVIDER, answers: {} },
        ),
      "login-input-required",
      message,
    );
    assert.equal(countLogins(temporary.storage), 0);
  });

  it("maps login-method-unavailable and writes no row", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth(async () => {
      throw new LoginError(
        "login-method-unavailable",
        "method unavailable",
        "qr,sms",
      );
    });

    await assertStartRefusal(
      () =>
        startProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockIdGenerator({ ulids: [LOGIN_ULID] }),
            createMockClock({ start: NOW }),
          ),
          { provider: PROVIDER, answers: {} },
        ),
      "login-method-unavailable",
      "qr,sms",
    );
    assert.equal(countLogins(temporary.storage), 0);
  });

  it("aborts and refuses login-in-progress when the insert loses the unique index", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth();
    const storage = storageAfterFirstTransaction(temporary.storage, () => {
      insertPending(temporary.storage, { id: OLD_LOGIN_ID });
    });

    await assertStartRefusal(
      () =>
        startProviderLogin(
          createDependencies(
            storage,
            fixture.auth,
            createMockIdGenerator({ ulids: [LOGIN_ULID] }),
            createMockClock({ start: NOW }),
          ),
          { provider: PROVIDER, answers: {} },
        ),
      "login-in-progress",
    );
    assert.deepEqual(fixture.aborts, [LOGIN_ID]);
    assert.equal(countLogins(temporary.storage), 1);
  });

  it("stores the running instance id", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth();

    await startProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockIdGenerator({ ulids: [LOGIN_ULID] }),
        createMockClock({ start: NOW }),
        "daemon_instance_42",
      ),
      { provider: PROVIDER, answers: {} },
    );

    const row = readLogin(temporary.storage, LOGIN_ID);
    assert.ok(row !== undefined);
    assert.equal(row.instance_id, "daemon_instance_42");
  });

  it("never stores or returns a token", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth();

    const result = await startProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockIdGenerator({ ulids: [LOGIN_ULID] }),
        createMockClock({ start: NOW }),
      ),
      { provider: PROVIDER, answers: {} },
    );
    const row = readLogin(temporary.storage, LOGIN_ID);
    assert.ok(row !== undefined);
    const serialized = JSON.stringify({ result, row });
    assert.equal(serialized.includes("at-1"), false);
    assert.equal(serialized.includes("rt-1"), false);
  });

  it("the expired teardown survives the refusal", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, {
      id: OLD_LOGIN_ID,
      expiresAt: NOW,
    });
    const fixture = createAuth();

    await assertStartRefusal(
      () =>
        startProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockIdGenerator({ ulids: [LOGIN_ULID] }),
            mutableClock(NOW),
          ),
          { provider: PROVIDER, answers: {} },
        ),
      "login-expired",
    );
    assert.equal(countLogins(temporary.storage), 0);
  });

  it("maps only a unique-constraint failure to login-in-progress", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, { id: OLD_LOGIN_ID });
    let conflict: unknown;
    try {
      temporary.storage.transact((transaction) =>
        transaction.run(
          "INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at) VALUES (?, ?, 'device-code', 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)",
          [LOGIN_ID, PROVIDER, INSTANCE_ID, NOW, NOW + 600_000],
        ),
      );
    } catch (error) {
      conflict = error;
    }
    assert.ok(conflict instanceof Error);
    assert.equal(isPendingLoginConflict(conflict), true);
    assert.equal(
      isPendingLoginConflict(
        new StorageError("storage-transaction-failed", "the disk is full"),
      ),
      false,
    );

    temporary.storage.transact((transaction) =>
      transaction.run("DELETE FROM provider_login WHERE id = ?", [
        OLD_LOGIN_ID,
      ]),
    );
    const fixture = createAuth();
    const failure = new StorageError(
      "storage-transaction-failed",
      "the disk is full",
    );
    let transactions = 0;
    const brokenStorage: Storage = {
      transact<T>(work: (transaction: Transaction) => T): T {
        transactions++;
        if (transactions === 2) throw failure;
        return temporary.storage.transact(work);
      },
      migrate: () => temporary.storage.migrate(),
      status: () => temporary.storage.status(),
      close: () => temporary.storage.close(),
      ping: () => temporary.storage.ping(),
    };

    await assert.rejects(
      () =>
        startProviderLogin(
          createDependencies(
            brokenStorage,
            fixture.auth,
            createMockIdGenerator({ ulids: [LOGIN_ULID] }),
            createMockClock({ start: NOW }),
          ),
          { provider: PROVIDER, answers: {} },
        ),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(fixture.aborts, [LOGIN_ID]);
  });
});
