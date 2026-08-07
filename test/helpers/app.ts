import type supertest from "supertest";

import { loopbackAgent } from "./agent.ts";

import { createApp, unimplementedFor } from "../../src/http/server/app.ts";
import type { Handler } from "../../src/http/server/app.ts";

export { unimplementedFor };

export type TestAppOverrides = Readonly<{
  token?: string;
  allowedHosts?: readonly string[];
  handlers?: Readonly<Record<string, Handler>>;
  onInternalError?: (error: unknown) => void;
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
  const handlers = overrides?.handlers ?? {};
  const captured: unknown[] = [];
  const onInternalError =
    overrides?.onInternalError ??
    ((error: unknown) => {
      captured.push(error);
    });
  const app = createApp({
    settings: { token, allowedHosts },
    handlers,
    unimplemented: unimplementedFor(handlers),
    onInternalError,
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
