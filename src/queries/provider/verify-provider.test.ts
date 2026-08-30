import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  serializePayload,
  type LlmOauthPayload,
} from "../../domain/provider-payload.ts";
import type { Clock } from "../../services/clock/index.ts";
import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type {
  ProbeOutcome,
  ProviderAuth,
  ProviderAuthRow,
} from "../../services/provider-auth/index.ts";
import { ProviderAuthError } from "../../services/provider-auth/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import { registerProvider } from "../../commands/provider/register-provider.ts";
import { verifyProvider, VerifyProviderError } from "./verify-provider.ts";
import {
  createMigratedStorage,
  databaseBytes,
} from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { createFakeModelCatalog } from "../../../test/helpers/model-catalog.ts";
import { createFakeProviderAuth } from "../../../test/helpers/provider-auth.ts";

const FIXED_AT = 1_700_000_000_000;
const FIXED_SIGNAL = AbortSignal.timeout(10_000);
const FIXTURE_KEY = "sk-test-key";
const CRYPTO: Crypto = new AesGcmCrypto({
  key: Buffer.alloc(32, 7),
  keyVersion: 1,
});

const PROVIDER_ULIDS = [
  "01HZY8QF3M4N5P6R7S8T9V0W1X",
  "01HZY8QF3M4N5P6R7S8T9V0W1Y",
  "01HZY8QF3M4N5P6R7S8T9V0W1Z",
] as const;

const OAUTH_PROVIDER_ID = "provider_01HZY8QF3M4N5P6R7S8T9V0W20";
const OAUTH_CREDENTIAL = {
  type: "oauth",
  access: "oauth-access",
  refresh: "oauth-refresh",
  expires: FIXED_AT + 600_000,
  availableModelIds: ["gpt-5-codex"],
} as const;

type RecordingProviderAuth = ProviderAuth &
  Readonly<{
    calls: ProviderAuthRow[];
    signals: AbortSignal[];
  }>;

function createProviderAuth(
  outcome: ProbeOutcome | Error,
): RecordingProviderAuth {
  const calls: ProviderAuthRow[] = [];
  const signals: AbortSignal[] = [];
  return {
    calls,
    signals,
    ...createFakeProviderAuth({
      async probe(row, signal) {
        calls.push(row);
        signals.push(signal);
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    }),
  };
}

type RecordingClock = Clock & Readonly<{ calls: number }>;

function createRecordingClock(value = FIXED_AT): RecordingClock {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    now() {
      calls++;
      return value;
    },
  };
}

function registerLlmProvider(storage: Storage): string {
  const ids = createMockIdGenerator({ ulids: PROVIDER_ULIDS });
  return registerProvider(
    {
      storage,
      crypto: CRYPTO,
      ids,
      clock: createMockClock({ start: FIXED_AT }),
      events: new SqliteEventLog({ storage, ids }),
      catalog: createFakeModelCatalog(),
    },
    {
      name: "openai-provider",
      kind: "llm",
      payload: {
        provider: "openai",
        apiKey: FIXTURE_KEY,
        defaultModel: "gpt-4o",
        baseUrl: null,
      },
      actor: "test",
    },
  ).id;
}

function registerGitProvider(storage: Storage): string {
  const ids = createMockIdGenerator({ ulids: PROVIDER_ULIDS });
  return registerProvider(
    {
      storage,
      crypto: CRYPTO,
      ids,
      clock: createMockClock({ start: FIXED_AT }),
      events: new SqliteEventLog({ storage, ids }),
      catalog: createFakeModelCatalog(),
    },
    {
      name: "git-provider",
      kind: "git",
      payload: {
        transport: "http-basic",
        forge: "github",
        username: "test-user",
        token: "ghp-test-token",
      },
      actor: "test",
    },
  ).id;
}

function seedOauthProvider(storage: Storage): string {
  const payload: LlmOauthPayload = {
    transport: "oauth",
    provider: "openai-codex",
    credential: OAUTH_CREDENTIAL,
    defaultModel: "gpt-5-codex",
  };
  const sealed = CRYPTO.seal(serializePayload("llm", payload));
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        OAUTH_PROVIDER_ID,
        "openai-codex",
        "llm",
        null,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        FIXED_AT,
      ],
    );
  });
  return OAUTH_PROVIDER_ID;
}

