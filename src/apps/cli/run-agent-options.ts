import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  agentProviderKindSchema,
  OPENAI_COMPATIBLE_PROVIDER,
  reasoningEffortSchema,
} from "../../agent/contract.ts";
import { ANTHROPIC_SUBSCRIPTION_PLATFORM } from "../../kernel/pi-provider.ts";

const TOKEN = "cli.run.agent.token";
const OPTION_INVALID = "cli.run.agent.option_invalid";

export interface ParsedModelForm {
  provider: string;
  model: string;
  level: string;
}

export function checkTokenRefused(token: string | undefined): void {
  if (token !== undefined)
    throw new Diagnostic(TOKEN, "run agent: --token is not accepted.", {
      fields: [["option", "--token"]],
    });
}

export function parseModelForm(value: string): ParsedModelForm {
  const optionField = [["option", "--model"]] as [string, string][];
  if (!value.includes("/"))
    throw new Diagnostic(
      OPTION_INVALID,
      "run agent: the --model value has no /.",
      { fields: optionField },
    );

  const slashIndex = value.indexOf("/");
  const provider = value.slice(0, slashIndex);
  const rest = value.slice(slashIndex + 1);

  if (!rest.includes(":"))
    throw new Diagnostic(
      OPTION_INVALID,
      "run agent: the --model value has no : after /.",
      { fields: optionField },
    );

  const colonIndex = rest.lastIndexOf(":");
  const model = rest.slice(0, colonIndex);
  const level = rest.slice(colonIndex + 1);

  if (!model.length)
    throw new Diagnostic(
      OPTION_INVALID,
      "run agent: the --model value has an empty model part.",
      { fields: optionField },
    );

  if (provider === ANTHROPIC_SUBSCRIPTION_PLATFORM)
    throw new Diagnostic(
      OPTION_INVALID,
      "run agent: the --model provider must not be anthropic-subscription.",
      { fields: optionField },
    );

  if (!agentProviderKindSchema.safeParse(provider).success)
    throw new Diagnostic(
      OPTION_INVALID,
      "run agent: the --model provider is unknown.",
      { fields: optionField },
    );

  if (!reasoningEffortSchema.safeParse(level).success)
    throw new Diagnostic(
      OPTION_INVALID,
      "run agent: the --model reasoning level is unknown.",
      { fields: optionField },
    );

  return { provider, model, level };
}

export function checkWorkspaceDir(
  value: string | undefined,
  currentDir: string,
): string {
  if (value === undefined) return currentDir;
  const abs = resolve(currentDir, value);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isDirectory())
    throw new Diagnostic(
      OPTION_INVALID,
      "run agent: the --workspace path is absent or not a directory.",
      {
        fields: [["option", "--workspace"]],
      },
    );
  return abs;
}

export function checkRequiredOption(value: unknown, optionName: string): void {
  if (value === undefined || (Array.isArray(value) && !value.length))
    throw new Diagnostic(
      OPTION_INVALID,
      `run agent: ${optionName} is required.`,
      {
        fields: [["option", optionName]],
      },
    );
}

export { OPENAI_COMPATIBLE_PROVIDER };
