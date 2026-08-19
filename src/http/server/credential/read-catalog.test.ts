import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { defaultCatalogProviders } from "../../../../test/helpers/model-catalog.ts";
import { readCatalogHandler } from "./read-catalog.ts";

describe("src/http/server/credential/read-catalog.test", () => {
  it("GET /v1/provider-catalog answers 200 with the provider catalog", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "provider.catalog": readCatalogHandler({
          readCatalog: () => {
            calls += 1;
            return { providers: defaultCatalogProviders };
          },
        }),
      },
    });

    const response = await app.get("/v1/provider-catalog");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { providers: defaultCatalogProviders });
    assert.equal(calls, 1);
  });
});
