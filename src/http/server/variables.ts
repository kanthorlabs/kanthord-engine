import type { Context } from "hono";

import type { ActorRow } from "../../domain/actor.ts";
import type { RouteMatch } from "../contract/registry.ts";
import type { HandlerResult } from "./app.ts";
import type { StoredAnswer } from "./idempotency-response.ts";

export type Variables = {
  headers: Headers;
  match: RouteMatch;
  actor: ActorRow;
  allowedOrigin: string;
  rawBody: string;
  body: unknown;
  result: HandlerResult;
  replay: StoredAnswer;
};

export type AppEnv = { Variables: Variables };

export class VariableError extends Error {}

type OptionalVariable =
  "allowedOrigin" | "rawBody" | "body" | "result" | "replay";

export function demand<Name extends keyof Variables>(
  c: Context<AppEnv>,
  name: Name,
): Variables[Name] {
  const value = c.get(name) as Variables[Name] | undefined;
  if (value === undefined) {
    throw new VariableError(`the ${name} variable is absent`);
  }
  return value;
}

export function optional<Name extends OptionalVariable>(
  c: Context<AppEnv>,
  name: Name,
): Variables[Name] | undefined {
  return c.get(name);
}
