import { KANTHORD_VERSION } from "../domain/version.ts";
import { daemonErrorEnvelopeSchema } from "../http/contract/errors.ts";
import { parameterNames, renderPath } from "../http/contract/path.ts";
import { findOperation } from "../http/contract/registry.ts";
import {
  envelopeCodeForStatus,
  INDETERMINATE_OUTCOME_CODE,
  TRANSPORT_FAILURE_CODE,
} from "./exit-code.ts";

export type ClientDependencies = Readonly<{
  baseUrl: string;
  token: string | undefined;
  fetch: typeof globalThis.fetch;
}>;

export type CallInput = Readonly<{
  operationId: string;
  parameters?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | undefined>>;
  idempotencyKey?: string;
  body?: unknown;
}>;

export type CallResult =
  | Readonly<{ ok: true; status: number; body: unknown }>
  | Readonly<{
      ok: false;
      status: number;
      code: string;
      message: string;
      details: unknown;
    }>;

export type DaemonClient = Readonly<{
  call(
    operationId: string,
    body: unknown,
    parameters?: Readonly<Record<string, string>>,
    options?: Readonly<{
      query?: Readonly<Record<string, string | undefined>>;
      idempotencyKey?: string;
    }>,
  ): Promise<CallResult>;
}>;

const PARAMETER_VALUE = /^[A-Za-z0-9_:.-]+$/;

export function buildRequest(
  dependencies: ClientDependencies,
  input: CallInput,
): Readonly<{ url: string; init: RequestInit }> {
  const operation = findOperation(input.operationId);
  if (operation === undefined) {
    throw new Error(`unknown operation id: ${input.operationId}`);
  }

  let path = renderPath(operation.path);
  for (const name of parameterNames(operation.path)) {
    const value = input.parameters?.[name];
    if (value === undefined) {
      throw new Error(
        `operation ${input.operationId} declares parameter ${name}`,
      );
    }
    if (!PARAMETER_VALUE.test(value)) {
      throw new Error(
        `parameter ${name} has a value that would need encoding: ${value}`,
      );
    }
    path = path.replaceAll(`:${name}`, value);
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Kanthord-Client": KANTHORD_VERSION,
  };
  if (dependencies.token !== undefined) {
    headers.Authorization = `Bearer ${dependencies.token}`;
  }
  if (input.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = input.idempotencyKey;
  }

  const init: RequestInit = { method: operation.method, headers };
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(input.body);
  }

  const baseUrl = dependencies.baseUrl.replace(/\/+$/, "");
  let query = "";
  if (input.query !== undefined) {
    const entries = Object.entries(input.query)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) =>
        Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
      );
    if (entries.length > 0) {
      query = `?${entries
        .map(
          ([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
        )
        .join("&")}`;
    }
  }
  return { url: `${baseUrl}${path}${query}`, init };
}

export async function call(
  dependencies: ClientDependencies,
  input: CallInput,
): Promise<CallResult> {
  const request = buildRequest(dependencies, input);
  const safeMethod = request.init.method === "GET";
  let response: Response;
  try {
    response = await dependencies.fetch(request.url, request.init);
  } catch (error) {
    if (safeMethod || preDispatch(error)) {
      return {
        ok: false as const,
        status: 0,
        code: TRANSPORT_FAILURE_CODE,
        message: `cannot reach the daemon at ${dependencies.baseUrl}: ${transportReason(error)}`,
        details: undefined,
      };
    }
    return {
      ok: false as const,
      status: 0,
      code: INDETERMINATE_OUTCOME_CODE,
      message: `the daemon at ${dependencies.baseUrl} did not answer ${input.operationId}, so the operation may have committed: ${transportReason(error)}`,
      details: undefined,
    };
  }
  const status = response.status;

  if (response.ok) {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      const early = `the daemon at ${dependencies.baseUrl} answered ${status} and the body ended early`;
      return {
        ok: false as const,
        status,
        code: safeMethod ? TRANSPORT_FAILURE_CODE : INDETERMINATE_OUTCOME_CODE,
        message: safeMethod
          ? `${early}: ${transportReason(error)}`
          : `${early}, so ${input.operationId} may have committed: ${transportReason(error)}`,
        details: undefined,
      };
    }
    const contentType = response.headers.get("content-type");
    if (contentType !== null && /application\/json/.test(contentType)) {
      try {
        return { ok: true, status, body: JSON.parse(text) };
      } catch {
        return { ok: true, status, body: text };
      }
    }
    return { ok: true, status, body: text };
  }

  const fallback = {
    ok: false as const,
    status,
    code: envelopeCodeForStatus(status),
    message: `the daemon answered ${status} with no error envelope`,
    details: undefined,
  };
  try {
    const contentType = response.headers.get("content-type");
    if (contentType === null || !/application\/json/.test(contentType)) {
      return fallback;
    }
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    const result = daemonErrorEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      return fallback;
    }
    return {
      ok: false as const,
      status,
      code: result.data.error.code,
      message: result.data.error.message,
      details: result.data.error.details,
    };
  } catch {
    return fallback;
  }
}

function transportReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause: unknown = error.cause;
  if (cause instanceof Error && cause.message !== "") {
    return cause.message;
  }
  return error.message;
}

function preDispatch(error: unknown): boolean {
  const code = causeCode(error);
  return (
    code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN"
  );
}

function causeCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const carrier: unknown = error.cause instanceof Error ? error.cause : error;
  const code = (carrier as Readonly<{ code?: unknown }>).code;
  return typeof code === "string" ? code : undefined;
}
