import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import type { ProviderListItem } from "../../../queries/provider/list-provider.ts";
import { showProviderHandler } from "./show-provider.ts";

const view: ProviderListItem = {
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

describe("src/http/server/credential/show-provider.test", () => {
  it("GET /v1/provider/<id> answers 200 with the view and passes the parsed id", async () => {
    let called: unknown = "not-called";
    const app = await createTestApp({
      handlers: {
        "provider.show": showProviderHandler({
          showProvider: (input) => {
            called = input;
            return view;
          },
        }),
      },
    });
    const response = await app.get(
      "/v1/provider/provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, view);
    assert.deepEqual(called, { id: "provider_01HZY8QF3M4N5P6R7S8T9V0W1X" });
  });

  it("GET /v1/provider/<id> with a null result answers 404 not-found naming the id", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.show": showProviderHandler({
          showProvider: () => null,
        }),
      },
    });
    const response = await app.get(
      "/v1/provider/provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    );
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(
      response.body.error.message,
      "no provider provider_01HZY8QF3M4N5P6R7S8T9V0W1X",
    );
  });
});
