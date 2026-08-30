import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import {
  StartProviderLoginError,
  type StartProviderLoginInput,
  type StartProviderLoginResult,
} from "../../../commands/provider/start-provider-login.ts";
import { startProviderLoginHandler } from "./start-provider-login.ts";

const challenge: StartProviderLoginResult = {
  loginId: "login_01HZY8QF3M4N5P6R7S8T9V0W1X",
  method: "device-code",
  userCode: "ABCD-EFGH",
  verificationUri: "https://example.test/device",
  expiresAt: 1_700_000_600_000,
  pollIntervalMs: 5_000,
};

const prompt = "GitHub Enterprise URL/domain (blank for github.com)";

describe("src/http/server/credential/start-provider-login.test", () => {
  it("POST /v1/provider/login answers 200 with the device challenge and passes the parsed body", async () => {
    let called: StartProviderLoginInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.loginStart": startProviderLoginHandler({
          startProviderLogin: async (input) => {
            called = input;
            return challenge;
          },
        }),
      },
    });

    const response = await app.post("/v1/provider/login").send({
      provider: "openai-codex",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, challenge);
    assert.deepEqual(called, {
      provider: "openai-codex",
      answers: {},
    });
  });

  it("passes the answers map through unchanged", async () => {
    let called: StartProviderLoginInput | undefined;
    const answers = { [prompt]: "https://github.example.test" };
    const app = await createTestApp({
      handlers: {
        "provider.loginStart": startProviderLoginHandler({
          startProviderLogin: async (input) => {
            called = input;
            return challenge;
          },
        }),
      },
    });

    const response = await app.post("/v1/provider/login").send({
      provider: "github-copilot",
      answers,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(called, {
      provider: "github-copilot",
      answers,
    });
  });

  it("refuses an invalid body with 400 before calling the command", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "provider.loginStart": startProviderLoginHandler({
          startProviderLogin: async () => {
            calls += 1;
            return challenge;
          },
        }),
      },
    });

    const response = await app.post("/v1/provider/login").send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(calls, 0);
  });

  it("maps login-in-progress to 400 invalid-request with the refusal", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.loginStart": startProviderLoginHandler({
          startProviderLogin: async () => {
            throw new StartProviderLoginError(
              "login-in-progress",
              "a login is already in progress",
            );
          },
        }),
      },
    });

    const response = await app.post("/v1/provider/login").send({
      provider: "openai-codex",
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "login-in-progress");
  });

  it("maps login-input-required to 400 and carries the prompt message in details.detail", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.loginStart": startProviderLoginHandler({
          startProviderLogin: async () => {
            throw new StartProviderLoginError(
              "login-input-required",
              "the provider login needs input",
              prompt,
            );
          },
        }),
      },
    });

    const response = await app.post("/v1/provider/login").send({
      provider: "github-copilot",
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "login-input-required");
    assert.equal(response.body.error.details.detail, prompt);
  });

  it("maps provider-not-oauth-capable to 400", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.loginStart": startProviderLoginHandler({
          startProviderLogin: async () => {
            throw new StartProviderLoginError(
              "provider-not-oauth-capable",
              "openai-compatible has no oauth login",
            );
          },
        }),
      },
    });

    const response = await app.post("/v1/provider/login").send({
      provider: "openai-compatible",
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(
      response.body.error.details.refusal,
      "provider-not-oauth-capable",
    );
  });
});
