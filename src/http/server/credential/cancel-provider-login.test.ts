import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import {
  CancelProviderLoginError,
  type CancelProviderLoginInput,
} from "../../../commands/provider/cancel-provider-login.ts";
import { cancelProviderLoginHandler } from "./cancel-provider-login.ts";

const loginId = "login_01HZY8QF3M4N5P6R7S8T9V0W1X";

describe("src/http/server/credential/cancel-provider-login.test", () => {
  it("POST /v1/provider/login/cancel answers 204 with no body", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.loginCancel": cancelProviderLoginHandler({
          cancelProviderLogin: async () => undefined,
        }),
      },
    });

    const response = await app
      .post("/v1/provider/login/cancel")
      .send({ loginId });

    assert.equal(response.status, 204);
    assert.equal(response.text, "");
  });

  it("passes the parsed loginId", async () => {
    let called: CancelProviderLoginInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.loginCancel": cancelProviderLoginHandler({
          cancelProviderLogin: async (input) => {
            called = input;
          },
        }),
      },
    });

    await app.post("/v1/provider/login/cancel").send({ loginId });

    assert.deepEqual(called, { loginId });
  });

  it("maps not-found to 404", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.loginCancel": cancelProviderLoginHandler({
          cancelProviderLogin: async () => {
            throw new CancelProviderLoginError(
              "not-found",
              `no provider login ${loginId}`,
            );
          },
        }),
      },
    });

    const response = await app
      .post("/v1/provider/login/cancel")
      .send({ loginId });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("refuses an invalid body with 400", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "provider.loginCancel": cancelProviderLoginHandler({
          cancelProviderLogin: async () => {
            calls += 1;
          },
        }),
      },
    });

    const response = await app
      .post("/v1/provider/login/cancel")
      .send({ loginId: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X" });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(calls, 0);
  });
});
