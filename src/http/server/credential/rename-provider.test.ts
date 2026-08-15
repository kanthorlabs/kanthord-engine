import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { bootstrapActorId } from "../../../domain/actor.ts";
import type { ProviderView } from "../../../domain/provider-view.ts";
import type { RenameProviderInput } from "../../../commands/provider/rename-provider.ts";
import { RenameProviderError } from "../../../commands/provider/rename-provider.ts";
import { renameProviderHandler } from "./rename-provider.ts";
import { providerRenameResponse } from "../../contract/credential.ts";

const providerId = "provider_01HZY8QF3M4N5P6R7S8T9V0W1X";

const view: ProviderView = {
  id: providerId,
  name: "github-release",
  kind: "git",
  projection: {
    transport: "http-basic",
    forge: "github",
    username: "kanthord-bot",
  },
  setDefaultAt: null,
  updatedAt: 1700000001000,
};

describe("src/http/server/credential/rename-provider.test", () => {
  it("POST /v1/provider/<id>/rename with a valid body answers 200 with the view and passes the parsed id, name and the resolved actor", async () => {
    let called: RenameProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.rename": renameProviderHandler({
          renameProvider: (input) => {
            called = input;
            return view;
          },
        }),
      },
    });
    const response = await app
      .post(`/v1/provider/${providerId}/rename`)
      .send({ name: "github-release" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, view);
    const parsed = providerRenameResponse.parse(response.body);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "id",
      "kind",
      "name",
      "projection",
      "setDefaultAt",
      "updatedAt",
    ]);
    assert.throws(() =>
      providerRenameResponse.parse({ ...response.body, credential: "secret" }),
    );
    assert.deepEqual(called, {
      id: providerId,
      name: "github-release",
      actor: bootstrapActorId,
    });
  });

  it("an unknown id refusal answers 404 not-found with the refusal message", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.rename": renameProviderHandler({
          renameProvider: () => {
            throw new RenameProviderError(
              "not-found",
              `no provider ${providerId}`,
            );
          },
        }),
      },
    });
    const response = await app
      .post(`/v1/provider/${providerId}/rename`)
      .send({ name: "github-release" });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(response.body.error.message, `no provider ${providerId}`);
  });

  it("a name-taken refusal answers 400 invalid-request with refusal name-taken", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.rename": renameProviderHandler({
          renameProvider: () => {
            throw new RenameProviderError(
              "name-taken",
              "a provider named github-bot is already registered",
            );
          },
        }),
      },
    });
    const response = await app
      .post(`/v1/provider/${providerId}/rename`)
      .send({ name: "github-bot" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "name-taken");
  });

  it("an empty body answers 400 invalid-request with the constant message and zero command calls", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "provider.rename": renameProviderHandler({
          renameProvider: () => {
            calls += 1;
            return view;
          },
        }),
      },
    });
    const response = await app
      .post(`/v1/provider/${providerId}/rename`)
      .send({});
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(
      response.body.error.message,
      "the provider rename body is invalid",
    );
    assert.equal(calls, 0);
  });

  it("regression: the handler parses the body with the exported providerRenameRequest contract schema, not a local duplicate", () => {
    const source = readFileSync(
      new URL("./rename-provider.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      /import\s*\{[^}]*\bproviderRenameRequest\b[^}]*\}\s*from\s*"\.\.\/\.\.\/contract\/credential\.ts"/.test(
        source,
      ),
      true,
    );
    assert.equal(/providerRenameRequest\s*=/.test(source), false);
    assert.equal(source.includes('from "zod"'), false);
  });
});