function successfulOutcome(): ProbeOutcome {
  return {
    model: "gpt-4o",
    reachability: "reachable",
    authentication: "accepted",
    completed: true,
    refusal: null,
  };
}

function outcomeVariants(): readonly ProbeOutcome[] {
  return [
    successfulOutcome(),
    {
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 401",
    },
    {
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "accepted",
      completed: false,
      refusal: "model-unavailable",
      detail: "HTTP 404",
    },
    {
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "accepted",
      completed: false,
      refusal: "quota-exceeded",
      detail: "HTTP 429",
    },
    {
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "unknown",
      completed: false,
      refusal: "endpoint-rejected",
      detail: "HTTP 500",
    },
    {
      model: "gpt-4o",
      reachability: "unreachable",
      authentication: "unknown",
      completed: false,
      refusal: "endpoint-unreachable",
      detail: "transport-error",
    },
  ];
}

type CountingStorage = Storage & Readonly<{ writes: string[] }>;

function countWrites(storage: Storage): CountingStorage {
  const writes: string[] = [];
  return {
    writes,
    transact<T>(work: (transaction: Transaction) => T): T {
      return storage.transact((transaction) =>
        work({
          run(sql, parameters) {
            if (
              /^\s*(?:insert|update|delete|replace|create|drop|alter)/i.test(
                sql,
              )
            ) {
              writes.push(sql);
            }
            return transaction.run(sql, parameters);
          },
          get: (sql, parameters) => transaction.get(sql, parameters),
          all: (sql, parameters) => transaction.all(sql, parameters),
        }),
      );
    },
    migrate: () => storage.migrate(),
    status: () => storage.status(),
    close: () => storage.close(),
    ping: () => storage.ping(),
  };
}

async function assertVerifyRefusal(
  action: () => Promise<unknown>,
  refusal: VerifyProviderError["refusal"],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert(error instanceof VerifyProviderError);
    assert.equal(error.refusal, refusal);
    return true;
  });
}

