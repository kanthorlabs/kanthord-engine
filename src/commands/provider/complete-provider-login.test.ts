import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OAuthAuth } from "@earendil-works/pi-ai";

import { LoginError } from "../../services/provider-auth/index.ts";
import { PiAiProviderAuth } from "../../services/provider-auth/pi-ai.ts";
import type {
  CompleteLoginInput,
  CompleteLoginOutcome,
  OauthVendor,
  ProviderAuth,
} from "../../services/provider-auth/index.ts";
import type { ModelCatalog } from "../../services/model-catalog/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { createFakeModelCatalog } from "../../../test/helpers/model-catalog.ts";
import { catalogModel } from "../../../test/helpers/model-catalog.ts";
import {
  createMigratedStorage,
  tableBytes,
} from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createFakeProviderAuth } from "../../../test/helpers/provider-auth.ts";
import { assertSerializedSecretsAbsent } from "../../../test/helpers/secret-absence.ts";
import { eventPayloads } from "../../http/contract/event-payload.ts";
import { parsePayload, projectPayload } from "../../domain/provider-payload.ts";
import { completeProviderLogin } from "./complete-provider-login.ts";
import type {
  CompleteProviderLoginDependencies,
  CompleteProviderLoginRefusal,
} from "./complete-provider-login.ts";
import { CompleteProviderLoginError } from "./complete-provider-login.ts";

const NOW = 1_700_000_000_000;
const INSTANCE_ID = "daemon_current";
const OTHER_INSTANCE_ID = "daemon_previous";
const LOGIN_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const SECOND_LOGIN_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const LOGIN_ID = `login_${LOGIN_ULID}`;
const SECOND_LOGIN_ID = `login_${SECOND_LOGIN_ULID}`;
const PROVIDER = "openai-codex";
const LOGIN_EXPIRES_AT = NOW + 600_000;
const LOGIN_CREDENTIAL: Readonly<Record<string, unknown>> = {
  type: "oauth",
  access: "at-1",
  refresh: "rt-1",
  expires: LOGIN_EXPIRES_AT,
};
const VENDOR: OauthVendor = {
  id: PROVIDER,
  label: "OpenAI Codex",
  isSubscription: true,
};

const crypto: Crypto = new AesGcmCrypto({
  key: Buffer.alloc(32, 7),
  keyVersion: 1,
});

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
  completes: CompleteLoginInput[];
  aborts: string[];
}>;

function createAuth(
  completeLogin: (
    input: CompleteLoginInput,
  ) => CompleteLoginOutcome | Promise<CompleteLoginOutcome>,
  vendors: readonly OauthVendor[] = [VENDOR],
): AuthFixture {
  const completes: CompleteLoginInput[] = [];
  const aborts: string[] = [];
  const auth = createFakeProviderAuth({
    oauthVendors: () => vendors,
    completeLogin: async (input) => {
      completes.push(input);
      return completeLogin(input);
    },
    abortLogin: (loginId) => {
      aborts.push(loginId);
    },
  });
  return { auth, completes, aborts };
}

function createDependencies(
  storage: Storage,
  providerAuth: ProviderAuth,
  clock: Clock,
  catalog: ModelCatalog = catalogFor(["catalog-model"]),
  instanceId = INSTANCE_ID,
): CompleteProviderLoginDependencies {
  return { storage, providerAuth, crypto, catalog, clock, instanceId };
}

function catalogFor(modelIds: readonly string[]): ModelCatalog {
  return createFakeModelCatalog({
    providers: [
      {
        id: PROVIDER,
        name: "OpenAI Codex",
        baseUrl: null,
        requiresBaseUrl: false,
        oauth: { label: "OpenAI (ChatGPT Plus/Pro)" },
        models: modelIds.map((id) => catalogModel(id)),
      },
    ],
  });
}

function countLogins(storage: Storage): number {
  const row = storage.transact((transaction) =>
    transaction.get("SELECT COUNT(*) AS count FROM provider_login"),
  ) as { count: number };
  return row.count;
}

function readLogin(storage: Storage, id = LOGIN_ID): LoginReadback | undefined {
  return storage.transact((transaction) =>
    transaction.get(
      "SELECT id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at FROM provider_login WHERE id = ?",
      [id],
    ),
  ) as LoginReadback | undefined;
}

function insertPending(
  storage: Storage,
  input: Readonly<{
    id?: string;
    provider?: string;
    method?: "manual-code" | "device-code";
    instanceId?: string;
    createdAt?: number;
    expiresAt?: number;
  }> = {},
): void {
  storage.transact((transaction) =>
    transaction.run(
      "INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)",
      [
        input.id ?? LOGIN_ID,
        input.provider ?? PROVIDER,
        input.method ?? "device-code",
        input.instanceId ?? INSTANCE_ID,
        input.createdAt ?? NOW,
        input.expiresAt ?? LOGIN_EXPIRES_AT,
      ],
    ),
  );
}

