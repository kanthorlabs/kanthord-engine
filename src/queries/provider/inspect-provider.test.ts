import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InspectProviderError, inspectProvider } from "./inspect-provider.ts";
import { ModelCatalogError } from "../../services/model-catalog/index.ts";
import type { InspectModelsInput } from "../../services/model-catalog/index.ts";
import {
  catalogModel,
  createFakeModelCatalog,
} from "../../../test/helpers/model-catalog.ts";

const compatible = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "key-01",
};

describe("src/queries/provider/inspect-provider", () => {
  it("answers the models the endpoint lists", async () => {
    const seen: InspectModelsInput[] = [];
    const catalog = createFakeModelCatalog({
      inspect: async (input) => {
        seen.push(input);
        return [catalogModel("qwen3-30b", { provider: "openai-compatible" })];
      },
    });

    const result = await inspectProvider({ catalog }, compatible);

    assert.deepEqual(
      result.models.map((model) => model.id),
      ["qwen3-30b"],
    );
    assert.deepEqual(seen, [
      { baseUrl: "http://localhost:11434/v1", apiKey: "key-01" },
    ]);
  });

  it("refuses an unknown provider with provider-unknown", async () => {
    const catalog = createFakeModelCatalog();

    await assert.rejects(
      () => inspectProvider({ catalog }, { ...compatible, provider: "nope" }),
      (error: unknown) =>
        error instanceof InspectProviderError &&
        error.refusal === "provider-unknown",
    );
  });

  it("refuses a built-in provider with provider-not-inspectable", async () => {
    const catalog = createFakeModelCatalog();

    await assert.rejects(
      () => inspectProvider({ catalog }, { ...compatible, provider: "openai" }),
      (error: unknown) =>
        error instanceof InspectProviderError &&
        error.refusal === "provider-not-inspectable",
    );
  });

  it("refuses a null baseUrl with base-url-required", async () => {
    const catalog = createFakeModelCatalog();

    await assert.rejects(
      () => inspectProvider({ catalog }, { ...compatible, baseUrl: null }),
      (error: unknown) =>
        error instanceof InspectProviderError &&
        error.refusal === "base-url-required",
    );
  });

  it("calls no endpoint when the provider is refused", async () => {
    let calls = 0;
    const catalog = createFakeModelCatalog({
      inspect: async () => {
        calls += 1;
        return [];
      },
    });

    await assert.rejects(() =>
      inspectProvider({ catalog }, { ...compatible, provider: "openai" }),
    );

    assert.equal(calls, 0);
  });

  for (const [failure, refusal] of [
    ["unreachable", "endpoint-unreachable"],
    ["rejected", "endpoint-rejected"],
    ["malformed", "endpoint-malformed"],
  ] as const) {
    it(`maps a ${failure} catalog failure to ${refusal}`, async () => {
      const catalog = createFakeModelCatalog({
        inspect: () =>
          Promise.reject(
            new ModelCatalogError(failure, `the endpoint is ${failure}`, "d"),
          ),
      });

      await assert.rejects(
        () => inspectProvider({ catalog }, compatible),
        (error: unknown) =>
          error instanceof InspectProviderError &&
          error.refusal === refusal &&
          error.detail === "d",
      );
    });
  }
});
