export type ConfirmDependencies = Readonly<{
  isTty: boolean;
  prompt: (question: string) => Promise<string>;
}>;

export type ConfirmInput = Readonly<{
  flagName: string;
  flagValue: string | undefined;
  question: string;
  suggestion: string | null;
}>;

export class ConfirmationRequiredError extends Error {
  readonly flagName: string;

  constructor(flagName: string) {
    super(`${flagName} is required when there is no terminal to confirm on`);
    this.name = "ConfirmationRequiredError";
    this.flagName = flagName;
  }
}

export async function confirmValue(
  dependencies: ConfirmDependencies,
  input: ConfirmInput,
): Promise<string> {
  if (input.flagValue !== undefined && input.flagValue.length > 0) {
    return input.flagValue;
  }
  if (!dependencies.isTty) {
    throw new ConfirmationRequiredError(input.flagName);
  }
  const suffix = input.suggestion === null ? "" : ` [${input.suggestion}]`;
  const question = `${input.question}${suffix}`;
  for (;;) {
    const answer = (await dependencies.prompt(question)).trim();
    if (answer.length > 0) {
      return answer;
    }
    if (input.suggestion !== null) {
      return input.suggestion;
    }
  }
}
