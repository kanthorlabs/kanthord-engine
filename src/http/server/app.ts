import { Hono } from "hono";

import type { ActorRow } from "../../domain/actor.ts";
import type { Operation } from "../contract/operation.ts";
import { registry } from "../contract/registry.ts";
import { authMiddleware } from "./auth.ts";
import { authorizeMiddleware } from "./authorize.ts";
import { bodyMiddleware } from "./body.ts";
import { dispatchMiddleware } from "./dispatch.ts";
import { errorResponse, errorValue, materializeError } from "./envelope.ts";
import type { WaitRegistry } from "./event/wait.ts";
import { headersMiddleware } from "./headers.ts";
import { hostMiddleware } from "./host.ts";
import { createIdempotency } from "./idempotency.ts";
import { defaultIdempotencySettings } from "./idempotency-store.ts";
import type { IdempotencySettings, Schedule } from "./idempotency-store.ts";
import { originMiddleware } from "./origin.ts";
import { preflightMiddleware } from "./preflight.ts";
import { renderMiddleware } from "./render.ts";
import { routeMiddleware } from "./route.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

export type TransportSettings = Readonly<{
  token: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}>;

export type HandlerContext = Readonly<{
  operation: Operation;
  parameters: Readonly<Record<string, string>>;
  query: Readonly<Record<string, readonly string[]>>;
  headers: Readonly<Record<string, string>>;
  body: unknown;
  actor: ActorRow;
}>;

export const handlerStatuses = [200, 204, 206, 304] as const;
export const bodylessStatuses = [204, 304] as const;
export type HandlerStatus = (typeof handlerStatuses)[number];
export type BodylessStatus = (typeof bodylessStatuses)[number];
export type BodyStatus = Exclude<HandlerStatus, BodylessStatus>;

export type JsonResult = Readonly<{
  kind: "json";
  status: BodyStatus;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

export type BytesResult = Readonly<{
  kind: "bytes";
  status: BodyStatus;
  bytes: Uint8Array;
  headers?: Readonly<Record<string, string>>;
}>;

export type EmptyResult = Readonly<{
  kind: "empty";
  status: BodylessStatus;
  headers?: Readonly<Record<string, string>>;
}>;

export type HandlerResult = JsonResult | BytesResult | EmptyResult;

export type Handler = (
  context: HandlerContext,
) => HandlerResult | Promise<HandlerResult>;

export type AppDependencies = Readonly<{
  settings: TransportSettings;
  handlers: Readonly<Record<string, Handler>>;
  unimplemented: readonly string[];
  onInternalError: (error: unknown) => void;
  resolveActor: (presented: string) => ActorRow | null;
  idempotency?: IdempotencySettings;
  now?: () => number;
  schedule?: Schedule;
  waits: WaitRegistry;
}>;

export const systemSchedule: Schedule = (milliseconds, callback) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};

export class BindingError extends Error {}

export type App = Readonly<{
  hono: Hono<AppEnv>;
  cancelWaits: () => void;
}>;

export function createApp(dependencies: AppDependencies): App {
  const offenders = bindingOffenders(dependencies);
  if (offenders.length > 0) {
    throw new BindingError(
      `incomplete transport binding: ${offenders.join(", ")}`,
    );
  }

  const hono = new Hono<AppEnv>();
  hono.onError((error, c) => {
    const value = errorValue(error);
    const materialized = materializeError(value);
    if (materialized.internal) {
      dependencies.onInternalError(value);
    }
    return errorResponse(materialized, demand(c, "headers"));
  });
  hono.use("*", headersMiddleware());
  hono.use("*", renderMiddleware());
  hono.use(
    "*",
    originMiddleware({ allowedOrigins: dependencies.settings.allowedOrigins }),
  );
  hono.use(
    "*",
    hostMiddleware({ allowedHosts: dependencies.settings.allowedHosts }),
  );
  hono.use("*", preflightMiddleware());
  hono.use(
    "*",
    authMiddleware({
      token: dependencies.settings.token,
      resolveActor: dependencies.resolveActor,
    }),
  );
  hono.use("*", routeMiddleware());
  hono.use("*", authorizeMiddleware());
  hono.use("*", bodyMiddleware(dependencies.handlers));
  hono.use(
    "*",
    createIdempotency({
      settings: dependencies.idempotency ?? defaultIdempotencySettings,
      now: dependencies.now ?? (() => Date.now()),
      schedule: dependencies.schedule ?? systemSchedule,
    }).middleware,
  );
  hono.all("*", dispatchMiddleware({ handlers: dependencies.handlers }));

  return {
    hono,
    cancelWaits: () => {
      dependencies.waits.cancelAll();
    },
  };
}

export function unimplementedFor(
  handlers: Readonly<Record<string, Handler>>,
): readonly string[] {
  return registry
    .filter((entry) => entry.status === "routed")
    .map((entry) => entry.operationId)
    .filter((operationId) => !(operationId in handlers));
}

export function bindingOffenders(dependencies: AppDependencies): string[] {
  const offenders: string[] = [];
  for (const entry of registry) {
    if (entry.status !== "routed") {
      continue;
    }
    const hasHandler = entry.operationId in dependencies.handlers;
    const isDeclared = dependencies.unimplemented.includes(entry.operationId);
    if (!hasHandler && !isDeclared) {
      offenders.push(entry.operationId);
    }
    if (hasHandler && isDeclared) {
      offenders.push(entry.operationId);
    }
  }
  for (const operationId of [
    ...Object.keys(dependencies.handlers),
    ...dependencies.unimplemented,
  ]) {
    const entry = registry.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (entry === undefined || entry.status === "stubbed") {
      offenders.push(operationId);
    }
  }
  return offenders;
}
