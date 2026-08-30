import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import {
  CompleteProviderLoginError,
  type CompleteProviderLoginInput,
  type CompleteProviderLoginResult,
} from "../../../commands/provider/complete-provider-login.ts";
import { completeProviderLoginHandler } from "./complete-provider-login.ts";

const loginId = "login_01HZY8QF3M4N5P6R7S8T9V0W1X";
const result: CompleteProviderLoginResult = {
  loginId,
  models: ["gpt-5-codex", "gpt-4o"],
};

describe("src/http/server/credential/complete-provider-login.test", () => {
  it("POST /v1/provider/login/complete answers 200 with the models", async () => {
    let called: CompleteProviderLoginInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.loginComplete": completeProviderLoginHandler({
          completeProviderLogin: async (input) => {
            called = input;
            return result;
          },
        }),
      },
    });

    const response = await app
      .post("/v1/provider/login/complete")
      .send({ loginId });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, result);
    assert.deepEqual(called, { loginId });
  });

  it("omits code when the body omits it", async () => {
    let called: CompleteProviderLoginInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.loginComplete": completeProviderLoginHandler({
          completeProviderLogin: async (input) => {
            called = input;
            return result;
          },
        }),
      },
    });

    await app.post("/v1/provider/login/complete").send({ loginId });

    assert.ok(called !== undefined);
    assert.equal("code" in called, false);
  });

  it("passes the exact code when the body carries it", async () => {
    let called: CompleteProviderLoginInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.loginComplete": completeProviderLoginHandler({
          completeProviderLogin: async (input) => {
            called = input;
            return result;
          },
        }),
      },
    });

    await app.post("/v1/provider/login/complete").send({
      loginId,
      code: "manual-code-fixture",
    });

    assert.deepEqual(called, {
      loginId,
      code: "manual-code-fixture",
    });
  });

  it("maps not-found to 404", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.loginComplete": completeProviderLoginHandler({
          completeProviderLogin: async () => {
            throw new CompleteProviderLoginError(
              "not-found",
              `no provider login ${loginId}`,
            );
          },
        }),
      },
    });

    const response = await app
      .post("/v1/provider/login/complete")
      .send({ loginId });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("maps login-pending to 400 invalid-request with the refusal", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.loginComplete": completeProviderLoginHandler({
          completeProviderLogin: async () => {
            throw new CompleteProviderLoginError(
              "login-pending",
              "the provider login is still pending",
            );
          },
        }),
      },
    });

    const response = await app
      .post("/v1/provider/login/complete")
      .send({ loginId });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "login-pending");
  });

  it("maps code-not-accepted, code-required, login-expired and login-lost to 400", async () => {
    const refusals = [
      "code-not-accepted",
      "code-required",
      "login-expired",
      "login-lost",
    ] as const;

    for (const refusal of refusals) {
      const app = await createTestApp({
        handlers: {
          "provider.loginComplete": completeProviderLoginHandler({
            completeProviderLogin: async () => {
              throw new CompleteProviderLoginError(
                refusal,
                `login refused: ${refusal}`,
              );
            },
          }),
        },
      });

      const response = await app
        .post("/v1/provider/login/complete")
        .send({ loginId });

      assert.equal(response.status, 400, refusal);
      assert.equal(response.body.error.code, "invalid-request", refusal);
      assert.equal(response.body.error.details.refusal, refusal);
    }
  });
});
