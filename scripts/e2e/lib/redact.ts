import { RunnerError } from "./errors.ts";

export const redactedMarker = "[redacted]";

export type SecretRegistry = Readonly<{
  hold(value: string): void;
  redact(text: string): string;
  values(): readonly string[];
  forms(): readonly string[];
}>;

export function createSecretRegistry(): SecretRegistry {
  let values: string[] = [];

  function forms(): readonly string[] {
    return values.flatMap((value) => [
      value,
      Buffer.from(value).toString("base64"),
      `user:${value}@`,
    ]);
  }

  return {
    hold(value: string): void {
      if (value.length < 8) {
        throw new RunnerError(
          "invalid-argument",
          "a secret must be at least 8 characters",
        );
      }
      values = [...values, value];
    },
    redact(text: string): string {
      const orderedForms = [...forms()].sort((a, b) => b.length - a.length);

      return orderedForms.reduce(
        (result, form) => result.split(form).join(redactedMarker),
        text,
      );
    },
    values(): readonly string[] {
      return values;
    },
    forms,
  };
}

export const secrets = createSecretRegistry();

export function redact(text: string): string {
  return secrets.redact(text);
}
