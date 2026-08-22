import bodyParser from "@koa/bodyparser";
import Koa from "koa";
import type { Context, Next } from "koa";

import type { ActorRow } from "../../domain/actor.ts";
import type { Operation } from "../contract/operation.ts";
import { registry } from "../contract/registry.ts";
import { httpError } from "../contract/errors.ts";
import { authMiddleware } from "./auth.ts";
import { authorizeMiddleware } from "./authorize.ts";
import { dispatchMiddleware } from "./dispatch.ts";
import { envelopeMiddleware } from "./envelope.ts";
import type { WaitRegistry } from "./event/wait.ts";
import { hostMiddleware } from "./host.ts";
import { createIdempotency } from "./idempotency.ts";
import { defaultIdempotencySettings } from "./idempotency-store.ts";
import type { IdempotencySettings, Schedule } from "./idempotency-store.ts";
import { originMiddleware } from "./origin.ts";
import { preflightMiddleware } from "./preflight.ts";
import { routeMiddleware } from "./route.ts";
import type { RoutedState } from "./route.ts";

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

export type HandlerResult = Readonly<{
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

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
  app: Koa;
  cancelWaits: () => void;
}>;

export function createApp(dependencies: AppDependencies): App {
  const offenders = bindingOffenders(dependencies);
  if (offenders.length > 0) {
    throw new BindingError(
      `incomplete transport binding: ${offenders.join(", ")}`,
    );
  }

  const app = new Koa();
  app.use(
    envelopeMiddleware({ onInternalError: dependencies.onInternalError }),
  );
  app.use(
    originMiddleware({ allowedOrigins: dependencies.settings.allowedOrigins }),
  );
  app.use(hostMiddleware({ allowedHosts: dependencies.settings.allowedHosts }));
  app.use(preflightMiddleware());
  app.use(
    authMiddleware({
      token: dependencies.settings.token,
      resolveActor: dependencies.resolveActor,
    }),
  );
  app.use(routeMiddleware());
  app.use(authorizeMiddleware());
  app.use(bodyParserForHandled(dependencies.handlers));
  app.use(
    createIdempotency({
      settings: dependencies.idempotency ?? defaultIdempotencySettings,
      now: dependencies.now ?? (() => Date.now()),
      schedule: dependencies.schedule ?? systemSchedule,
    }).middleware,
  );
  app.use(dispatchMiddleware({ handlers: dependencies.handlers }));
  return {
    app,
    cancelWaits: () => {
      dependencies.waits.cancelAll();
    },
  };
}

function bodyParserForHandled(
  handlers: Readonly<Record<string, Handler>>,
): (context: Context, next: Next) => Promise<void> {
  const parse = bodyParser({ enableTypes: ["json"] });
  return async (context, next) => {
    const match = (context.state as RoutedState).match;
    const hasHandler =
      match.operation.status !== "stubbed" &&
      handlers[match.operation.operationId] !== undefined;
    if (hasHandler) {
      try {
        await parse(context, next);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw httpError(
            "invalid-request",
            "the request body is not valid json",
          );
        }
        throw error;
      }
      return;
    }
    await next();
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
