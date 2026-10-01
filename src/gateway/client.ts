import { join } from "node:path";
import { HttpStatus } from "../kernel/http.ts";
import { directories } from "../kernel/xdg.ts";
import { parseMapping } from "../kernel/yaml.ts";
import { audit, readPrivate } from "../kernel/files.ts";
import { z } from "zod";
import { Diagnostic } from "../kernel/errors.ts";
import { gatewayOperations } from "./contract.ts";
import {
  OperationResultType,
  OperationLifetime,
  type ClientOptions,
  type Operation,
  type ServiceClient,
} from "../kernel/operation.ts";
import {
  abortSignal,
  background,
  CancellationContext,
} from "../kernel/context.ts";
import { createClient, inputValidationFailure } from "./client-result.ts";
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
  clientSecret: z.string().optional(),
});
export interface ClientConfiguration {
  endpoint: string;
  token?: string;
  clientSecret?: string;
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
        `${path}: invalid client configuration.`,
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
    clientSecret: stored.clientSecret,
  };
  validateClientEndpoint(resolved.endpoint);
  return resolved;
}

export function httpClient<T extends Record<string, Operation>>(
  operations: T,
  endpoint: string,
  token?: string,
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
    const url = new URL(path, endpoint);
    for (const [key, value] of Object.entries(input.query))
      for (const entry of Array.isArray(value) ? value : [value])
        if (entry !== undefined) url.searchParams.append(key, String(entry));
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.idempotencyKey)
      headers.set("Idempotency-Key", options.idempotencyKey);
    if (options.traceparent) headers.set("traceparent", options.traceparent);
    if (options.tracestate) headers.set("tracestate", options.tracestate);
    if (operation.body) headers.set("Content-Type", "application/json");
    const context = new CancellationContext(
      options.context ?? background,
      Date.now() + operation.timeoutMs + 1000,
    );
    const native = abortSignal(context);
    const dispose = () => {
      native.dispose();
      context.cancel();
    };
    let streaming = false;
    try {
      const response = await transport(url, {
        method: operation.method,
        headers,
        ...(operation.body ? { body: JSON.stringify(input.body) } : {}),
        signal: native.signal,
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
