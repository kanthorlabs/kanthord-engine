import { addAbortListener } from "node:events";
import { join } from "node:path";
import type { MessagePort } from "node:worker_threads";
import { ulid } from "ulid";
import { HttpStatus } from "../kernel/http.ts";
import { isString } from "../kernel/values.ts";
import { directories } from "../kernel/xdg.ts";
import { parseMapping } from "../kernel/yaml.ts";
import { audit, readPrivate } from "../kernel/files.ts";
import { z } from "zod";
import { Diagnostic } from "../kernel/errors.ts";
import type { gatewayOperations } from "./contract.ts";
import {
  OperationResultType,
  OperationLifetime,
  type ClientOptions,
  type Operation,
  type ServiceClient,
} from "../kernel/operation.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { createClient, inputValidationFailure } from "./client-result.ts";
import type { RecordedResponse } from "./idempotency.ts";
const endpoint = z.url().refine((value) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
export const clientSchema = z.strictObject({
  endpoint: endpoint.optional(),
  token: z.string().min(1).optional(),
});
export interface ClientConfiguration {
  endpoint: string;
  token?: string;
}
export const clientConfigPath = (env = process.env) =>
  join(directories(env).config, "cli.yaml");

export function validateClientEndpoint(value: string): void {
  if (!endpoint.safeParse(value).success)
    throw new Diagnostic(
      "cli.config.invalid_endpoint",
      "endpoint: expected an absolute HTTP(S) URL without credentials, query or fragment.",
    );
}

export function resolveClient(
  options: Partial<ClientConfiguration> = {},
  env: NodeJS.ProcessEnv = process.env,
): ClientConfiguration {
  const path = clientConfigPath(env);
  let stored: z.infer<typeof clientSchema> = {};
  if (audit(path, "file", true)) {
    const result = clientSchema.safeParse(parseMapping(readPrivate(path)));
    if (!result.success)
      throw new Diagnostic(
        "cli.config.invalid",
        "invalid client configuration",
        {
          fields: [["path", path]],
        },
      );
    stored = result.data;
  }
  const resolved = {
    endpoint:
      options.endpoint ??
      env.KANTHORD_ENDPOINT ??
      stored.endpoint ??
      "http://127.0.0.1:31415",
    token: options.token ?? env.KANTHORD_TOKEN ?? stored.token,
  };
  validateClientEndpoint(resolved.endpoint);
  return resolved;
}

function operationUrl(endpoint: string, path: string): URL {
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return new URL(path.slice(1), base);
}

export function httpClient<T extends Record<string, Operation>>(
  operations: T,
  endpoint: string,
  token?: string | (() => string | undefined),
  transport: typeof fetch = fetch,
): ServiceClient<T> {
  return createClient(operations, async (operation, raw, options) => {
    const parsed = operation.input.safeParse(raw);
    if (!parsed.success) return inputValidationFailure(parsed.error);
    const input = parsed.data as {
      params: Record<string, unknown>;
      query: Record<string, unknown>;
      body: unknown;
    };
    const path = operation.path.replace(/:([^/]+)/g, (_, key: string) =>
      encodeURIComponent(String(input.params[key])),
    );
    const url = operationUrl(endpoint, path);
    for (const [key, value] of Object.entries(input.query))
      for (const entry of Array.isArray(value) ? value : [value])
        if (entry !== undefined) url.searchParams.append(key, String(entry));
    const headers = new Headers();
    const bearer = isString(token) ? token : token?.();
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
    if (options.idempotencyKey)
      headers.set("Idempotency-Key", options.idempotencyKey);
    if (options.traceparent) headers.set("traceparent", options.traceparent);
    if (options.tracestate) headers.set("tracestate", options.tracestate);
    if (operation.body) headers.set("Content-Type", "application/json");
    const context = new CancellationContext(
      options.context ?? background,
      Date.now() + operation.timeoutMs + 1000,
    );
    const dispose = () => context.cancel();
    let streaming = false;
    try {
      const response = await transport(url, {
        method: operation.method,
        headers,
        ...(operation.body ? { body: JSON.stringify(input.body) } : {}),
        signal: context.signal,
        redirect: "error",
      });
      if (operation.lifetime === OperationLifetime.Stream && response.ok) {
        const body = retainResponse(response, dispose);
        streaming = true;
        return { status: response.status, body };
      }
      return {
        status: response.status,
        body:
          response.status === HttpStatus.NoContent
            ? null
            : operation.contentType && response.ok
              ? await response.text()
              : await response.json(),
      };
    } finally {
      if (!streaming) dispose();
    }
  });
}

export async function readServerVersion(
  client: ServiceClient<Pick<typeof gatewayOperations, "openapi">>,
  options?: ClientOptions,
): Promise<string | Diagnostic> {
  const unavailable = () =>
    new Diagnostic(
      "gateway.client.version_unavailable",
      "Cannot read a valid package version from the server OpenAPI index.",
    );
  const result = await client.openapi(
    { params: {}, query: {}, body: null },
    options,
  );
  if (result.type !== OperationResultType.Completed) return unavailable();
  try {
    const parsed = z
      .object({ info: z.object({ version: z.string().min(1) }) })
      .safeParse(parseMapping(result.data));
    return parsed.success ? parsed.data.info.version : unavailable();
  } catch {
    return unavailable();
  }
}

function retainResponse(response: Response, dispose: () => void): Response {
  if (!response.body) {
    dispose();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          dispose();
        } else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        dispose();
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } finally {
        dispose();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}

const queryValue = z.union([z.string(), z.array(z.string())]);
export const portCallSchema = z.strictObject({
  call_id: z.string().min(1),
  operation_id: z.string().min(1),
  params: z.record(z.string(), z.string()),
  query: z.record(z.string(), queryValue),
  body: z.string().nullable(),
  idempotency_key: z.string().optional(),
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});
export type PortCall = z.infer<typeof portCallSchema>;
export const portCancelSchema = z.strictObject({
  call_id: z.string().min(1),
  cancel: z.literal(true),
});
export const portAnswerSchema = z.strictObject({
  call_id: z.string().min(1),
  status: z.number().int(),
  body: z.unknown(),
});
export type PortAnswer = z.infer<typeof portAnswerSchema>;

const SINGLE_QUERY_VALUE_COUNT = 1;
const PORT_CLOSED = "The port is closed.";

function wireQuery(query: Record<string, unknown>): PortCall["query"] {
  const wire: PortCall["query"] = {};
  for (const [key, value] of Object.entries(query)) {
    const entries = (Array.isArray(value) ? value : [value])
      .filter((entry) => entry !== undefined)
      .map(String);
    if (!entries.length) continue;
    Object.defineProperty(wire, key, {
      value:
        entries.length === SINGLE_QUERY_VALUE_COUNT ? entries[0]! : entries,
      enumerable: true,
    });
  }
  return wire;
}

export function portCaller(port: MessagePort) {
  const pending = new Map<
    string,
    { resolve(answer: RecordedResponse): void; reject(error: Error): void }
  >();
  let closed = false;
  port.on("message", (message: unknown) => {
    const answer = portAnswerSchema.safeParse(message);
    if (!answer.success) return;
    const waiting = pending.get(answer.data.call_id);
    pending.delete(answer.data.call_id);
    waiting?.resolve({ status: answer.data.status, body: answer.data.body });
  });
  port.on("close", () => {
    closed = true;
    for (const waiting of pending.values())
      waiting.reject(new Error(PORT_CLOSED));
    pending.clear();
  });
  return (
    operation: Operation,
    raw: unknown,
    options: ClientOptions,
  ): Promise<RecordedResponse> => {
    if (closed) return Promise.reject(new Error(PORT_CLOSED));
    const parsed = operation.input.safeParse(raw);
    if (!parsed.success)
      return Promise.resolve(inputValidationFailure(parsed.error));
    const input = parsed.data as {
      params: Record<string, unknown>;
      query: Record<string, unknown>;
      body: unknown;
    };
    const callId = ulid();
    const params = Object.fromEntries(
      [...operation.path.matchAll(/:([^/]+)/g)].map(([, key]) => [
        key!,
        String(input.params[key!]),
      ]),
    );
    const context = new CancellationContext(
      options.context ?? background,
      Date.now() + operation.timeoutMs + 1000,
    );
    if (context.signal.aborted) return Promise.reject(context.signal.reason);
    return new Promise<RecordedResponse>((resolve, reject) => {
      const settle = () => {
        pending.delete(callId);
        cancellation[Symbol.dispose]();
        context.cancel();
      };
      const cancellation = addAbortListener(context.signal, () => {
        if (!pending.has(callId)) return;
        pending.delete(callId);
        port.postMessage({ call_id: callId, cancel: true });
        reject(context.signal.reason);
      });
      pending.set(callId, {
        resolve: (answer) => {
          settle();
          resolve(answer);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      port.postMessage({
        call_id: callId,
        operation_id: operation.id,
        params,
        query: wireQuery(input.query),
        body: operation.body ? (JSON.stringify(input.body) ?? null) : null,
        idempotency_key: options.idempotencyKey,
        traceparent: options.traceparent,
        tracestate: options.tracestate,
      } satisfies PortCall);
    });
  };
}
