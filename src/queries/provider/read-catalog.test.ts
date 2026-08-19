import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readCatalog } from "./read-catalog.ts";
import {
  createFakeModelCatalog,
  defaultCatalogProviders,
} from "../../../test/helpers/model-catalog.ts";

describe("src/queries/provider/read-catalog", () => {
  it("answers every provider the catalog holds", () => {
    const result = readCatalog({ catalog: createFakeModelCatalog() });

    assert.deepEqual(
      result.providers.map((provider) => provider.id),
      ["anthropic", "openai", "openai-compatible"],
    );
    assert.deepEqual(result.providers, defaultCatalogProviders);
  });

  it("marks openai-compatible as the one provider that needs a baseUrl", () => {
    const result = readCatalog({ catalog: createFakeModelCatalog() });

    const needing = result.providers.filter(
      (provider) => provider.requiresBaseUrl,
    );
    assert.deepEqual(
      needing.map((provider) => provider.id),
      ["openai-compatible"],
    );
    assert.equal(needing[0]?.baseUrl, null);
    assert.deepEqual(needing[0]?.models, []);
  });

  it("carries the static model list of a built-in provider", () => {
    const result = readCatalog({ catalog: createFakeModelCatalog() });

    const openai = result.providers.find(
      (provider) => provider.id === "openai",
    );
    assert.deepEqual(
      openai?.models.map((model) => model.id),
      ["gpt-4o"],
    );
    assert.equal(openai?.baseUrl, "https://api.openai.com/v1");
  });
});
