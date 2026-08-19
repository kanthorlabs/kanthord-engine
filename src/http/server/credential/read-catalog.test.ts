import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { defaultCatalogProviders } from "../../../../test/helpers/model-catalog.ts";
import type { ReadCatalogInput } from "../../../queries/provider/read-catalog.ts";
import { readCatalogHandler } from "./read-catalog.ts";

describe("src/http/server/credential/read-catalog.test", () => {
  it("GET /v1/provider-catalog answers 200 with the provider catalog", async () => {
    let called: ReadCatalogInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.catalog": readCatalogHandler({
          readCatalog: (input) => {
            called = input;
            return { providers: defaultCatalogProviders };
          },
        }),
      },
    });

    const response = await app.get("/v1/provider-catalog");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { providers: defaultCatalogProviders });
    assert.deepEqual(called, {});
  });

  it("passes the provider filter through to the query", async () => {
    let called: ReadCatalogInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.catalog": readCatalogHandler({
          readCatalog: (input) => {
            called = input;
            return { providers: [] };
          },
        }),
      },
    });

    const response = await app.get("/v1/provider-catalog?provider=openai");

    assert.equal(response.status, 200);
    assert.deepEqual(called, { provider: "openai" });
  });

  it("answers 400 when the provider filter is empty", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.catalog": readCatalogHandler({
          readCatalog: () => {
            throw new Error("the query must not run");
          },
        }),
      },
    });

    const response = await app.get("/v1/provider-catalog?provider=");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("answers 400 when the filter carries an unknown key", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.catalog": readCatalogHandler({
          readCatalog: () => {
            throw new Error("the query must not run");
          },
        }),
      },
    });

    const response = await app.get("/v1/provider-catalog?kind=llm");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });
});
