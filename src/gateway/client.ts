import type { Operation, ServiceClient } from "../kernel/operation.ts";
import {
  abortSignal,
  background,
  CancellationContext,
} from "../kernel/context.ts";
import { resolveRequestId } from "./request-id.ts";
import { createClient } from "./client-result.ts";
export function httpClient<T extends Record<string, Operation>>(
  operations: T,
  endpoint: string,
  token?: string,
  transport: typeof fetch = fetch,
): ServiceClient<T> {
  return createClient(operations, async (operation, raw, options) => {
    const parsed = operation.input.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 400,
        body: {
          error: {
            code: "gateway.request.validation_failed",
            message: "Request validation failed.",
            details: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String),
              code: issue.code,
            })),
          },
          requestId: resolveRequestId(),
        },
      };
    }
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
    try {
      const response = await transport(url, {
        method: operation.method,
        headers,
        ...(operation.body ? { body: JSON.stringify(input.body) } : {}),
        signal: native.signal,
        redirect: "error",
      });
      return {
        status: response.status,
        body:
          operation.contentType && response.ok
            ? await response.text()
            : await response.json(),
      };
    } finally {
      native.dispose();
      context.cancel();
    }
  });
}
