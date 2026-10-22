import { addAbortListener } from "node:events";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { matchedRoutes } from "hono/route";
import { timeout } from "hono/timeout";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "hono/serve-static";
import { getPath } from "hono/utils/url";
import {
  createAdaptorServer,
  type ServerType,
  type HttpBindings,
} from "@hono/node-server";
import { performance } from "node:perf_hooks";
import { BlockList, isIPv6, type AddressInfo } from "node:net";
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
  type Context,
  reasonOf,
} from "../kernel/context.ts";
import type { GatewayConfig } from "./config.ts";
import { Diagnostic, asError } from "../kernel/errors.ts";
import type { Authentication } from "./auth/authentication.ts";
import { GatewayError, respondError } from "./errors.ts";
import type { Idempotency } from "./idempotency.ts";
import type { Invocation } from "./invocation.ts";
import { bodyLimitOf } from "./body-limit.ts";
import { parseJSON } from "./json.ts";
import { gatewayOperations, type InventoryCollector } from "./contract.ts";
import { registerGatewayOperations } from "./declarations.ts";
import {
  AccessPolicy,
  hasHttpRoute,
  OperationLifetime,
  type Operation,
} from "../kernel/operation.ts";
import { isWorkerIdentity } from "../kernel/caller.ts";
import { HttpMethod, HttpStatus, MediaType } from "../kernel/http.ts";
import { isString } from "../kernel/values.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import { resolveRequestId } from "./request-id.ts";

const SERVER_NOT_RUNNING = "ERR_SERVER_NOT_RUNNING";
const SINGLE_QUERY_VALUE_COUNT = 1;
import { GATEWAY_STARTED_MESSAGE } from "./constants.ts";
import { dashboardResponse, type DashboardLoader } from "./dashboard.ts";
import { ROOT_BASE_PATH, baseHref, stripBasePath } from "./base-path.ts";
import { dashboardAsset } from "../kernel/assets.ts";

const HOST_DETAIL_LIMIT = 255;
const ALLOWED_HOSTS_FIELD = "gateway.allowed_hosts";
const LOOPBACK_BIND_SENTENCE =
  "A loopback bind accepts connections from this host only.";
const IPV4_LOOPBACK_NETWORK = "127.0.0.0";
const IPV4_LOOPBACK_PREFIX_LENGTH = 8;
const IPV6_LOOPBACK_ADDRESS = "::1";
const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet(
  IPV4_LOOPBACK_NETWORK,
  IPV4_LOOPBACK_PREFIX_LENGTH,
  "ipv4",
);
loopbackAddresses.addAddress(IPV6_LOOPBACK_ADDRESS, "ipv6");

function startedMessage(bind: string): string {
  return loopbackAddresses.check(bind, isIPv6(bind) ? "ipv6" : "ipv4")
    ? `${GATEWAY_STARTED_MESSAGE}. ${LOOPBACK_BIND_SENTENCE}`
    : GATEWAY_STARTED_MESSAGE;
}

export interface GatewayDependencies {
  config: GatewayConfig;
  logger: Logger;
  registry: OperationRegistry;
  invocation: Invocation;
  health?: HealthRegistry;
  dashboard?: DashboardLoader;
}

const PARAMETER_PREFIX = ":";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const CONNECTION_HEADER = "Connection";
const CONNECTION_CLOSE = "close";
const FIRST_ROUTE = 0;

export function compareRouteSpecificity(left: string, right: string): number {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const leftParameter = leftParts[index]!.startsWith(PARAMETER_PREFIX);
    const rightParameter = rightParts[index]!.startsWith(PARAMETER_PREFIX);
    if (leftParameter !== rightParameter) return leftParameter ? 1 : -1;
  }
  return 0;
}

function routePattern(path: string): RegExp {
  return new RegExp(
    `^${path
      .split("/")
      .map((part) =>
        part.startsWith(PARAMETER_PREFIX)
          ? "[^/]+"
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/")}$`,
  );
}

