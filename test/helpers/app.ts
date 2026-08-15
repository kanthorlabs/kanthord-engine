import type supertest from "supertest";

import { loopbackAgent } from "./agent.ts";

import { bootstrapActorId } from "../../src/domain/actor.ts";
import type { ActorRow } from "../../src/domain/actor.ts";
import { createApp, unimplementedFor } from "../../src/http/server/app.ts";
import type { Handler } from "../../src/http/server/app.ts";
import { defaultIdempotencySettings } from "../../src/http/server/idempotency-store.ts";
import type {
  IdempotencySettings,
  Schedule,
} from "../../src/http/server/idempotency-store.ts";

export { unimplementedFor };

export const BOOTSTRAP_ACTOR_FIXTURE: ActorRow = {
  id: bootstrapActorId,
  kind: "human",
  name: "bootstrap",
  tokenSha256: null,
  registeredBy: null,
  createdAt: 0,
  revokedAt: null,
  revokedBy: null,
};

export const HARNESS_ACTOR_FIXTURE: ActorRow = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
  kind: "harness",
  name: "harness-a",
  tokenSha256: new Uint8Array(32),
  registeredBy: bootstrapActorId,
  createdAt: 1720000000000,
  revokedAt: null,
  revokedBy: null,
};

export const HARNESS_ACTOR_FIXTURE_B: ActorRow = {
  ...HARNESS_ACTOR_FIXTURE,
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS",
  name: "harness-b",
};

export type TestAppOverrides = Readonly<{
  token?: string;
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  resolveActor?: (presented: string) => ActorRow | null;
  handlers?: Readonly<Record<string, Handler>>;
  onInternalError?: (error: unknown) => void;
  idempotency?: IdempotencySettings;
  now?: () => number;
  schedule?: Schedule;
}>;

export type TestApp = Readonly<{
  raw: ReturnType<typeof supertest>;
  get(path: string): supertest.Test;
  post(path: string): supertest.Test;
  put(path: string): supertest.Test;
  del(path: string): supertest.Test;
  internalErrors(): readonly unknown[];
}>;

export function drive(
  app: TestApp,
  method: string,
  path: string,
): supertest.Test {
  switch (method) {
    case "DELETE":
      return app.del(path);
    case "GET":
      return app.get(path);
    case "POST":
      return app.post(path);
    case "PUT":
      return app.put(path);
    default:
      throw new Error(`unsupported method: ${method}`);
  }
}

export function driveRaw(
  app: TestApp,
  method: string,
  path: string,
): supertest.Test {
  switch (method) {
    case "DELETE":
      return app.raw.del(path);
    case "GET":
      return app.raw.get(path);
    case "POST":
      return app.raw.post(path);
    case "PUT":
      return app.raw.put(path);
    default:
      throw new Error(`unsupported method: ${method}`);
  }
}

export async function createTestApp(
  overrides?: TestAppOverrides,
): Promise<TestApp> {
  const token = overrides?.token ?? "test-token";
  const allowedHosts = overrides?.allowedHosts ?? ["kanthord.test"];
  const allowedOrigins = overrides?.allowedOrigins ?? [];
  const resolveActor =
    overrides?.resolveActor ?? (() => BOOTSTRAP_ACTOR_FIXTURE);
  const handlers = overrides?.handlers ?? {};
  const captured: unknown[] = [];
  const onInternalError =
    overrides?.onInternalError ??
    ((error: unknown) => {
      captured.push(error);
    });
  const idempotency = overrides?.idempotency ?? defaultIdempotencySettings;
  const now = overrides?.now ?? (() => 0);
  const schedule = overrides?.schedule ?? (() => () => {});
  const app = createApp({
    settings: { token, allowedHosts, allowedOrigins },
    resolveActor,
    handlers,
    unimplemented: unimplementedFor(handlers),
    onInternalError,
    idempotency,
    now,
    schedule,
  });
  const raw = await loopbackAgent(app);
  const host = allowedHosts[0] ?? "";
  return {
    raw,
    get(path) {
      return raw
        .get(path)
        .set("Host", host)
        .set("Authorization", `Bearer ${token}`);
    },
    post(path) {
      return raw
        .post(path)
        .set("Host", host)
        .set("Authorization", `Bearer ${token}`);
    },
    put(path) {
      return raw
        .put(path)
        .set("Host", host)
        .set("Authorization", `Bearer ${token}`);
    },
    del(path) {
      return raw
        .del(path)
        .set("Host", host)
        .set("Authorization", `Bearer ${token}`);
    },
    internalErrors() {
      return captured;
    },
  };
}
