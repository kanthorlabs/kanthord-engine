import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { serializePayload } from "../../../domain/provider-payload.ts";
import { registerProvider } from "../../../commands/provider/register-provider.ts";
import { AesGcmCrypto } from "../../../services/crypto/aes-gcm.ts";
import type {
  ProbeOutcome,
  ProviderAuth,
  ProviderAuthRow,
} from "../../../services/provider-auth/index.ts";
import { SqliteEventLog } from "../../../services/event/sqlite.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import { createFakeModelCatalog } from "../../../../test/helpers/model-catalog.ts";
import { createTestApp } from "../../../../test/helpers/app.ts";
import { VerifyProviderError } from "../../../queries/provider/verify-provider.ts";
import {
  verifyProvider,
  type VerifyProviderInput,
} from "../../../queries/provider/verify-provider.ts";
import { verifyProviderHandler } from "./verify-provider.ts";

const id = "provider_01HZY8QF3M4N5P6R7S8T9V0W1X";

const successResult = {
  checkedAt: 1_700_000_000_000,
  model: "gpt-4o",
  reachability: "reachable" as const,
  authentication: "accepted" as const,
  completed: true,
  refusal: null,
};

describe("src/http/server/credential/verify-provider.test", () => {
  it("POST /v1/provider/<id>/verify answers 200 with the verdict and passes the parsed id and signal", async () => {
    let called: VerifyProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.verify": verifyProviderHandler({
          verifyProvider: (input) => {
            called = input;
            return Promise.resolve(successResult);
          },
        }),
      },
    });
    const response = await app.post(`/v1/provider/${id}/verify`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, successResult);
    assert.ok(called !== undefined);
    assert.equal(called.id, id);
    assert.ok(called.signal instanceof AbortSignal);
    assert.equal(called.signal.aborted, false);
  });

  it("VerifyProviderError not-found answers 404 not-found", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.verify": verifyProviderHandler({
          verifyProvider: () =>
            Promise.reject(
              new VerifyProviderError("not-found", `no provider ${id}`),
            ),
        }),
      },
    });
    const response = await app.post(`/v1/provider/${id}/verify`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("VerifyProviderError provider-not-verifiable answers 400 invalid-request", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.verify": verifyProviderHandler({
          verifyProvider: () =>
            Promise.reject(
              new VerifyProviderError("provider-not-verifiable", "kind=git"),
            ),
        }),
      },
    });
    const response = await app.post(`/v1/provider/${id}/verify`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("VerifyProviderError service-unavailable answers 503 service-unavailable", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.verify": verifyProviderHandler({
          verifyProvider: () =>
            Promise.reject(
              new VerifyProviderError("service-unavailable", "cannot decrypt"),
            ),
        }),
      },
    });
    const response = await app.post(`/v1/provider/${id}/verify`);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "service-unavailable");
  });

  it("provider.verify replays a keyed verdict, and no key or a new key probes the rotated credential", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const crypto = new AesGcmCrypto({
      key: Buffer.alloc(32, 7),
      keyVersion: 1,
    });
    const ids = createMockIdGenerator({
      ulids: [
        "01HZY8QF3M4N5P6R7S8T9V0W1X",
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
      ],
    });
    const provider = registerProvider(
      {
        storage: temporary.storage,
        crypto,
        ids,
        clock: createMockClock({ start: 1_700_000_000_000 }),
        events: new SqliteEventLog({ storage: temporary.storage, ids }),
        catalog: createFakeModelCatalog(),
      },
      {
        name: "openai-provider",
        kind: "llm",
        payload: {
          provider: "openai",
          apiKey: "sk-old-key",
          defaultModel: "gpt-4o",
          baseUrl: null,
        },
        actor: "test",
      },
    );
    const rejectedResult: ProbeOutcome = {
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 401",
    };
    const rotatedResult: ProbeOutcome = {
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "accepted",
      completed: true,
      refusal: null,
    };
    const probes: ProviderAuthRow[] = [];
    const providerAuth: ProviderAuth = {
      async probe(row, _signal) {
        probes.push(row);
        return row.apiKey === "sk-old-key" ? rejectedResult : rotatedResult;
      },
    };
    const queryClock = createMockClock({ start: 1_700_000_000_000 });
    const app = await createTestApp({
      handlers: {
        "provider.verify": verifyProviderHandler({
          verifyProvider: (input) =>
            verifyProvider(
              {
                storage: temporary.storage,
                crypto,
                providerAuth,
                clock: queryClock,
              },
              input,
            ),
        }),
      },
    });
    const path = `/v1/provider/${provider.id}/verify`;

    const first = await app.post(path).set("Idempotency-Key", "verify-same");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      checkedAt: 1_700_000_000_000,
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 401",
    });
    assert.equal(probes.length, 1);

    const repeated = await app.post(path).set("Idempotency-Key", "verify-same");
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body, first.body);
    assert.equal(probes.length, 1);

    const rotated = crypto.seal(
      serializePayload("llm", {
        provider: "openai",
        apiKey: "sk-rotated-key",
        defaultModel: "gpt-4o",
        baseUrl: null,
      }),
    );
    temporary.storage.transact((transaction) => {
      transaction.run(
        "UPDATE provider SET payload_ciphertext = ?, payload_iv = ?, payload_tag = ?, key_version = ? WHERE id = ?",
        [
          rotated.ciphertext,
          rotated.iv,
          rotated.tag,
          rotated.keyVersion,
          provider.id,
        ],
      );
    });

    const repeatedAfterRotation = await app
      .post(path)
      .set("Idempotency-Key", "verify-same");
    assert.equal(repeatedAfterRotation.status, 200);
    assert.deepEqual(repeatedAfterRotation.body, first.body);
    assert.equal(probes.length, 1);

    const keyless = await app.post(path);
    assert.equal(keyless.status, 200);
    assert.deepEqual(keyless.body, {
      checkedAt: 1_700_000_000_000,
      model: "gpt-4o",
      reachability: "reachable",
      authentication: "accepted",
      completed: true,
      refusal: null,
    });
    assert.equal(probes.length, 2);

    const differentKey = await app
      .post(path)
      .set("Idempotency-Key", "verify-different");
    assert.equal(differentKey.status, 200);
    assert.deepEqual(differentKey.body, keyless.body);
    assert.equal(probes.length, 3);
    assert.deepEqual(
      probes.map((row) => row.apiKey),
      ["sk-old-key", "sk-rotated-key", "sk-rotated-key"],
    );
  });
});
