import assert from "node:assert/strict";
import { z } from "zod";
import { identitySchema } from "./identity.ts";
import { formatRows, presentRows, type Row } from "./rows.ts";

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
export class FacilityError extends Error {
  constructor() {
    super("The credential facility refuses this use.");
    this.name = "FacilityError";
  }
}

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

export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

export interface DiagnosticOptions extends ErrorOptions {
  fields?: readonly Row[];
  details?: ErrorDetails | null;
}

/** Only explicitly safe diagnostics may cross the process boundary. */
export class Diagnostic extends CodedError {
  readonly fields: readonly Row[];
  readonly details: ErrorDetails | null;

  constructor(code: string, message: string, options?: DiagnosticOptions) {
    super(code, message, options);
    this.fields = options?.fields ?? [];
    this.details = options?.details ?? null;
  }
}

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

export function diagnosticFields(
  error: unknown,
): Record<string, string> | undefined {
  const fields = error instanceof Diagnostic ? presentRows(error.fields) : [];
  return fields.length ? Object.fromEntries(fields) : undefined;
}

export function diagnosticRows(error: unknown): string {
  return error instanceof Diagnostic
    ? formatRows([
        ...error.fields,
        [
          "details",
          error.details === null ? null : JSON.stringify(error.details),
        ],
      ])
    : "";
}

const UNRECOGNIZED_KEYS = "unrecognized_keys";

export interface ValidationIssue {
  path: PropertyKey[];
  code: string;
}

export function validationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.flatMap((issue): ValidationIssue[] =>
    issue.code === UNRECOGNIZED_KEYS
      ? issue.keys.map((key) => ({
          path: [...issue.path, key],
          code: issue.code,
        }))
      : [{ path: issue.path, code: issue.code }],
  );
}

export const errorDetailsSchema = z.json();
export const errorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    details: errorDetailsSchema.nullable(),
  }),
  request_id: identitySchema("request"),
});
export type ErrorBody = z.infer<typeof errorSchema>;

export class OperationError extends CodedError {
  readonly status: number;
  readonly details: z.infer<ReturnType<typeof z.json>> | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: z.infer<ReturnType<typeof z.json>> | null = null,
  ) {
    super(code, message);
    this.status = status;
    this.details = details;
  }
}
