import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { catalogModel } from "../../../../test/helpers/model-catalog.ts";
import { InspectProviderError } from "../../../queries/provider/inspect-provider.ts";
import type { InspectProviderInput } from "../../../queries/provider/inspect-provider.ts";
import { inspectProviderHandler } from "./inspect-provider.ts";

const model = catalogModel("qwen3-30b", {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
});

const body = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "key-01",
};

describe("src/http/server/credential/inspect-provider.test", () => {
  it("POST /v1/provider/inspect answers 200 and passes the body through", async () => {
    let called: InspectProviderInput | undefined;
    const app = await createTestApp({
      handlers: {
        "provider.inspect": inspectProviderHandler({
          inspectProvider: (input) => {
            called = input;
            return Promise.resolve({ models: [model] });
          },
        }),
      },
    });

    const response = await app.post("/v1/provider/inspect").send(body);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { models: [model] });
    assert.deepEqual(called, body);
  });

  it("answers 400 when the body carries no provider", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.inspect": inspectProviderHandler({
          inspectProvider: () =>
            Promise.reject(new Error("the query must not run")),
        }),
      },
    });

    const response = await app.post("/v1/provider/inspect").send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("answers 400 with the refusal when the query refuses", async () => {
    const app = await createTestApp({
      handlers: {
        "provider.inspect": inspectProviderHandler({
          inspectProvider: () =>
            Promise.reject(
              new InspectProviderError(
                "endpoint-unreachable",
                "the endpoint could not be reached",
                "ECONNREFUSED",
              ),
            ),
        }),
      },
    });

    const response = await app.post("/v1/provider/inspect").send(body);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body.error.details, {
      refusal: "endpoint-unreachable",
      detail: "ECONNREFUSED",
    });
  });
});
