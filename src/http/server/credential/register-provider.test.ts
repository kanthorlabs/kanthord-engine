import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { PayloadError } from "../../../domain/provider-payload.ts";
import { RegisterProviderError } from "../../../commands/provider/register-provider.ts";
import type { RegisterProviderInput } from "../../../commands/provider/register-provider.ts";
import type { ProviderView } from "../../../domain/provider-view.ts";
import { registerProviderHandler } from "./register-provider.ts";
import { providerRegisterResponse } from "../../contract/credential.ts";

const view: ProviderView = {
  id: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
  name: "github-bot",
  kind: "git",
  projection: {
    transport: "http-basic",
    forge: "github",
    username: "kanthord-bot",
  },
  setDefaultAt: null,
  updatedAt: 1700000000000,
};

describe("src/http/server/credential/register-provider.test", () => {
  it("POST /v1/provider with a valid body answers 200 and the view", async () => {
    let called: RegisterProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.register": registerProviderHandler({
          registerProvider: (input) => {
            called = input;
            return view;
          },
          actor: "ulrich",
        }),
      },
    });
    const response = await app.post("/v1/provider").send({
      name: "github-bot",
      kind: "git",
      payload: {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
        token: "ghp_x",
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, view);
    const parsed = providerRegisterResponse.parse(response.body);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "id",
      "kind",
      "name",
      "projection",
      "setDefaultAt",
      "updatedAt",
    ]);
    assert.throws(() =>
      providerRegisterResponse.parse({
        ...response.body,
        credential: "secret",
      }),
    );
    assert.deepEqual(called, {
      name: "github-bot",
      kind: "git",
      payload: {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
        token: "ghp_x",
      },
      actor: "ulrich",
    });
  });

  it("POST /v1/provider with an empty body answers 400 invalid-request and never calls the command", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "provider.register": registerProviderHandler({
          registerProvider: () => {
            calls += 1;
            return view;
          },
          actor: "ulrich",
        }),
      },
    });
    const response = await app.post("/v1/provider").send({});
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(calls, 0);
  });

  it("a malformed JSON body answers 400 invalid-request with the constant message and no internal report", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "provider.register": registerProviderHandler({
          registerProvider: () => {
            calls += 1;
            return view;
          },
          actor: "ulrich",
        }),
      },
    });
    const response = await app
      .post("/v1/provider")
      .set("Content-Type", "application/json")
      .send('{"oops');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(
      response.body.error.message,
      "the request body is not valid json",
    );
    assert.equal(app.internalErrors().length, 0);
    assert.equal(calls, 0);
  });

  it("a PayloadError from the command answers 400 with its refusal in details", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.register": registerProviderHandler({
          registerProvider: () => {
            throw new PayloadError(
              "private-key-encrypted",
              "the private key is encrypted; kanthord runs ssh under BatchMode=yes and cannot supply a passphrase",
              "aes256-ctr",
            );
          },
          actor: "ulrich",
        }),
      },
    });
    const response = await app.post("/v1/provider").send({
      name: "ssh-bot",
      kind: "git",
      payload: {
        transport: "ssh",
        privateKey:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nQUJD\n-----END OPENSSH PRIVATE KEY-----",
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "private-key-encrypted");
  });

  it("a RegisterProviderError from the command answers 400 with name-taken in details", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.register": registerProviderHandler({
          registerProvider: () => {
            throw new RegisterProviderError(
              "name-taken",
              "a provider named github-bot is already registered",
            );
          },
          actor: "ulrich",
        }),
      },
    });
    const response = await app.post("/v1/provider").send({
      name: "github-bot",
      kind: "git",
      payload: {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
        token: "ghp_x",
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "name-taken");
  });
});
