import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import type { ProviderListItem } from "../../../queries/provider/list-provider.ts";
import { listProviderHandler } from "./list-provider.ts";

const items: readonly ProviderListItem[] = [
  {
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
  },
  {
    id: "provider_01HZY8QF3M4N5P6R7S8T9V0W1Z",
    name: "anthropic-bot",
    kind: "llm",
    projection: {
      provider: "anthropic",
      defaultModel: "claude-opus-5",
      baseUrl: null,
    },
    setDefaultAt: null,
    updatedAt: 1700000001000,
  },
];

describe("src/http/server/credential/list-provider.test", () => {
  it("GET /v1/provider answers 200 with the provider list and passes the empty input", async () => {
    let called: unknown = "not-called";
    const app = await createTestApp({
      handlers: {
        "provider.list": listProviderHandler({
          listProviders: (input) => {
            called = input;
            return items;
          },
        }),
      },
    });
    const response = await app.get("/v1/provider");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { providers: items });
    assert.deepEqual(called, {});
  });
});
