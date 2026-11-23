import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Diagnostic } from "../../kernel/errors.ts";
import { resolveAgentModel } from "./run-agent-model.ts";
import type { AgentModelForm } from "./run-agent-model.ts";

const MODEL_UNKNOWN = "cli.run.agent.model_unknown";
const MODEL_INEXACT = "cli.run.agent.model_inexact";
const LEVEL_UNSUPPORTED = "cli.run.agent.level_unsupported";
const FIELD_OPTION = "option";
const MODEL_OPTION = "--model";
const FIXTURE_PROVIDER = "openai";
const FIXTURE_MODEL_ID = "gpt-4o";
const FIXTURE_LEVEL = "off";
const MEDIUM_LEVEL = "medium";
const XHIGH_LEVEL = "xhigh";

function assertDiagnostic(action: () => unknown, code: string): Diagnostic {
  let result: Diagnostic | undefined;
  assert.throws(action, (e: unknown) => {
    if (!(e instanceof Diagnostic)) return false;
    assert.equal(e.code, code);
    result = e;
    return true;
  });
  return result!;
}

function makeModel(
  provider: string,
  id: string,
  reasoning: boolean,
  supportedHigher?: boolean,
): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-chat" as Api,
    provider,
    baseUrl: `https://api.example.com/v1`,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning,
    contextWindow: 4096,
    maxTokens: 4096,
    thinkingLevelMap: reasoning
      ? {
          off: null,
          minimal: "1",
          low: "2",
          medium: "3",
          high: "4",
          xhigh: supportedHigher ? "5" : undefined,
          max: supportedHigher ? "6" : undefined,
        }
      : undefined,
  } as unknown as Model<Api>;
}

interface MockRuntime {
  getModels(): readonly Model<Api>[];
  getModel(provider: string, id: string): Model<Api> | undefined;
  hasConfiguredAuth(provider: string): boolean;
}

function makeRuntime(models: Model<Api>[]): ModelRuntime {
  const mock: MockRuntime = {
    getModels: () => models,
    getModel: (provider, id) =>
      models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => false,
  };
  return mock as unknown as ModelRuntime;
}

function form(provider: string, model: string, level: string): AgentModelForm {
  return { provider, model, level };
}

describe("resolveAgentModel", () => {
  it("resolves an exact non-reasoning model", () => {
    const model = makeModel(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, false);
    const runtime = makeRuntime([model]);
    const result = resolveAgentModel(
      form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, FIXTURE_LEVEL),
      runtime,
    );
    assert.equal(result.provider, FIXTURE_PROVIDER);
    assert.equal(result.model, FIXTURE_MODEL_ID);
    assert.equal(result.reasoning_effort, FIXTURE_LEVEL);
  });

  it("resolves an exact reasoning model", () => {
    const model = makeModel(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, true);
    const runtime = makeRuntime([model]);
    const result = resolveAgentModel(
      form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, MEDIUM_LEVEL),
      runtime,
    );
    assert.equal(result.reasoning_effort, MEDIUM_LEVEL);
  });

  it("refuses an unknown model (no models available)", () => {
    const runtime = makeRuntime([]);
    const error = assertDiagnostic(
      () =>
        resolveAgentModel(
          form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, FIXTURE_LEVEL),
          runtime,
        ),
      MODEL_UNKNOWN,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_OPTION && v === MODEL_OPTION),
    );
  });

  it("refuses an unknown model (model not found)", () => {
    const model = makeModel(FIXTURE_PROVIDER, "other-model", false);
    const runtime = makeRuntime([model]);
    assertDiagnostic(
      () =>
        resolveAgentModel(
          form(FIXTURE_PROVIDER, "nonexistent-model-xyz", FIXTURE_LEVEL),
          runtime,
        ),
      MODEL_UNKNOWN,
    );
  });

  it("refuses a custom model fallback (model not in runtime)", () => {
    const model = makeModel(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, false);
    const runtime = makeRuntime([model]);
    assertDiagnostic(
      () =>
        resolveAgentModel(
          form(FIXTURE_PROVIDER, "my-custom-unknown-id", FIXTURE_LEVEL),
          runtime,
        ),
      MODEL_UNKNOWN,
    );
  });

  it("refuses a partial id match (fuzzy match returns a different model id)", () => {
    const model = makeModel(FIXTURE_PROVIDER, "gpt-4o-mini-2024-07-18", false);
    const runtime = makeRuntime([model]);
    const error = assertDiagnostic(
      () =>
        resolveAgentModel(
          form(FIXTURE_PROVIDER, "gpt-4o-mini", FIXTURE_LEVEL),
          runtime,
        ),
      MODEL_INEXACT,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_OPTION && v === MODEL_OPTION),
    );
  });

  it("refuses a case-insensitive id match", () => {
    const model = makeModel(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, false);
    const runtime = makeRuntime([model]);
    assertDiagnostic(
      () =>
        resolveAgentModel(
          form(FIXTURE_PROVIDER, "GPT-4O", FIXTURE_LEVEL),
          runtime,
        ),
      MODEL_INEXACT,
    );
  });

  it("refuses a case-insensitive provider match", () => {
    const model = makeModel(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, false);
    const runtime = makeRuntime([model]);
    assertDiagnostic(
      () =>
        resolveAgentModel(
          form("OpenAI", FIXTURE_MODEL_ID, FIXTURE_LEVEL),
          runtime,
        ),
      MODEL_INEXACT,
    );
  });

  it("refuses an unsupported level for a non-reasoning model", () => {
    const model = makeModel(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, false);
    const runtime = makeRuntime([model]);
    const error = assertDiagnostic(
      () =>
        resolveAgentModel(
          form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, MEDIUM_LEVEL),
          runtime,
        ),
      LEVEL_UNSUPPORTED,
    );
    assert.ok(
      error.fields.some(([k, v]) => k === FIELD_OPTION && v === MODEL_OPTION),
    );
  });

  it("refuses xhigh when not in thinkingLevelMap", () => {
    const model = makeModel(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, true, false);
    const runtime = makeRuntime([model]);
    assertDiagnostic(
      () =>
        resolveAgentModel(
          form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, XHIGH_LEVEL),
          runtime,
        ),
      LEVEL_UNSUPPORTED,
    );
  });

  it("accepts xhigh when in thinkingLevelMap", () => {
    const model = makeModel(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, true, true);
    const runtime = makeRuntime([model]);
    const result = resolveAgentModel(
      form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, XHIGH_LEVEL),
      runtime,
    );
    assert.equal(result.reasoning_effort, XHIGH_LEVEL);
  });
});
