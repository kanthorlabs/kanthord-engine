import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";
import { idempotencyOf } from "../contract/operation.ts";
import type { AuthenticatedState } from "./auth.ts";
import type { RoutedState } from "./route.ts";
import { materializeError } from "./envelope.ts";
import { classifyOutcome } from "./idempotency-record.ts";
import {
  captureAnswer,
  headerSnapshot,
  applyAnswer,
} from "./idempotency-response.ts";
import {
  fingerprint,
  readIdempotencyKey,
  recordKey,
} from "./idempotency-key.ts";
import { IdempotencyStore } from "./idempotency-store.ts";
import type { IdempotencySettings, Schedule } from "./idempotency-store.ts";

export type IdempotencyDependencies = Readonly<{
  settings: IdempotencySettings;
  now: () => number;
  schedule: Schedule;
}>;

export type Idempotency = Readonly<{
  middleware: (context: Context, next: Next) => Promise<void>;
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

  const middleware = async (context: Context, next: Next): Promise<void> => {
    const match = (context.state as RoutedState).match;
    const read = readIdempotencyKey(context.req);

    if (read.kind === "invalid") {
      throw httpError("invalid-request", read.message);
    }

    if (read.kind === "absent") {
      await next();
      return;
    }

    const policy = idempotencyOf(match.operation);

    if (policy === "none") {
      await next();
      return;
    }

    if (policy === "durable") {
      const body = context.request.body;
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

    const print = fingerprint({
      method: context.method,
      path: context.path,
      query: context.querystring,
      rawBody: context.request.rawBody ?? "",
    });
    const key = recordKey({
      operationId: match.operation.operationId,
      parameters: match.parameters,
      actorId: (context.state as AuthenticatedState).actor.id,
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
      applyAnswer(context, outcome.answer);
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
      applyAnswer(context, joined.answer);
      return;
    }

    const before = headerSnapshot(context);
    try {
      await next();
      const answer = captureAnswer(
        context,
        before,
        context.status,
        context.body,
      );
      outcome.settle(
        answer,
        classifyOutcome({
          replayable: match.operation.replayable,
          status: context.status,
          internal: false,
        }),
      );
    } catch (error: unknown) {
      const materialized = materializeError(error);
      const answer = captureAnswer(
        context,
        before,
        materialized.status,
        materialized.body,
      );
      outcome.settle(
        answer,
        classifyOutcome({
          replayable: match.operation.replayable,
          status: materialized.status,
          internal: materialized.internal,
        }),
      );
      throw error;
    }
  };

  return { middleware, store };
}
