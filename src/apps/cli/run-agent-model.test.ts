import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadPi } from "../../agent/pi.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { createModelRuntime } from "../../llm/model-connector.ts";
import { resolveAgentModel } from "./run-agent-model.ts";
import type { AgentModelForm } from "./run-agent-model.ts";

const MODEL_UNKNOWN = "cli.run.agent.model_unknown";
const MODEL_INEXACT = "cli.run.agent.model_inexact";
const LEVEL_UNSUPPORTED = "cli.run.agent.level_unsupported";
const FIELD_OPTION = "option";
const MODEL_OPTION = "--model";
const FIXTURE_PROVIDER = "openai-compatible";
const ABSENT_PROVIDER = "absent-provider";
const FIXTURE_MODEL_ID = "stub-1";
const DATED_MODEL_ID = "stub-1-2024-07-18";
const COLON_MODEL_ID = "x:high";
const COLON_MODEL_PREFIX = "x";
const FIXTURE_CREDENTIAL_ID = "credential";
const OFF_LEVEL = "off";
const MEDIUM_LEVEL = "medium";
const HIGH_LEVEL = "high";
const XHIGH_LEVEL = "xhigh";
const REASONING_LEVELS = ["off", "low", "medium", "high"];

interface CatalogModel {
  id: string;
  reasoning_levels?: string[];
}

async function assertDiagnostic(
  action: Promise<unknown>,
  code: string,
): Promise<Diagnostic> {
  let result: Diagnostic | undefined;
  await assert.rejects(action, (e: unknown) => {
    if (!(e instanceof Diagnostic)) return false;
    assert.equal(e.code, code);
    result = e;
    return true;
  });
  return result!;
}

async function makeRuntime(models: CatalogModel[]): Promise<ModelRuntime> {
  return createModelRuntime(await loadPi(), {
    credentials: new InMemoryCredentialStore(),
    handoverItem: {
      credential_id: FIXTURE_CREDENTIAL_ID,
      provider_id: FIXTURE_PROVIDER,
    },
    credentialId: FIXTURE_CREDENTIAL_ID,
    configuration: {
      agent_provider: "default",
      provider: FIXTURE_PROVIDER,
      model_identifier: models[0]!.id,
      reasoning_effort: OFF_LEVEL,
    },
    metadata: { base_url: "http://127.0.0.1:1/v1", models },
    signal: new AbortController().signal,
  });
}

function form(provider: string, model: string, level: string): AgentModelForm {
  return { provider, model, level };
}

function namesModelOption(error: Diagnostic): boolean {
  return error.fields.some(
    ([k, v]) => k === FIELD_OPTION && v === MODEL_OPTION,
  );
}

