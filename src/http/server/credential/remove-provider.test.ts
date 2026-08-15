import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { bootstrapActorId } from "../../../domain/actor.ts";
import type { RemoveProviderInput } from "../../../commands/provider/remove-provider.ts";
import type { ProviderRemovalBlocker } from "../../../commands/provider/remove-provider.ts";
import { RemoveProviderError } from "../../../commands/provider/remove-provider.ts";
import { removeProviderHandler } from "./remove-provider.ts";
import { providerRemoveResponse } from "../../contract/credential.ts";

const providerId = "provider_01HZY8QF3M4N5P6R7S8T9V0W1X";

const blockers: readonly ProviderRemovalBlocker[] = [
  { kind: "default-chain" },
  { kind: "project-binding", projectId: "project_p" },
  { kind: "repository", repositoryId: "repository_chain" },
  { kind: "attempt", attemptId: "attempt_chain" },
];

describe("src/http/server/credential/remove-provider.test", () => {
  it("DELETE /v1/provider/<id> answers 200 with the removed id and passes the parsed id and the resolved actor", async () => {
    let called: RemoveProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => {
            called = input;
            return { id: providerId };
          },
        }),
      },
    });
    const response = await app.del(`/v1/provider/${providerId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { id: providerId });
    const parsed = providerRemoveResponse.parse(response.body);
    assert.deepEqual(Object.keys(parsed).sort(), ["id"]);
    assert.throws(() =>
      providerRemoveResponse.parse({ ...response.body, credential: "secret" }),
    );
    assert.deepEqual(called, { id: providerId, actor: bootstrapActorId });
  });

  it("an unknown id refusal answers 404 not-found with the refusal message", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: () => {
            throw new RemoveProviderError(
              "not-found",
              `no provider ${providerId}`,
            );
          },
        }),
      },
    });
    const response = await app.del(`/v1/provider/${providerId}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(response.body.error.message, `no provider ${providerId}`);
  });

  it("a binding-in-use refusal answers 409 with the exact blocker array", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.remove": removeProviderHandler({
          removeProvider: () => {
            throw new RemoveProviderError(
              "binding-in-use",
              `provider ${providerId} is still in use`,
              blockers,
            );
          },
        }),
      },
    });
    const response = await app.del(`/v1/provider/${providerId}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "binding-in-use");
    assert.deepEqual(response.body.error.details.blockers, blockers);
  });
});
