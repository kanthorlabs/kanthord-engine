import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Diagnostic } from "../../kernel/errors.ts";

const MODEL_UNKNOWN = "cli.run.agent.model_unknown";
const MODEL_INEXACT = "cli.run.agent.model_inexact";
const LEVEL_UNSUPPORTED = "cli.run.agent.level_unsupported";

const OPTION_FIELD = [["option", "--model"]] as [string, string][];

export interface AgentModelForm {
  provider: string;
  model: string;
  level: string;
}

export interface ResolvedModel {
  provider: string;
  model: string;
  reasoning_effort: string;
}

function fuzzyMatch(
  models: readonly Model<Api>[],
  provider: string,
  model: string,
): Model<Api> | undefined {
  const lp = provider.toLowerCase();
  const lm = model.toLowerCase();
  return models.find(
    (m) =>
      m.provider.toLowerCase() === lp &&
      (m.id.startsWith(model) || m.id.toLowerCase() === lm),
  );
}

export function resolveAgentModel(
  form: AgentModelForm,
  modelRuntime: ModelRuntime,
): ResolvedModel {
  const { provider, model, level } = form;
  const exact = modelRuntime.getModel(provider, model);

  if (!exact) {
    const near = fuzzyMatch(modelRuntime.getModels(), provider, model);
    if (near)
      throw new Diagnostic(
        MODEL_INEXACT,
        "run agent: the model selection does not match exactly.",
        { fields: OPTION_FIELD },
      );
    throw new Diagnostic(MODEL_UNKNOWN, "run agent: the model is unknown.", {
      fields: OPTION_FIELD,
    });
  }

  const supportedLevels = getSupportedThinkingLevels(exact);
  if (!supportedLevels.includes(level as ModelThinkingLevel))
    throw new Diagnostic(
      LEVEL_UNSUPPORTED,
      "run agent: the reasoning level is not supported by this model.",
      { fields: OPTION_FIELD },
    );

  return { provider, model, reasoning_effort: level };
}
