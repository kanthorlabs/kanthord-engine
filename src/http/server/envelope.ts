import { HttpError, errorEnvelope, httpError } from "../contract/errors.ts";

export type Materialized = Readonly<{
  status: number;
  body: unknown;
  internal: boolean;
}>;

export function materializeError(error: unknown): Materialized {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: errorEnvelope(error),
      internal: false,
    };
  }
  return {
    status: 500,
    body: errorEnvelope(httpError("internal-error", "internal error")),
    internal: true,
  };
}

export function errorResponse(
  materialized: Materialized,
  headers: Headers,
): Response {
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(materialized.body), {
    status: materialized.status,
    headers,
  });
}

export class ThrownValueError extends Error {
  readonly value: unknown;

  constructor(value: unknown) {
    super("a non-Error value was thrown");
    this.value = value;
  }
}

export function errorValue(error: Error): unknown {
  return error instanceof ThrownValueError ? error.value : error;
}
