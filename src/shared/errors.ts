import assert from "node:assert/strict";
import { z } from "zod";

const EMPTY_MESSAGE_LENGTH = 0;

export const errorCodeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*){2,}(?![\s\S])/,
  )
  .describe(
    "Error location and condition: namespace.component[.component...].error; lower-case words separated by underscores.",
  );

/** An engine-defined code; native and dependency errors retain their own codes. */
export class CodedError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    assert.ok(errorCodeSchema.safeParse(code).success, "Invalid error code.");
    assert.ok(
      message.length > EMPTY_MESSAGE_LENGTH,
      "An error requires a message.",
    );
    this.code = code;
  }
}

/** Only explicitly safe diagnostics may cross the process boundary. */
export class Diagnostic extends CodedError {}

export function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new CodedError("system.operation.unknown", "Operation failed.", {
        cause: error,
      });
}

export function diagnostic(error: unknown): string {
  return error instanceof Diagnostic
    ? `${error.code}: ${error.message}`
    : "system.operation.unknown: Operation failed.";
}
