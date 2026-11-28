import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { loadPi } from "../../agent/pi.ts";
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

function refuse(code: string, message: string): never {
  throw new Diagnostic(code, message, { fields: OPTION_FIELD });
}

export async function resolveAgentModel(
  form: AgentModelForm,
  modelRuntime: ModelRuntime,
): Promise<ResolvedModel> {
  const { provider, model, level } = form;
  const { resolveCliModel } = await loadPi();
  const result = resolveCliModel({
    cliModel: `${provider}/${model}:${level}`,
    modelRuntime,
  });
  const found = result.model;
  if (result.error !== undefined || found === undefined)
    refuse(MODEL_UNKNOWN, "run agent: the model is unknown.");
  if (modelRuntime.getModel(found.provider, found.id) !== found)
    refuse(MODEL_UNKNOWN, "run agent: the model is unknown.");
  if (
    found.provider !== provider ||
    found.id !== model ||
    result.thinkingLevel !== level
  )
    refuse(
      MODEL_INEXACT,
      "run agent: the model selection does not match exactly.",
    );
  if (!getSupportedThinkingLevels(found).includes(level as ModelThinkingLevel))
    refuse(
      LEVEL_UNSUPPORTED,
      "run agent: the reasoning level is not supported by this model.",
    );
  return { provider, model, reasoning_effort: level };
}