function insertCompleted(
  storage: Storage,
  input: Readonly<{
    id?: string;
    provider?: string;
    method?: "manual-code" | "device-code";
    instanceId?: string;
    createdAt?: number;
    expiresAt?: number;
    credential?: Readonly<Record<string, unknown>>;
    models?: readonly string[];
  }> = {},
): void {
  const credential = input.credential ?? LOGIN_CREDENTIAL;
  const models = input.models ?? ["catalog-model"];
  const sealed = crypto.seal(JSON.stringify({ credential, models }));
  storage.transact((transaction) =>
    transaction.run(
      "INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)",
      [
        input.id ?? LOGIN_ID,
        input.provider ?? PROVIDER,
        input.method ?? "device-code",
        input.instanceId ?? INSTANCE_ID,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        input.createdAt ?? NOW,
        input.expiresAt ?? LOGIN_EXPIRES_AT,
      ],
    ),
  );
}

type Deferred = Readonly<{ promise: Promise<void>; release(): void }>;

function createDeferred(): Deferred {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
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

function completedOutcome(
  models: readonly string[] | null = null,
): CompleteLoginOutcome {
  return {
    status: "completed",
    login: {
      credential: LOGIN_CREDENTIAL,
      availableModelIds: models,
    },
  };
}

function assertCompleteRefusal(
  operation: () => Promise<unknown>,
  refusal: CompleteProviderLoginRefusal,
): Promise<CompleteProviderLoginError> {
  let captured: CompleteProviderLoginError | undefined;
  return assert
    .rejects(operation, (error: unknown) => {
      if (!(error instanceof CompleteProviderLoginError)) return false;
      captured = error;
      assert.equal(error.refusal, refusal);
      return true;
    })
    .then(() => {
      assert.ok(captured !== undefined);
      return captured;
    });
}

describe("src/commands/provider/complete-provider-login.test", () => {
  it("answers not-found for an unknown loginId", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const fixture = createAuth(async () => {
      throw new Error("completeLogin must not be called");
    });

    await assertCompleteRefusal(
      () =>
        completeProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockClock({ start: NOW }),
          ),
          { loginId: LOGIN_ID },
        ),
      "not-found",
    );
    assert.equal(fixture.completes.length, 0);
  });

  it("completes a pending device login and stores the credential", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    const fixture = createAuth(async () => completedOutcome());

    const result = await completeProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockClock({ start: NOW }),
        catalogFor(["catalog-model"]),
      ),
      { loginId: LOGIN_ID },
    );

    assert.deepEqual(result, {
      loginId: LOGIN_ID,
      models: ["catalog-model"],
    });
    assert.equal(countLogins(temporary.storage), 1);
    const row = readLogin(temporary.storage);
    assert.ok(row !== undefined);
    assert.equal(row.state, "completed");
    assert.ok(row.payload_ciphertext !== null);
    assert.ok(row.payload_iv !== null);
    assert.ok(row.payload_tag !== null);
    assert.ok(row.key_version !== null);
    const opened = crypto.open({
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      tag: row.payload_tag,
      keyVersion: row.key_version,
    });
    assert.equal(
      opened,
      JSON.stringify({
        credential: LOGIN_CREDENTIAL,
        models: ["catalog-model"],
      }),
    );
    const raw = tableBytes(temporary.storage, "provider_login").toString(
      "utf8",
    );
    assert.equal(raw.includes("at-1"), false);
    assert.equal(raw.includes("rt-1"), false);
  });

  it("keeps every OAuth fixture secret out of serialized public outputs", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    const credential = {
      ...LOGIN_CREDENTIAL,
      verifier: "pkce-verifier-1",
    };
    const fixture = createAuth(async () => ({
      status: "completed",
      login: { credential, availableModelIds: ["catalog-model"] },
    }));
    const response = await completeProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockClock({ start: NOW }),
      ),
      { loginId: LOGIN_ID },
    );
    const projection = projectPayload(
      "llm",
      parsePayload("llm", {
        transport: "oauth",
        provider: PROVIDER,
        credential,
        defaultModel: "catalog-model",
      }),
    );
    const eventPayload = eventPayloads["provider.credentialRefreshed"].parse({
      name: "Codex subscription",
      kind: "llm",
      refreshedAt: NOW,
    });
    const failingOauth = {
      name: "Fixture OAuth",
      login: async () => {
        throw new Error("vendor rejected at-1, rt-1, and pkce-verifier-1");
      },
      refresh: async (current: unknown) => current,
      toAuth: async () => ({ type: "api_key", key: "" }),
    } as OAuthAuth;
    const auth = new PiAiProviderAuth(fetch, {
      resolveOauth: () => failingOauth,
      clock: createMockClock({ start: NOW }),
    });
    let loginError: LoginError | undefined;
    await assert.rejects(
      () =>
        auth.startLogin({
          loginId: SECOND_LOGIN_ID,
          vendorId: PROVIDER,
          answers: {},
        }),
      (error: unknown) => {
        if (!(error instanceof LoginError)) return false;
        loginError = error;
        return true;
      },
    );
    assert.ok(loginError !== undefined);
    const errorDetails = {
      message: loginError.message,
      refusal: loginError.refusal,
      detail: loginError.detail,
    };
    const secrets = ["at-1", "rt-1", "pkce-verifier-1"];
    const publicOutputs = [response, projection, eventPayload, errorDetails];

    assertSerializedSecretsAbsent(publicOutputs, secrets);
    assert.throws(
      () =>
        assertSerializedSecretsAbsent(
          [...publicOutputs, { leaked: secrets[0] }],
          secrets,
        ),
      /serialized output contains fixture secret at-1/,
    );
  });

  it("refuses login-pending while the flow still polls and leaves the row pending", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    let calls = 0;
    const fixture = createAuth(async () => {
      calls++;
      return calls === 1 ? { status: "pending" } : completedOutcome();
    });
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      createMockClock({ start: NOW }),
    );

    await assertCompleteRefusal(
      () => completeProviderLogin(dependencies, { loginId: LOGIN_ID }),
      "login-pending",
    );
    assert.equal(readLogin(temporary.storage)?.state, "pending");

    const result = await completeProviderLogin(dependencies, {
      loginId: LOGIN_ID,
    });
    assert.deepEqual(result, {
      loginId: LOGIN_ID,
      models: ["catalog-model"],
    });
    assert.equal(readLogin(temporary.storage)?.state, "completed");
  });

  it("refuses code-not-accepted for a code on the device arm", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, { method: "device-code" });
    const fixture = createAuth(async () => {
      throw new Error("completeLogin must not be called");
    });
    const before = tableBytes(temporary.storage, "provider_login");

    await assertCompleteRefusal(
      () =>
        completeProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockClock({ start: NOW }),
          ),
          { loginId: LOGIN_ID, code: "abc-123" },
        ),
      "code-not-accepted",
    );
    assert.equal(fixture.completes.length, 0);
    assert.equal(
      tableBytes(temporary.storage, "provider_login").equals(before),
      true,
    );
  });

  it("refuses code-required for an absent code on a suspended manual arm", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, { method: "manual-code" });
    const fixture = createAuth(async () => {
      throw new LoginError("code-required", "paste a code");
    });

    await assertCompleteRefusal(
      () =>
        completeProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockClock({ start: NOW }),
          ),
          { loginId: LOGIN_ID },
        ),
      "code-required",
    );
    assert.equal(readLogin(temporary.storage)?.state, "pending");
  });

  it("completes a manual login the callback already resolved, with no code", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, { method: "manual-code" });
    const fixture = createAuth(async () => completedOutcome());

    const result = await completeProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockClock({ start: NOW }),
      ),
      { loginId: LOGIN_ID },
    );

    assert.deepEqual(result, {
      loginId: LOGIN_ID,
      models: ["catalog-model"],
    });
    assert.deepEqual(fixture.completes, [{ loginId: LOGIN_ID }]);
    assert.equal(readLogin(temporary.storage)?.state, "completed");
  });

  it("passes the exact pasted code to the service", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, { method: "manual-code" });
    const fixture = createAuth(async () => completedOutcome());

    await completeProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockClock({ start: NOW }),
      ),
      { loginId: LOGIN_ID, code: "abc-123" },
    );

    assert.deepEqual(fixture.completes, [
      { loginId: LOGIN_ID, code: "abc-123" },
    ]);
  });

  it("prefers the model ids the login returned", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    const fixture = createAuth(async () =>
      completedOutcome(["gpt-5-codex", "gpt-5"]),
    );
    let consulted = 0;
    const catalog: ModelCatalog = {
      providers() {
        consulted++;
        throw new Error("catalog must not be consulted");
      },
      has() {
        return true;
      },
      inspect: async () => [],
    };

    const result = await completeProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockClock({ start: NOW }),
        catalog,
      ),
      { loginId: LOGIN_ID },
    );

    assert.deepEqual(result.models, ["gpt-5-codex", "gpt-5"]);
    assert.equal(consulted, 0);
  });

  it("falls back to the catalogue model ids", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    const fixture = createAuth(async () => completedOutcome(null));

    const result = await completeProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockClock({ start: NOW }),
        catalogFor(["catalog-a", "catalog-b"]),
      ),
      { loginId: LOGIN_ID },
    );

    assert.deepEqual(result.models, ["catalog-a", "catalog-b"]);
  });

  it("replays a completed login byte-identically", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompleted(temporary.storage, {
      models: ["stored-a", "stored-b"],
    });
    const fixture = createAuth(async () => {
      throw new Error("completeLogin must not be called for a replay");
    });
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      createMockClock({ start: NOW }),
    );
    const before = tableBytes(temporary.storage, "provider_login");

    const first = await completeProviderLogin(dependencies, {
      loginId: LOGIN_ID,
    });
    const second = await completeProviderLogin(dependencies, {
      loginId: LOGIN_ID,
    });
    const third = await completeProviderLogin(dependencies, {
      loginId: LOGIN_ID,
    });

    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.deepEqual(first, {
      loginId: LOGIN_ID,
      models: ["stored-a", "stored-b"],
    });
    assert.equal(fixture.completes.length, 0);
    assert.equal(
      tableBytes(temporary.storage, "provider_login").equals(before),
      true,
    );
  });

  it("ignores a code supplied on a replay", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompleted(temporary.storage, { models: ["stored-model"] });
    const fixture = createAuth(async () => {
      throw new Error("completeLogin must not be called for a replay");
    });
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      createMockClock({ start: NOW }),
    );
    const before = tableBytes(temporary.storage, "provider_login");

    const result = await completeProviderLogin(dependencies, {
      loginId: LOGIN_ID,
      code: "ignored-code",
    });

    assert.deepEqual(result, {
      loginId: LOGIN_ID,
      models: ["stored-model"],
    });
    assert.equal(fixture.completes.length, 0);
    assert.equal(
      tableBytes(temporary.storage, "provider_login").equals(before),
      true,
    );
  });

  it("refuses login-expired on the first call after the deadline and not-found after", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, { expiresAt: LOGIN_EXPIRES_AT });
    const fixture = createAuth(async () => completedOutcome());
    const clock = mutableClock(LOGIN_EXPIRES_AT - 1);
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      clock,
    );

    const beforeDeadline = await completeProviderLogin(dependencies, {
      loginId: LOGIN_ID,
    });
    assert.deepEqual(beforeDeadline, {
      loginId: LOGIN_ID,
      models: ["catalog-model"],
    });

    clock.set(LOGIN_EXPIRES_AT);
    await assertCompleteRefusal(
      () => completeProviderLogin(dependencies, { loginId: LOGIN_ID }),
      "login-expired",
    );
    assert.equal(countLogins(temporary.storage), 0);
    assert.deepEqual(fixture.aborts, [LOGIN_ID]);
    await assertCompleteRefusal(
      () => completeProviderLogin(dependencies, { loginId: LOGIN_ID }),
      "not-found",
    );
  });

  it("refuses login-lost when the stored instance is not the running one", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, { instanceId: OTHER_INSTANCE_ID });
    const fixture = createAuth(async () => {
      throw new Error("completeLogin must not be called for a lost flow");
    });

    await assertCompleteRefusal(
      () =>
        completeProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockClock({ start: NOW }),
          ),
          { loginId: LOGIN_ID },
        ),
      "login-lost",
    );
    assert.equal(countLogins(temporary.storage), 0);
    assert.deepEqual(fixture.aborts, [LOGIN_ID]);
  });

  it("refuses login-lost when the service has forgotten the flow", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    const fixture = createAuth(async () => ({ status: "lost" }));

    await assertCompleteRefusal(
      () =>
        completeProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            createMockClock({ start: NOW }),
          ),
          { loginId: LOGIN_ID },
        ),
      "login-lost",
    );
    assert.equal(countLogins(temporary.storage), 1);
    assert.equal(readLogin(temporary.storage)?.state, "pending");
    assert.deepEqual(fixture.aborts, []);
  });

  it("a successful complete leaves exactly one row in state completed", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    const fixture = createAuth(async () => completedOutcome());

    await completeProviderLogin(
      createDependencies(
        temporary.storage,
        fixture.auth,
        createMockClock({ start: NOW }),
      ),
      { loginId: LOGIN_ID },
    );

    assert.equal(countLogins(temporary.storage), 1);
    assert.equal(readLogin(temporary.storage)?.state, "completed");
  });

  it("the expired teardown survives the refusal", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage, { expiresAt: NOW });
    const fixture = createAuth(async () => completedOutcome());

    await assertCompleteRefusal(
      () =>
        completeProviderLogin(
          createDependencies(
            temporary.storage,
            fixture.auth,
            mutableClock(NOW),
          ),
          { loginId: LOGIN_ID },
        ),
      "login-expired",
    );
    assert.equal(countLogins(temporary.storage), 0);
  });

  it("expires a completed row on the same rule", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompleted(temporary.storage, { expiresAt: NOW });
    const fixture = createAuth(async () => {
      throw new Error("completeLogin must not be called for an expired replay");
    });
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      mutableClock(NOW),
    );

    await assertCompleteRefusal(
      () => completeProviderLogin(dependencies, { loginId: LOGIN_ID }),
      "login-expired",
    );
    assert.equal(countLogins(temporary.storage), 0);
    await assertCompleteRefusal(
      () => completeProviderLogin(dependencies, { loginId: LOGIN_ID }),
      "not-found",
    );
  });

  it("returns the winner's stored result to a concurrent loser", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    const winnerGate = createDeferred();
    const loserGate = createDeferred();
    let started = 0;
    const fixture = createAuth(async (): Promise<CompleteLoginOutcome> => {
      started++;
      if (started === 1) {
        await winnerGate.promise;
        return completedOutcome(["gpt-5-codex", "gpt-5"]);
      }
      await loserGate.promise;
      return { status: "lost" };
    });
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      createMockClock({ start: NOW }),
    );

    const winner = completeProviderLogin(dependencies, { loginId: LOGIN_ID });
    const loser = completeProviderLogin(dependencies, { loginId: LOGIN_ID });
    assert.equal(fixture.completes.length, 2);

    winnerGate.release();
    const winnerResult = await winner;
    assert.deepEqual(winnerResult, {
      loginId: LOGIN_ID,
      models: ["gpt-5-codex", "gpt-5"],
    });
    const sealed = readLogin(temporary.storage);
    assert.ok(sealed !== undefined);
    assert.ok(sealed.payload_ciphertext !== null);
    const winnerCiphertext = Buffer.from(sealed.payload_ciphertext);

    loserGate.release();
    const loserResult = await loser;

    assert.deepEqual(loserResult, {
      loginId: LOGIN_ID,
      models: ["gpt-5-codex", "gpt-5"],
    });
    assert.equal(countLogins(temporary.storage), 1);
    const survivor = readLogin(temporary.storage);
    assert.ok(survivor !== undefined);
    assert.equal(survivor.state, "completed");
    assert.ok(survivor.payload_ciphertext !== null);
    assert.equal(
      Buffer.from(survivor.payload_ciphertext).equals(winnerCiphertext),
      true,
    );
    assert.equal(fixture.completes.length, 2);
    assert.deepEqual(fixture.aborts, []);
  });

  it("leaves the pending row intact when the concurrent loser resolves first", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPending(temporary.storage);
    const winnerGate = createDeferred();
    const loserGate = createDeferred();
    let started = 0;
    const fixture = createAuth(async (): Promise<CompleteLoginOutcome> => {
      started++;
      if (started === 1) {
        await winnerGate.promise;
        return completedOutcome(["gpt-5-codex", "gpt-5"]);
      }
      await loserGate.promise;
      return { status: "lost" };
    });
    const dependencies = createDependencies(
      temporary.storage,
      fixture.auth,
      createMockClock({ start: NOW }),
    );

    const winner = completeProviderLogin(dependencies, { loginId: LOGIN_ID });
    const loser = completeProviderLogin(dependencies, { loginId: LOGIN_ID });
    assert.equal(fixture.completes.length, 2);

    loserGate.release();
    await assertCompleteRefusal(() => loser, "login-lost");

    assert.equal(countLogins(temporary.storage), 1);
    const pending = readLogin(temporary.storage);
    assert.ok(pending !== undefined);
    assert.equal(pending.state, "pending");
    assert.equal(pending.payload_ciphertext, null);

    winnerGate.release();
    const winnerResult = await winner;
    assert.deepEqual(winnerResult, {
      loginId: LOGIN_ID,
      models: ["gpt-5-codex", "gpt-5"],
    });

    const replay = await completeProviderLogin(dependencies, {
      loginId: LOGIN_ID,
    });
    assert.deepEqual(replay, {
      loginId: LOGIN_ID,
      models: ["gpt-5-codex", "gpt-5"],
    });
    assert.equal(fixture.completes.length, 2);
    assert.deepEqual(fixture.aborts, []);
  });
});