const HOST_CHECK_FREE_POLICIES: readonly AccessPolicy[] = [
  AccessPolicy.Client,
  AccessPolicy.Worker,
  AccessPolicy.Public,
];

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

  private routeOf(method: string, path: string): Operation | undefined {
    return this.registry
      .all()
      .map(({ operation }) => operation)
      .filter(
        (operation) =>
          hasHttpRoute(operation) &&
          operation.method === method &&
          routePattern(operation.path).test(path),
      )
      .sort((left, right) => compareRouteSpecificity(left.path, right.path))
      .at(FIRST_ROUTE);
  }

  private async skipsHostCheck(
    method: string,
    path: string | undefined,
    authorization: string | undefined,
  ): Promise<boolean> {
    if (path === undefined) return false;
    const operation = this.routeOf(method, path);
    if (!operation) return false;
    if (HOST_CHECK_FREE_POLICIES.includes(operation.access)) return true;
    if (operation.access !== AccessPolicy.HumanOrWorker) return false;
    try {
      return isWorkerIdentity(
        await this.authentication.authenticate(authorization),
      );
    } catch {
      return false;
    }
  }

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
    if (this.shutdown.signal.aborted)
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
              "gateway: cannot bind the listener address.",
              {
                fields: [
                  ["bind", this.options.config.bind],
                  ["port", this.options.config.port],
                ],
              },
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
      this.shutdown.signal.throwIfAborted();
      this.ready = true;
      this.started = true;
      this.options.logger.info(
        {
          bind: this.options.config.bind,
          port: this.address()?.port,
        },
        startedMessage(this.options.config.bind),
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
        if (this.listener && "closeIdleConnections" in this.listener)
          this.listener.closeIdleConnections();
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
    using cancellation = addAbortListener(context.signal, () => {
      void this.stop();
    });
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
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
    return (await this.stopped.promise) ?? reasonOf(context.signal);
  }

  async healthcheck(): Promise<Healthcheck> {
    const ready = this.ready && this.started && !this.shutdown.signal.aborted;
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
    const basePath = this.options.config.base_path;
    const app = new Hono<{ Bindings: HttpBindings }>({
      getPath: (request) => {
        const path = getPath(request);
        return stripBasePath(basePath, path) ?? path;
      },
    });
    app.use("*", async (context, next) => {
      await next();
      if (this.shutdown.signal.aborted)
        context.header(CONNECTION_HEADER, CONNECTION_CLOSE);
    });
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
        request_id: id,
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
      const host = context.req.header("host")?.toLowerCase();
      if (
        (!host || !this.options.config.allowed_hosts.includes(host)) &&
        !(await this.skipsHostCheck(
          context.req.method,
          stripBasePath(basePath, getPath(context.req.raw)),
          context.req.header("authorization"),
        ))
      )
        return respondError(
          new GatewayError(
            403,
            "gateway.http.host_not_allowed",
            "Host is not allowed. Add it to gateway.allowed_hosts.",
            {
              host: host ? host.slice(0, HOST_DETAIL_LIMIT) : null,
              field: ALLOWED_HOSTS_FIELD,
            },
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
    app.use("*", async (context, next) => {
      if (basePath === ROOT_BASE_PATH) return next();
      const path = getPath(context.req.raw);
      if (path === basePath)
        return context.redirect(
          `${baseHref(basePath)}${new URL(context.req.url).search}`,
          HttpStatus.MovedPermanently,
        );
      if (stripBasePath(basePath, path) === undefined)
        return respondError(
          new GatewayError(
            404,
            "gateway.routing.not_found",
            "Route not found.",
          ),
          context.get("requestId"),
        );
      await next();
    });
    // Check that a preflight names a registered route before CORS answers it.
    app.use("*", async (context, next) => {
      if (context.req.method === HttpMethod.Options) {
        const method = context.req.header("access-control-request-method");
        if (!method || !this.routeOf(method, context.req.path))
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
        origin: this.options.config.allowed_origins,
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
    app.onError((error, context) => {
      if (!(error instanceof HTTPException) && !(error instanceof GatewayError))
        this.options.logger.error(
          { err: error, request_id: context.get("requestId") },
          "Request failed",
        );
      return respondError(
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
      );
    });
    app.notFound(
      (context) =>
        dashboardResponse(
          context.req.method,
          context.req.path,
          basePath,
          this.options.dashboard ?? dashboardAsset,
        ) ??
        respondError(
          new GatewayError(
            404,
            "gateway.routing.not_found",
            "Route not found.",
          ),
          context.get("requestId"),
        ),
    );
    return app;
  }

  private registerRoutes(): void {
    for (const { operation } of this.registry
      .all()
      .filter(({ operation }) => hasHttpRoute(operation))
      .sort((left, right) =>
        compareRouteSpecificity(left.operation.path, right.operation.path),
      )) {
      const maxSize = bodyLimitOf(operation);
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
                host: context.req.header("host"),
                traceparent: context.req.header("traceparent"),
                tracestate: context.req.header("tracestate"),
                logger: this.options.logger,
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
            return Response.json(result.body, {
              status: result.status,
              ...(operation.secret ? { headers: NO_STORE_HEADERS } : {}),
            });
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
