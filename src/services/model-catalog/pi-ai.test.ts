import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  builtinProviders,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";

import { PiAiModelCatalog } from "./pi-ai.ts";
import { ModelCatalogError } from "./index.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("src/services/model-catalog/pi-ai", () => {
  describe("providers", () => {
    it("carries openai-compatible with no baseUrl and no model", () => {
      const catalog = new PiAiModelCatalog();

      const entry = catalog
        .providers()
        .find((provider) => provider.id === "openai-compatible");

      assert.deepEqual(entry, {
        id: "openai-compatible",
        name: "OpenAI Compatible API",
        baseUrl: null,
        requiresBaseUrl: true,
        oauth: null,
        models: [],
      });
    });

    it("carries a non-null oauth member for every catalogued oauth vendor", () => {
      const catalog = new PiAiModelCatalog();

      assert.deepEqual(
        catalog
          .providers()
          .filter((provider) => provider.oauth !== null)
          .map((provider) => provider.id),
        [
          "anthropic",
          "github-copilot",
          "kimi-coding",
          "openai-codex",
          "openrouter",
          "xai",
        ],
      );
    });

    it("radius is absent from the catalogue", () => {
      const catalog = new PiAiModelCatalog();

      assert.equal(
        catalog.providers().some((provider) => provider.id === "radius"),
        false,
      );
      assert.equal(catalog.has("radius"), false);
      assert.equal(
        getBuiltinProviders().some((provider: string) => provider === "radius"),
        false,
      );
      assert.equal(
        builtinProviders().some((provider) => provider.id === "radius"),
        true,
      );
    });

    it("carries a null oauth member for every other provider", () => {
      const catalog = new PiAiModelCatalog();

      for (const id of ["openai", "groq", "openai-compatible"]) {
        const entry = catalog
          .providers()
          .find((provider) => provider.id === id);
        assert.equal(entry?.oauth, null, id);
      }
    });

    it("labels a vendor with no loginLabel by its oauth name", () => {
      const entry = new PiAiModelCatalog()
        .providers()
        .find((provider) => provider.id === "anthropic");

      assert.deepEqual(entry?.oauth, { label: "Anthropic (Claude Pro/Max)" });
    });

    it("labels a vendor with a loginLabel by that label", () => {
      const providers = new PiAiModelCatalog().providers();

      assert.deepEqual(
        providers.find((provider) => provider.id === "xai")?.oauth,
        { label: "Sign in with SuperGrok or X Premium" },
      );
      assert.deepEqual(
        providers.find((provider) => provider.id === "openrouter")?.oauth,
        { label: "Sign in with OpenRouter" },
      );
    });

    it("reports only the label on the oauth member", () => {
      const entries = new PiAiModelCatalog()
        .providers()
        .filter((provider) => provider.oauth !== null);

      for (const entry of entries) {
        assert.ok(entry.oauth !== undefined && entry.oauth !== null, entry.id);
        assert.deepEqual(Object.keys(entry.oauth), ["label"], entry.id);
      }
    });

    it("carries only the closed provider fields", () => {
      const entry = new PiAiModelCatalog()
        .providers()
        .find((provider) => provider.id === "openai");

      assert.deepEqual(Object.keys(entry ?? {}), [
        "id",
        "name",
        "baseUrl",
        "requiresBaseUrl",
        "oauth",
        "models",
      ]);
    });

    it("carries openai with its own baseUrl and needs none", () => {
      const catalog = new PiAiModelCatalog();

      const entry = catalog
        .providers()
        .find((provider) => provider.id === "openai");

      assert.equal(entry?.baseUrl, "https://api.openai.com/v1");
      assert.equal(entry?.requiresBaseUrl, false);
      assert.ok(entry !== undefined && entry.models.length > 0);
    });

    it("orders the providers bytewise by id", () => {
      const ids = new PiAiModelCatalog()
        .providers()
        .map((provider) => provider.id);

      assert.deepEqual(
        ids,
        [...ids].sort((left, right) =>
          Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
        ),
      );
    });

    it("carries only the closed model fields", () => {
      const model = new PiAiModelCatalog()
        .providers()
        .find((provider) => provider.id === "openai")?.models[0];

      assert.deepEqual(Object.keys(model ?? {}).sort(), [
        "api",
        "baseUrl",
        "contextWindow",
        "cost",
        "id",
        "input",
        "maxTokens",
        "name",
        "provider",
        "reasoning",
      ]);
    });

    it("answers has for a built-in id and for openai-compatible", () => {
      const catalog = new PiAiModelCatalog();

      assert.equal(catalog.has("anthropic"), true);
      assert.equal(catalog.has("openai-compatible"), true);
      assert.equal(catalog.has("nonesuch"), false);
    });
  });

  describe("inspect", () => {
    it("reads the model ids of an OpenAI compatible endpoint in bytewise order", async () => {
      const seen: string[] = [];
      const catalog = new PiAiModelCatalog(async (input) => {
        seen.push(String(input));
        return jsonResponse({
          data: [{ id: "qwen3-30b" }, { id: "llama-3.1-8b" }],
        });
      });

      const models = await catalog.inspect({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "key-01",
      });

      assert.deepEqual(seen, ["http://localhost:11434/v1/models"]);
      assert.deepEqual(
        models.map((model) => model.id),
        ["llama-3.1-8b", "qwen3-30b"],
      );
    });

    it("strips a trailing slash from the baseUrl", async () => {
      const seen: string[] = [];
      const catalog = new PiAiModelCatalog(async (input) => {
        seen.push(String(input));
        return jsonResponse({ data: [] });
      });

      await catalog.inspect({
        baseUrl: "http://localhost:11434/v1//",
        apiKey: "key-01",
      });

      assert.deepEqual(seen, ["http://localhost:11434/v1/models"]);
    });

    it("sends the api key as a bearer token", async () => {
      let authorization = "";
      const catalog = new PiAiModelCatalog(async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization") ?? "";
        return jsonResponse({ data: [] });
      });

      await catalog.inspect({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "key-01",
      });

      assert.equal(authorization, "Bearer key-01");
    });

    it("names the endpoint and marks a probed model unknown", async () => {
      const catalog = new PiAiModelCatalog(async () =>
        jsonResponse({ data: [{ id: "qwen3-30b" }] }),
      );

      const models = await catalog.inspect({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "key-01",
      });

      assert.deepEqual(models, [
        {
          id: "qwen3-30b",
          name: "qwen3-30b",
          api: "openai-completions",
          provider: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 0,
          maxTokens: 0,
        },
      ]);
    });

    it("fails unreachable when the request throws", async () => {
      const catalog = new PiAiModelCatalog(() =>
        Promise.reject(new Error("ECONNREFUSED")),
      );

      await assert.rejects(
        () =>
          catalog.inspect({
            baseUrl: "http://localhost:11434/v1",
            apiKey: "key-01",
          }),
        (error: unknown) =>
          error instanceof ModelCatalogError &&
          error.failure === "unreachable" &&
          error.detail === "ECONNREFUSED",
      );
    });

    it("fails rejected when the endpoint answers a non-2xx status", async () => {
      const catalog = new PiAiModelCatalog(async () =>
        jsonResponse({ error: "no" }, 401),
      );

      await assert.rejects(
        () =>
          catalog.inspect({
            baseUrl: "http://localhost:11434/v1",
            apiKey: "key-01",
          }),
        (error: unknown) =>
          error instanceof ModelCatalogError &&
          error.failure === "rejected" &&
          error.detail === "401",
      );
    });

    it("fails malformed when the body carries no data array", async () => {
      const catalog = new PiAiModelCatalog(async () => jsonResponse({ ok: 1 }));

      await assert.rejects(
        () =>
          catalog.inspect({
            baseUrl: "http://localhost:11434/v1",
            apiKey: "key-01",
          }),
        (error: unknown) =>
          error instanceof ModelCatalogError && error.failure === "malformed",
      );
    });

    it("skips an entry that carries no string id", async () => {
      const catalog = new PiAiModelCatalog(async () =>
        jsonResponse({ data: [{ id: 7 }, null, { id: "kept" }] }),
      );

      const models = await catalog.inspect({
        baseUrl: "http://localhost:11434/v1",
        apiKey: "key-01",
      });

      assert.deepEqual(
        models.map((model) => model.id),
        ["kept"],
      );
    });
  });
});