describe("src/queries/provider/verify-provider", () => {
  it("returns the complete verdict and passes the stored row and signal", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerLlmProvider(temporary.storage);
    const clock = createRecordingClock();
    const order: string[] = [];
    const providerAuth = createProviderAuth(successfulOutcome());
    const originalProbe = providerAuth.probe;
    providerAuth.probe = async (row, signal) => {
      order.push("probe");
      temporary.storage.transact((transaction) => {
        transaction.get("SELECT id FROM provider WHERE id = ?", [id]);
      });
      return originalProbe(row, signal);
    };
    const clockWithOrder: Clock = {
      now() {
        order.push("clock");
        return clock.now();
      },
    };

    const result = await verifyProvider(
      {
        storage: temporary.storage,
        crypto: CRYPTO,
        providerAuth,
        clock: clockWithOrder,
      },
      { id, signal: FIXED_SIGNAL },
    );

    assert.deepEqual(result, {
      checkedAt: FIXED_AT,
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "accepted",
      completed: true,
      refusal: null,
    });
    assert.equal("detail" in result, false);
    assert.deepEqual(providerAuth.calls, [
      {
        providerId: id,
        vendorId: "openai",
        transport: "api-key",
        apiKey: FIXTURE_KEY,
        defaultModel: "gpt-4o",
        baseUrl: null,
      },
    ]);
    assert.strictEqual(providerAuth.signals[0], FIXED_SIGNAL);
    assert.equal(clock.calls, 1);
    assert.deepEqual(order, ["clock", "probe"]);
  });

  it("includes provider-auth detail in the complete result", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerLlmProvider(temporary.storage);
    const result = await verifyProvider(
      {
        storage: temporary.storage,
        crypto: CRYPTO,
        providerAuth: createProviderAuth({
          ...successfulOutcome(),
          authentication: "rejected",
          completed: false,
          refusal: "credential-rejected",
          detail: "HTTP 401",
        }),
        clock: createRecordingClock(),
      },
      { id, signal: FIXED_SIGNAL },
    );

    assert.deepEqual(result, {
      checkedAt: FIXED_AT,
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 401",
    });
  });

  it("returns every provider outcome as a complete verdict body", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerLlmProvider(temporary.storage);
    const cases = [
      [
        successfulOutcome(),
        {
          checkedAt: FIXED_AT,
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "accepted",
          completed: true,
          refusal: null,
        },
      ],
      [
        {
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "rejected",
          completed: false,
          refusal: "credential-rejected",
          detail: "HTTP 401",
        },
        {
          checkedAt: FIXED_AT,
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "rejected",
          completed: false,
          refusal: "credential-rejected",
          detail: "HTTP 401",
        },
      ],
      [
        {
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "accepted",
          completed: false,
          refusal: "model-unavailable",
          detail: "HTTP 404",
        },
        {
          checkedAt: FIXED_AT,
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "accepted",
          completed: false,
          refusal: "model-unavailable",
          detail: "HTTP 404",
        },
      ],
      [
        {
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "accepted",
          completed: false,
          refusal: "quota-exceeded",
          detail: "HTTP 429",
        },
        {
          checkedAt: FIXED_AT,
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "accepted",
          completed: false,
          refusal: "quota-exceeded",
          detail: "HTTP 429",
        },
      ],
      [
        {
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "unknown",
          completed: false,
          refusal: "endpoint-rejected",
          detail: "HTTP 500",
        },
        {
          checkedAt: FIXED_AT,
          model: "gpt-4o",
          reachability: "reachable",
          authentication: "unknown",
          completed: false,
          refusal: "endpoint-rejected",
          detail: "HTTP 500",
        },
      ],
      [
        {
          model: "gpt-4o",
          reachability: "unreachable",
          authentication: "unknown",
          completed: false,
          refusal: "endpoint-unreachable",
          detail: "transport-error",
        },
        {
          checkedAt: FIXED_AT,
          model: "gpt-4o",
          reachability: "unreachable",
          authentication: "unknown",
          completed: false,
          refusal: "endpoint-unreachable",
          detail: "transport-error",
        },
      ],
    ] as const;

    for (const [outcome, expected] of cases) {
      const result = await verifyProvider(
        {
          storage: temporary.storage,
          crypto: CRYPTO,
          providerAuth: createProviderAuth(outcome),
          clock: createRecordingClock(),
        },
        { id, signal: FIXED_SIGNAL },
      );
      assert.deepEqual(result, expected);
    }
  });

  it("refuses an unknown provider id without probing", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const providerAuth = createProviderAuth(successfulOutcome());

    await assertVerifyRefusal(
      () =>
        verifyProvider(
          {
            storage: temporary.storage,
            crypto: CRYPTO,
            providerAuth,
            clock: createRecordingClock(),
          },
          {
            id: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
            signal: FIXED_SIGNAL,
          },
        ),
      "not-found",
    );
    assert.equal(providerAuth.calls.length, 0);
  });

  it("refuses a git provider without probing", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerGitProvider(temporary.storage);
    const providerAuth = createProviderAuth(successfulOutcome());

    await assertVerifyRefusal(
      () =>
        verifyProvider(
          {
            storage: temporary.storage,
            crypto: CRYPTO,
            providerAuth,
            clock: createRecordingClock(),
          },
          { id, signal: FIXED_SIGNAL },
        ),
      "provider-not-verifiable",
    );
    assert.equal(providerAuth.calls.length, 0);
  });

  it("verifies an oauth registration", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = seedOauthProvider(temporary.storage);
    const providerAuth = createProviderAuth({
      ...successfulOutcome(),
      model: "gpt-5-codex",
    });

    const result = await verifyProvider(
      {
        storage: temporary.storage,
        crypto: CRYPTO,
        providerAuth,
        clock: createRecordingClock(),
      },
      { id, signal: FIXED_SIGNAL },
    );

    assert.deepEqual(result, {
      checkedAt: FIXED_AT,
      model: "gpt-5-codex",
      reachability: "reachable",
      authentication: "accepted",
      completed: true,
      refusal: null,
    });
    assert.deepEqual(providerAuth.calls, [
      {
        providerId: id,
        vendorId: "openai-codex",
        defaultModel: "gpt-5-codex",
        baseUrl: null,
        transport: "oauth",
        credential: OAUTH_CREDENTIAL,
      },
    ]);
  });

  it("refuses an undecryptable provider without probing", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerLlmProvider(temporary.storage);
    temporary.storage.transact((transaction) =>
      transaction.run(
        "UPDATE provider SET payload_tag = X'00000000000000000000000000000000' WHERE id = ?",
        [id],
      ),
    );
    const providerAuth = createProviderAuth(successfulOutcome());

    await assertVerifyRefusal(
      () =>
        verifyProvider(
          {
            storage: temporary.storage,
            crypto: CRYPTO,
            providerAuth,
            clock: createRecordingClock(),
          },
          { id, signal: FIXED_SIGNAL },
        ),
      "service-unavailable",
    );
    assert.equal(providerAuth.calls.length, 0);
  });

  it("maps an uncatalogued vendor refusal to provider-not-verifiable", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerLlmProvider(temporary.storage);
    const providerAuth = createProviderAuth(
      new ProviderAuthError(
        "vendor-not-catalogued",
        "vendor is not catalogued",
      ),
    );

    await assertVerifyRefusal(
      () =>
        verifyProvider(
          {
            storage: temporary.storage,
            crypto: CRYPTO,
            providerAuth,
            clock: createRecordingClock(),
          },
          { id, signal: FIXED_SIGNAL },
        ),
      "provider-not-verifiable",
    );
    assert.equal(providerAuth.calls.length, 1);
  });

  it("calls the clock exactly once before a probe failure", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerLlmProvider(temporary.storage);
    const clock = createRecordingClock();
    const providerAuth = createProviderAuth(new Error("probe failed"));

    await assert.rejects(() =>
      verifyProvider(
        { storage: temporary.storage, crypto: CRYPTO, providerAuth, clock },
        { id, signal: FIXED_SIGNAL },
      ),
    );
    assert.equal(clock.calls, 1);
  });

  it("never exposes the stored key in any verdict", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerLlmProvider(temporary.storage);

    for (const outcome of outcomeVariants()) {
      const result = await verifyProvider(
        {
          storage: temporary.storage,
          crypto: CRYPTO,
          providerAuth: createProviderAuth(outcome),
          clock: createRecordingClock(),
        },
        { id, signal: FIXED_SIGNAL },
      );
      assert.equal(JSON.stringify(result).includes(FIXTURE_KEY), false);
    }
  });

  it("does not write any table for any probe outcome", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = registerLlmProvider(temporary.storage);
    const storage = countWrites(temporary.storage);
    for (const [index, outcome] of outcomeVariants().entries()) {
      const before = databaseBytes(temporary.storage);
      await verifyProvider(
        {
          storage,
          crypto: CRYPTO,
          providerAuth: createProviderAuth(outcome),
          clock: createRecordingClock(),
        },
        { id, signal: FIXED_SIGNAL },
      );
      assert.equal(
        Buffer.compare(databaseBytes(temporary.storage), before),
        0,
        `database changed after outcome ${index}`,
      );
    }

    temporary.storage.transact((transaction) =>
      transaction.run(
        "UPDATE provider SET payload_tag = X'00000000000000000000000000000000' WHERE id = ?",
        [id],
      ),
    );
    const beforeDecryptFailure = databaseBytes(temporary.storage);
    const decryptFailureAuth = createProviderAuth(successfulOutcome());
    await assertVerifyRefusal(
      () =>
        verifyProvider(
          {
            storage,
            crypto: CRYPTO,
            providerAuth: decryptFailureAuth,
            clock: createRecordingClock(),
          },
          { id, signal: FIXED_SIGNAL },
        ),
      "service-unavailable",
    );
    assert.equal(
      Buffer.compare(databaseBytes(temporary.storage), beforeDecryptFailure),
      0,
      "database changed after decryption failure",
    );
    assert.equal(decryptFailureAuth.calls.length, 0);
    assert.deepEqual(storage.writes, []);
  });
});
