import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  LoginChallenge,
  OauthVendor,
  ProviderAuth,
} from "../../services/provider-auth/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { createFakeProviderAuth } from "../../../test/helpers/provider-auth.ts";
import { startProviderLogin } from "./start-provider-login.ts";
import type { StartProviderLoginDependencies } from "./start-provider-login.ts";
import {
  cancelProviderLogin,
  CancelProviderLoginError,
} from "./cancel-provider-login.ts";
import type {
  CancelProviderLoginDependencies,
  CancelProviderLoginRefusal,
} from "./cancel-provider-login.ts";

const NOW = 1_700_000_000_000;
const INSTANCE_ID = "daemon_current";
const LOGIN_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const SECOND_LOGIN_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const LOGIN_ID = `login_${LOGIN_ULID}`;
const SECOND_LOGIN_ID = `login_${SECOND_LOGIN_ULID}`;
const PROVIDER = "openai-codex";
const VENDOR: OauthVendor = {
  id: PROVIDER,
  label: "OpenAI Codex",
  isSubscription: true,
};
const DEVICE_CHALLENGE: LoginChallenge = {
  method: "device-code",
  userCode: "WDJB-MJHT",
  verificationUri: "https://vendor.test/device",
  pollIntervalMs: 7_000,
  expiresAt: NOW + 300_000,
};

type AuthFixture = Readonly<{
  auth: ProviderAuth;
  aborts: string[];
}>;

function createAuth(abortLogin?: (loginId: string) => void): AuthFixture {
  const aborts: string[] = [];
  const auth = createFakeProviderAuth({
    oauthVendors: () => [VENDOR],
    startLogin: async () => DEVICE_CHALLENGE,
    abortLogin: (loginId) => {
      aborts.push(loginId);
      abortLogin?.(loginId);
    },
  });
  return { auth, aborts };
}

function createDependencies(
  storage: Storage,
  providerAuth: ProviderAuth,
): CancelProviderLoginDependencies {
  return { storage, providerAuth };
}

function createStartDependencies(
  storage: Storage,
  providerAuth: ProviderAuth,
): StartProviderLoginDependencies {
  return {
    storage,
    providerAuth,
    ids: createMockIdGenerator({ ulids: [SECOND_LOGIN_ULID] }),
    clock: createMockClock({ start: NOW }),
    instanceId: INSTANCE_ID,
  };
}

function countRows(
  storage: Storage,
  table: "provider" | "provider_login",
): number {
  const row = storage.transact((transaction) =>
    transaction.get(`SELECT COUNT(*) AS count FROM ${table}`),
  ) as { count: number };
  return row.count;
}

function insertLogin(
  storage: Storage,
  input: Readonly<{
    id?: string;
    state?: "pending" | "completed";
    method?: "manual-code" | "device-code";
    provider?: string;
    instanceId?: string;
  }> = {},
): void {
  const state = input.state ?? "pending";
  const completed = state === "completed";
  storage.transact((transaction) =>
    transaction.run(
      "INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        input.id ?? LOGIN_ID,
        input.provider ?? PROVIDER,
        input.method ?? "device-code",
        state,
        input.instanceId ?? INSTANCE_ID,
        completed ? new Uint8Array([1, 2, 3]) : null,
        completed ? new Uint8Array(12) : null,
        completed ? new Uint8Array(16) : null,
        completed ? 1 : null,
        NOW,
        NOW + 600_000,
      ],
    ),
  );
}

function assertCancelRefusal(
  operation: () => Promise<unknown>,
  refusal: CancelProviderLoginRefusal,
): Promise<CancelProviderLoginError> {
  let captured: CancelProviderLoginError | undefined;
  return assert
    .rejects(operation, (error: unknown) => {
      if (!(error instanceof CancelProviderLoginError)) return false;
      captured = error;
      assert.equal(error.refusal, refusal);
      return true;
    })
    .then(() => {
      assert.ok(captured !== undefined);
      return captured;
    });
}

describe("src/commands/provider/cancel-provider-login.test", () => {
  it("cancels a pending login, aborts the flow and leaves zero rows", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertLogin(temporary.storage);
    const fixture = createAuth();

    const result = await cancelProviderLogin(
      createDependencies(temporary.storage, fixture.auth),
      { loginId: LOGIN_ID },
    );

    assert.equal(result, undefined);
    assert.deepEqual(fixture.aborts, [LOGIN_ID]);
    assert.equal(countRows(temporary.storage, "provider_login"), 0);
  });

  it("cancels a completed login and writes no provider row", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertLogin(temporary.storage, { state: "completed" });
    const fixture = createAuth();

    await cancelProviderLogin(
      createDependencies(temporary.storage, fixture.auth),
      { loginId: LOGIN_ID },
    );

    assert.equal(countRows(temporary.storage, "provider_login"), 0);
    assert.equal(countRows(temporary.storage, "provider"), 0);
  });

  it("answers not-found for an unknown loginId", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth();

    await assertCancelRefusal(
      () =>
        cancelProviderLogin(
          createDependencies(temporary.storage, fixture.auth),
          { loginId: LOGIN_ID },
        ),
      "not-found",
    );
    assert.deepEqual(fixture.aborts, []);
    assert.equal(countRows(temporary.storage, "provider_login"), 0);
  });

  it("a start for the same vendor immediately after a cancel succeeds", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertLogin(temporary.storage);
    const fixture = createAuth();

    await cancelProviderLogin(
      createDependencies(temporary.storage, fixture.auth),
      { loginId: LOGIN_ID },
    );
    const result = await startProviderLogin(
      createStartDependencies(temporary.storage, fixture.auth),
      { provider: PROVIDER, answers: {} },
    );

    assert.equal(result.loginId, SECOND_LOGIN_ID);
    assert.equal(countRows(temporary.storage, "provider_login"), 1);
  });

  it("is safe when the service has no live flow", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertLogin(temporary.storage);
    const fixture = createAuth(() => {});

    await cancelProviderLogin(
      createDependencies(temporary.storage, fixture.auth),
      { loginId: LOGIN_ID },
    );

    assert.deepEqual(fixture.aborts, [LOGIN_ID]);
    assert.equal(countRows(temporary.storage, "provider_login"), 0);
  });
});
