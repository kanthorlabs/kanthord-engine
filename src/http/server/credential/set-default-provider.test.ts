import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { bootstrapActorId } from "../../../domain/actor.ts";
import type {
  ProviderDefaultTransfer,
  SetDefaultProviderInput,
} from "../../../commands/provider/set-default-provider.ts";
import { SetDefaultProviderError } from "../../../commands/provider/set-default-provider.ts";
import { setDefaultProviderHandler } from "./set-default-provider.ts";
import { providerSetDefaultResponse } from "../../contract/credential.ts";

const holderId = "provider_01HZY8QF3M4N5P6R7S8T9V0W1Y";
const providerId = "provider_01HZY8QF3M4N5P6R7S8T9V0W1X";

const view: ProviderDefaultTransfer = {
  id: providerId,
  name: "anthropic-bot",
  kind: "llm",
  projection: {
    transport: "api-key",
    provider: "anthropic",
    defaultModel: "claude-opus-5",
    baseUrl: null,
  },
  setDefaultAt: 1700000002000,
  updatedAt: 1700000002000,
  displaced: [{ id: holderId, name: "openai-bot" }],
};

describe("src/http/server/credential/set-default-provider.test", () => {
  it("PUT /v1/provider/<id>/default answers 200 with the view and passes the parsed id and the resolved actor", async () => {
    let called: SetDefaultProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.setDefault": setDefaultProviderHandler({
          setDefaultProvider: (input) => {
            called = input;
            return view;
          },
        }),
      },
    });
    const response = await app.put(`/v1/provider/${providerId}/default`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, view);
    const parsed = providerSetDefaultResponse.parse(response.body);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "displaced",
      "id",
      "kind",
      "name",
      "projection",
      "setDefaultAt",
      "updatedAt",
    ]);
    assert.deepEqual(parsed.displaced, [{ id: holderId, name: "openai-bot" }]);
    assert.throws(() =>
      providerSetDefaultResponse.parse({
        ...response.body,
        credential: "secret",
      }),
    );
    assert.deepEqual(called, { id: providerId, actor: bootstrapActorId });
  });

  it("an unknown id refusal answers 404 not-found with the refusal message", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.setDefault": setDefaultProviderHandler({
          setDefaultProvider: () => {
            throw new SetDefaultProviderError(
              "not-found",
              `no provider ${providerId}`,
            );
          },
        }),
      },
    });
    const response = await app.put(`/v1/provider/${providerId}/default`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(response.body.error.message, `no provider ${providerId}`);
  });

  it("a git refusal answers 400 invalid-request with refusal kind-not-chainable", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.setDefault": setDefaultProviderHandler({
          setDefaultProvider: () => {
            throw new SetDefaultProviderError(
              "kind-not-chainable",
              `provider ${providerId} of kind git cannot join the default chain`,
            );
          },
        }),
      },
    });
    const response = await app.put(`/v1/provider/${providerId}/default`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "kind-not-chainable");
  });
});
