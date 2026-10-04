import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { matchedRoutes } from "hono/route";
import { timeout } from "hono/timeout";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "hono/serve-static";
import {
  createAdaptorServer,
  type ServerType,
  type HttpBindings,
} from "@hono/node-server";
import { performance } from "node:perf_hooks";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import {
  HealthStatus,
  lifecycle,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import { HealthRegistry } from "../kernel/health.ts";
import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import type { GatewayConfig } from "./config.ts";
import { Diagnostic, asError } from "../kernel/errors.ts";
import type { Authentication } from "./authentication.ts";
import { GatewayError, respondError } from "./errors.ts";
import type { Idempotency } from "./idempotency.ts";
import type { Invocation } from "./invocation.ts";
import { parseJSON } from "./json.ts";
import { gatewayOperations, type InventoryCollector } from "./contract.ts";
import { registerGatewayOperations } from "./declarations.ts";
import { AccessPolicy, OperationLifetime } from "../kernel/operation.ts";
import { HttpMethod, HttpStatus, MediaType } from "../kernel/http.ts";
import { isString } from "../kernel/values.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import { resolveRequestId } from "./request-id.ts";

const SERVER_NOT_RUNNING = "ERR_SERVER_NOT_RUNNING";
const SINGLE_QUERY_VALUE_COUNT = 1;
import { GATEWAY_STARTED_MESSAGE } from "./constants.ts";

export interface GatewayDependencies {
  config: GatewayConfig;
  logger: Logger;
  registry: OperationRegistry;
  invocation: Invocation;
  health?: HealthRegistry;
}

export class GatewayService implements Service {
  readonly app: Hono<{ Bindings: HttpBindings }>;
  readonly registry: OperationRegistry;
  readonly health: HealthRegistry;
  readonly invocation: Invocation;
  readonly authentication: Authentication;
  private readonly idempotency: Idempotency;
  private readonly shutdown = new CancellationContext();
  private readonly options: GatewayDependencies;
  private listener?: ServerType;
  private ready = false;
  private started = false;
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private quiesceTask?: Promise<Error | null>;
  private closeTask?: Promise<Error | null>;
  private readonly stopped = Promise.withResolvers<Error | null>();
  private readonly httpPending = new Set<Promise<unknown>>();

  constructor(options: GatewayDependencies) {
    this.options = options;
    this.registry = options.registry;
    this.invocation = options.invocation;
    this.authentication = options.invocation.authentication;
    this.idempotency = options.invocation.idempotency;
    this.health = options.health ?? new HealthRegistry();
    this.health.register("gateway", () => this.healthcheck());
    this.app = this.createApp();
  }

  declare(
    registry: OperationRegistry,
    collect: InventoryCollector,
    logger: Logger,
  ): void {
    registerGatewayOperations(
      registry,
      (context) => this.health.check(context),
      collect,
      logger,
    );
  }

  address(): AddressInfo | undefined {
    const address = this.listener?.address();
    return address && !isString(address) ? address : undefined;
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          "gateway.lifecycle.stopped",
          "gateway: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= lifecycle(() => this.open());
    return this.startTask;
  }

  private async open(): Promise<void> {
    this.registerRoutes();
    const server = createAdaptorServer({
      fetch: (request, env) => this.app.fetch(request, env as HttpBindings),
    });
    this.listener = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const error = () =>
          reject(
            new Diagnostic(
              "gateway.listener.bind_failed",
              `gateway: cannot bind ${this.options.config.bind}:${this.options.config.port}.`,
            ),
          );
        server.once("error", error);
        server.listen(
          this.options.config.port,
          this.options.config.bind,
          () => {
            server.off("error", error);
            resolve();
          },
        );
      });
      // A listener failure after startup is fatal, rather than silently restarting.
      server.on("error", (error) => {
        throw error;
      });
      throwIfCancelled(this.shutdown);
      this.ready = true;
      this.started = true;
      this.options.logger.info(
        {
          address: this.options.config.bind,
          port: this.address()?.port,
        },
        GATEWAY_STARTED_MESSAGE,
      );
    } catch (error) {
      this.ready = false;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.listener = undefined;
      throw error;
    }
  }

  quiesce(): Promise<Error | null> {
    if (this.quiesceTask) return this.quiesceTask;
    this.quiesceTask = lifecycle(async () => {
      this.ready = false;
      this.shutdown.cancel();
      this.closeTask = new Promise<Error | null>((resolve) => {
        if (!this.listener || !this.started) return resolve(null);
        this.listener.close((error?: NodeJS.ErrnoException) =>
          resolve(error?.code === SERVER_NOT_RUNNING ? null : (error ?? null)),
        );
        if ("closeIdleConnections" in this.listener)
          this.listener.closeIdleConnections();
      }).catch(asError);
    });
    return this.quiesceTask;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.httpPending);
  }

  stop(): Promise<Error | null> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = lifecycle(async () => {
      try {
        const quiesceError = await this.quiesce();
        await this.startTask;
        await this.drain();
        const error = await this.closeTask;
        if (error || quiesceError) throw error ?? quiesceError;
      } finally {
        this.started = false;
        this.listener = undefined;
      }
    }).then((error) => {
      this.stopped.resolve(error);
      return error;
    });
    return this.stopTask;
  }

  async run(context: Context = background): Promise<Error | null> {
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) {
        const cleanup = await this.stop();
        return cleanup
          ? new AggregateError(
              [error, cleanup],
              "Gateway start and cleanup failed.",
            )
          : error;
      }
      return (await this.stopped.promise) ?? context.err();
    } finally {
      unsubscribe();
    }
  }

  async healthcheck(): Promise<Healthcheck> {
    const ready = this.ready && this.started && !this.shutdown.err();
    return {
      listener:
        ready && this.listener?.listening
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
      authentication:
        ready && (await this.authentication.healthcheck())
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
      idempotency:
        ready && this.idempotency.healthcheck()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
      registry:
        ready && this.registry.healthcheck()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
      invocation:
        ready && this.invocation.healthcheck()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }

  private createApp(): Hono<{ Bindings: HttpBindings }> {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.use(
      "*",
      requestId({
        headerName: "X-Request-Id",
        generator: () => resolveRequestId(),
      }),
    );
    app.use("*", async (context, next) => {
      // Hono accepts arbitrary short IDs; enforce our entity format before use.
      const id = resolveRequestId(context.get("requestId"));
      context.set("requestId", id);
      context.header("X-Request-Id", id);
      const logger = this.options.logger.child({
        requestId: id,
        method: context.req.method,
        route: matchedRoutes(context).at(-1)?.path ?? "unmatched",
      });
      const start = performance.now();
      logger.info("Request started");
      try {
        await next();
      } finally {
        logger.info(
          { status: context.res.status, latency: performance.now() - start },
          "Request finished",
        );
      }
    });
    app.use("*", async (context, next) => {
      const host = context.req.header("host");
      if (
        !host ||
        !this.options.config.allowedHosts.includes(host.toLowerCase())
      )
        return respondError(
          new GatewayError(
            403,
            "gateway.http.host_not_allowed",
            "Host is not allowed.",
          ),
          context.get("requestId"),
        );
      if (!this.ready)
        return respondError(
          new GatewayError(
            503,
            "gateway.lifecycle.not_ready",
            "Server is not ready.",
          ),
          context.get("requestId"),
        );
      await next();
    });
    // Check that a preflight names a registered route before CORS answers it.
    app.use("*", async (context, next) => {
      if (context.req.method === HttpMethod.Options) {
        const method = context.req.header("access-control-request-method");
        const found = this.registry.all().some(
          ({ operation }) =>
            operation.method === method &&
            new RegExp(
              `^${operation.path
                .split("/")
                .map((part) =>
                  part.startsWith(":")
                    ? "[^/]+"
                    : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                )
                .join("/")}$`,
            ).test(context.req.path),
        );
        if (!found)
          return respondError(
            new GatewayError(
              404,
              "gateway.routing.not_found",
              "Route not found.",
            ),
            context.get("requestId"),
          );
      }
      return cors({
        origin: this.options.config.allowedOrigins,
        credentials: false,
        allowMethods: Object.values(HttpMethod),
        allowHeaders: [
          "Authorization",
          "Content-Type",
          "Idempotency-Key",
          "X-Request-Id",
          "traceparent",
          "tracestate",
        ],
        exposeHeaders: ["X-Request-Id"],
      })(context, next);
    });
    app.onError((error, context) =>
      respondError(
        error instanceof HTTPException
          ? new GatewayError(
              error.status,
              error.status === HttpStatus.GatewayTimeout
                ? "gateway.invocation.timeout"
                : "gateway.http.failed",
              error.status === HttpStatus.GatewayTimeout
                ? "Request timed out; the operation may still complete."
                : "HTTP request failed.",
            )
          : error,
        context.get("requestId"),
      ),
    );
    app.notFound((context) =>
      respondError(
        new GatewayError(404, "gateway.routing.not_found", "Route not found."),
        context.get("requestId"),
      ),
    );
    return app;
  }

  private registerRoutes(): void {
    for (const { operation } of this.registry.all()) {
      const maxSize =
        operation.maxBodyBytes ??
        (operation.path.startsWith("/api/auth/")
          ? 40 * 1024
          : operation.access === AccessPolicy.Delivery
            ? 50 * 1024 * 1024
            : 10 * 1024 * 1024);
      this.app.on(
        operation.method,
        operation.path,
        timeout(operation.timeoutMs),
        bodyLimit({
          maxSize,
          onError: (context) =>
            respondError(
              new GatewayError(
                413,
                "gateway.request.body_too_large",
                "Request body exceeds the route limit.",
              ),
              context.get("requestId"),
            ),
        }),
        async (context) => {
          const requestContext = new CancellationContext(this.shutdown);
          const outgoing = context.env?.outgoing;
          const onAbort = () => requestContext.cancel();
          context.req.raw.signal.addEventListener("abort", onAbort, {
            once: true,
          });
          if (context.req.raw.signal.aborted) onAbort();
          const cleanup = () => {
            context.req.raw.signal.removeEventListener("abort", onAbort);
            outgoing?.off("close", onClose);
            requestContext.cancel();
          };
          const onClose = () => {
            cleanup();
          };
          outgoing?.once("close", onClose);
          const work = (async () => {
            let body: unknown = null;
            let delivery;
            let rejection: GatewayError | undefined;
            if (operation.delivery)
              delivery = {
                bytes: await context.req.arrayBuffer(),
                headers: new Headers(context.req.raw.headers),
              };
            else if (operation.body) {
              if (
                context.req
                  .header("content-type")
                  ?.split(";")[0]
                  ?.trim()
                  .toLowerCase() !== MediaType.JSON
              )
                rejection = new GatewayError(
                  415,
                  "gateway.request.unsupported_media_type",
                  "Request body requires application/json.",
                );
              else
                try {
                  body = parseJSON(await context.req.text());
                } catch (error) {
                  if (!(error instanceof GatewayError)) throw error;
                  rejection = error;
                }
            } else if (
              context.req.raw.body &&
              operation.lifetime !== OperationLifetime.Stream
            ) {
              if ((await context.req.text()).length)
                rejection = new GatewayError(
                  400,
                  "gateway.request.unexpected_body",
                  "This operation accepts no request body.",
                );
            }
            const query: Record<string, string | string[]> = {};
            for (const [key, values] of Object.entries(context.req.queries()))
              Object.defineProperty(query, key, {
                value:
                  values.length === SINGLE_QUERY_VALUE_COUNT
                    ? values[0]!
                    : values,
                enumerable: true,
              });
            const result = await this.invocation.invoke(
              operation.id,
              { params: context.req.param(), query, body },
              {
                authorization: context.req.header("authorization"),
                idempotencyKey: context.req.header("idempotency-key"),
                requestId: context.get("requestId"),
                context: requestContext,
                delivery,
                rejection,
                request: context.req.raw,
                traceparent: context.req.header("traceparent"),
                tracestate: context.req.header("tracestate"),
              },
            );
            if (result.body instanceof Response) return result.body;
            if (result.status === HttpStatus.NoContent)
              return new Response(null, { status: result.status });
            if (operation.contentType && result.status === operation.status) {
              if (
                operation.id === gatewayOperations.openapi.id ||
                operation.id === gatewayOperations.openapiFile.id
              ) {
                // Serve the package asset through Hono's static-file adapter.
                const response = await serveStatic({
                  path: "openapi.yaml",
                  mimes: { yaml: "application/yaml" },
                  getContent: async () => String(result.body),
                })(context, async () => {});
                return response ?? context.res;
              }
              return new Response(String(result.body), {
                status: result.status,
                headers: { "Content-Type": operation.contentType },
              });
            }
            return Response.json(result.body, { status: result.status });
          })();
          this.httpPending.add(work);
          try {
            return await work;
          } finally {
            this.httpPending.delete(work);
            // Streaming responses retain their disconnect subscription until close.
            if (operation.lifetime !== OperationLifetime.Stream) cleanup();
          }
        },
      );
    }
  }
}
