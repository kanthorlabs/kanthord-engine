import type { Context, MiddlewareHandler, Next } from "hono";

import { httpError } from "../contract/errors.ts";
import { idempotencyOf } from "../contract/operation.ts";
import { errorValue, materializeError } from "./envelope.ts";
import { classifyOutcome } from "./idempotency-record.ts";
import { captureAnswer, headerSnapshot } from "./idempotency-response.ts";
import {
  fingerprint,
  readIdempotencyKey,
  recordKey,
} from "./idempotency-key.ts";
import { IdempotencyStore } from "./idempotency-store.ts";
import type { IdempotencySettings, Schedule } from "./idempotency-store.ts";
import { materializeResult } from "./render.ts";
import type { MaterializedResult } from "./render.ts";
import { demand, optional } from "./variables.ts";
import type { AppEnv } from "./variables.ts";

export type IdempotencyDependencies = Readonly<{
  settings: IdempotencySettings;
  now: () => number;
  schedule: Schedule;
}>;

export type Idempotency = Readonly<{
  middleware: MiddlewareHandler<AppEnv>;
  store: IdempotencyStore;
}>;

export function createIdempotency(
  dependencies: IdempotencyDependencies,
): Idempotency {
  const store = new IdempotencyStore({
    settings: dependencies.settings,
    now: dependencies.now,
    schedule: dependencies.schedule,
  });

  const middleware = async (c: Context<AppEnv>, next: Next): Promise<void> => {
    const read = readIdempotencyKey(c.req.raw.headers);

    if (read.kind === "invalid") {
      throw httpError("invalid-request", read.message);
    }

    if (read.kind === "absent") {
      await next();
      return;
    }

    const match = demand(c, "match");
    const policy = idempotencyOf(match.operation);

    if (policy === "none") {
      await next();
      return;
    }

    if (policy === "durable") {
      const body = optional(c, "body");
      const importId =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>).importId
          : undefined;

      if (importId !== read.key) {
        throw httpError(
          "invalid-request",
          "Idempotency-Key must equal importId",
        );
      }

      await next();
      return;
    }

    if (dependencies.settings.ttlSeconds === 0) {
      await next();
      return;
    }

    const url = new URL(c.req.url);
    const print = fingerprint({
      method: c.req.method,
      path: url.pathname,
      query: url.search.slice(1),
      rawBody: optional(c, "rawBody") ?? "",
    });
    const key = recordKey({
      operationId: match.operation.operationId,
      parameters: match.parameters,
      actorId: demand(c, "actor").id,
      key: read.key,
    });
    const outcome = store.reserve(key, print);

    if (outcome.kind === "saturated") {
      throw httpError(
        "service-unavailable",
        "the idempotency cache is full of in-flight requests",
      );
    }

    if (outcome.kind === "mismatch") {
      throw httpError(
        "idempotency-mismatch",
        "the Idempotency-Key was reused with a different request",
        { operationId: match.operation.operationId, key: read.key },
      );
    }

    if (outcome.kind === "replay") {
      c.set("replay", outcome.answer);
      return;
    }

    if (outcome.kind === "joined") {
      const joined = await outcome.outcome;
      if (joined.kind === "timeout") {
        throw httpError(
          "service-unavailable",
          "the original request under this Idempotency-Key is still running",
        );
      }
      c.set("replay", joined.answer);
      return;
    }

    const headers = demand(c, "headers");
    const before = headerSnapshot(headers);
    await next();

    if (c.error !== undefined) {
      const materialized = materializeError(errorValue(c.error));
      const answer = captureAnswer(
        headers,
        before,
        materialized.status,
        JSON.stringify(materialized.body),
      );
      outcome.settle(
        answer,
        classifyOutcome({
          replayable: match.operation.replayable,
          status: materialized.status,
          internal: materialized.internal,
        }),
      );
      return;
    }

    const result = demand(c, "result");
    let materialized: MaterializedResult;
    try {
      materialized = materializeResult(result, match.operation, headers);
    } catch (failure: unknown) {
      const refused = materializeError(failure);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      const answer = captureAnswer(
        headers,
        before,
        refused.status,
        JSON.stringify(refused.body),
      );
      outcome.settle(
        answer,
        classifyOutcome({
          replayable: match.operation.replayable,
          status: refused.status,
          internal: refused.internal,
        }),
      );
      throw failure;
    }
    const answer = captureAnswer(
      headers,
      before,
      materialized.status,
      materialized.body,
    );
    outcome.settle(
      answer,
      classifyOutcome({
        replayable: match.operation.replayable,
        status: materialized.status,
        internal: false,
      }),
    );
    c.set("replay", answer);
  };

  return { middleware, store };
}
