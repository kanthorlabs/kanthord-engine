import type supertest from "supertest";

import { loopbackAgent } from "./agent.ts";

import { registry } from "../../src/http/contract/registry.ts";
import { createApp } from "../../src/http/server/app.ts";
import type { Handler } from "../../src/http/server/app.ts";

export type TestAppOverrides = Readonly<{
  token?: string;
  allowedHosts?: readonly string[];
  handlers?: Readonly<Record<string, Handler>>;
  onInternalError?: (error: unknown) => void;
}>;

export function unimplementedFor(
  handlers: Readonly<Record<string, Handler>>,
): readonly string[] {
  return registry
    .filter((entry) => entry.status === "routed")
    .map((entry) => entry.operationId)
    .filter((operationId) => !(operationId in handlers));
}

export type TestApp = Readonly<{
  raw: ReturnType<typeof supertest>;
  get(path: string): supertest.Test;
  post(path: string): supertest.Test;
  put(path: string): supertest.Test;
  del(path: string): supertest.Test;
  internalErrors(): readonly unknown[];
}>;

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