describe("resolveAgentModel", () => {
  it("resolves an exact model at the level off", async () => {
    const runtime = await makeRuntime([{ id: FIXTURE_MODEL_ID }]);
    const result = await resolveAgentModel(
      form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, OFF_LEVEL),
      runtime,
    );
    assert.equal(result.provider, FIXTURE_PROVIDER);
    assert.equal(result.model, FIXTURE_MODEL_ID);
    assert.equal(result.reasoning_effort, OFF_LEVEL);
  });

  it("resolves an exact reasoning model at a supported level", async () => {
    const runtime = await makeRuntime([
      { id: FIXTURE_MODEL_ID, reasoning_levels: REASONING_LEVELS },
    ]);
    const result = await resolveAgentModel(
      form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, MEDIUM_LEVEL),
      runtime,
    );
    assert.equal(result.reasoning_effort, MEDIUM_LEVEL);
  });

  it("refuses a provider that the runtime does not hold", async () => {
    const runtime = await makeRuntime([{ id: FIXTURE_MODEL_ID }]);
    const error = await assertDiagnostic(
      resolveAgentModel(
        form(ABSENT_PROVIDER, "nonexistent-model-xyz", OFF_LEVEL),
        runtime,
      ),
      MODEL_UNKNOWN,
    );
    assert.ok(namesModelOption(error));
  });

  it("refuses the custom model fallback of pi for an id outside the runtime", async () => {
    const runtime = await makeRuntime([{ id: FIXTURE_MODEL_ID }]);
    await assertDiagnostic(
      resolveAgentModel(
        form(FIXTURE_PROVIDER, "my-custom-unknown-id", OFF_LEVEL),
        runtime,
      ),
      MODEL_UNKNOWN,
    );
  });

  it("refuses a partial id that pi matches to another model id", async () => {
    const runtime = await makeRuntime([{ id: DATED_MODEL_ID }]);
    const error = await assertDiagnostic(
      resolveAgentModel(
        form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, OFF_LEVEL),
        runtime,
      ),
      MODEL_INEXACT,
    );
    assert.ok(namesModelOption(error));
  });

  it("refuses a case-insensitive id match", async () => {
    const runtime = await makeRuntime([{ id: FIXTURE_MODEL_ID }]);
    await assertDiagnostic(
      resolveAgentModel(
        form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID.toUpperCase(), OFF_LEVEL),
        runtime,
      ),
      MODEL_INEXACT,
    );
  });

  it("refuses a case-insensitive provider match", async () => {
    const runtime = await makeRuntime([{ id: FIXTURE_MODEL_ID }]);
    await assertDiagnostic(
      resolveAgentModel(
        form(FIXTURE_PROVIDER.toUpperCase(), FIXTURE_MODEL_ID, OFF_LEVEL),
        runtime,
      ),
      MODEL_INEXACT,
    );
  });

  it("regression: refuses the model x at the level high when pi selects the catalog id x:high", async () => {
    const runtime = await makeRuntime([
      { id: COLON_MODEL_PREFIX, reasoning_levels: REASONING_LEVELS },
      { id: COLON_MODEL_ID, reasoning_levels: REASONING_LEVELS },
    ]);
    await assertDiagnostic(
      resolveAgentModel(
        form(FIXTURE_PROVIDER, COLON_MODEL_PREFIX, HIGH_LEVEL),
        runtime,
      ),
      MODEL_INEXACT,
    );
  });

  it("resolves a catalog id that holds a colon and a level name", async () => {
    const runtime = await makeRuntime([{ id: COLON_MODEL_ID }]);
    const result = await resolveAgentModel(
      form(FIXTURE_PROVIDER, COLON_MODEL_ID, OFF_LEVEL),
      runtime,
    );
    assert.equal(result.model, COLON_MODEL_ID);
    assert.equal(result.reasoning_effort, OFF_LEVEL);
  });

  it("refuses a level above off for a model with no reasoning", async () => {
    const runtime = await makeRuntime([{ id: FIXTURE_MODEL_ID }]);
    const error = await assertDiagnostic(
      resolveAgentModel(
        form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, MEDIUM_LEVEL),
        runtime,
      ),
      LEVEL_UNSUPPORTED,
    );
    assert.ok(namesModelOption(error));
  });

  it("refuses xhigh when the model does not list it", async () => {
    const runtime = await makeRuntime([
      { id: FIXTURE_MODEL_ID, reasoning_levels: REASONING_LEVELS },
    ]);
    await assertDiagnostic(
      resolveAgentModel(
        form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, XHIGH_LEVEL),
        runtime,
      ),
      LEVEL_UNSUPPORTED,
    );
  });

  it("accepts xhigh when the model lists it", async () => {
    const runtime = await makeRuntime([
      {
        id: FIXTURE_MODEL_ID,
        reasoning_levels: [...REASONING_LEVELS, XHIGH_LEVEL],
      },
    ]);
    const result = await resolveAgentModel(
      form(FIXTURE_PROVIDER, FIXTURE_MODEL_ID, XHIGH_LEVEL),
      runtime,
    );
    assert.equal(result.reasoning_effort, XHIGH_LEVEL);
  });
});
