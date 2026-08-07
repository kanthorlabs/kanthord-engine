import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import Koa, { type Context } from "koa";
import bodyParser from "@koa/bodyparser";

import { envelopeMiddleware } from "./envelope.ts";
import { routeMiddleware } from "./route.ts";
import { httpError } from "../contract/errors.ts";
import { createIdempotency } from "./idempotency.ts";
import type { IdempotencySettings } from "./idempotency-store.ts";
import { defaultIdempotencySettings } from "./idempotency-store.ts";
import type { Schedule } from "./idempotency-store.ts";
import { recordKey } from "./idempotency-key.ts";
import { loopbackAgent, loopbackServer } from "../../../test/helpers/agent.ts";

type Fired = { run: () => void; cancelled: boolean };

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function buildApp(input: {
  handler: (context: Context) => Promise<void> | void;
  settings?: IdempotencySettings;
  now?: () => number;
  onInternalError?: (error: unknown) => void;
}) {
  const armed: Fired[] = [];
  const schedule: Schedule = (_at, run) => {
    const entry: Fired = { run, cancelled: false };
    armed.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const fireTimers = (): void => {
    for (const entry of armed.splice(0)) {
      if (!entry.cancelled) entry.run();
    }
  };
  const { middleware, store } = createIdempotency({
    settings: input.settings ?? defaultIdempotencySettings,
    now: input.now ?? (() => 1_000),
    schedule,
  });

  let count = 0;
  const app = new Koa();
  app.use(
    envelopeMiddleware({
      onInternalError: input.onInternalError ?? (() => {}),
    }),
  );
  app.use(routeMiddleware());
  app.use(bodyParser({ enableTypes: ["json"] }));
  app.use(middleware);
  app.use(async (context: Context) => {
    count += 1;
    await input.handler(context);
  });

  const agent = await loopbackAgent(app);
  return { agent, app, store, calls: () => count, fireTimers };
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string | string[]>,
  body?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw.length > 0 ? JSON.parse(raw) : undefined,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const okHandler = (context: Context): void => {
  context.status = 200;
  context.body = { ok: true };
};

describe("src/http/server/idempotency.test", () => {
  it("runs the command once for two identical keyed POSTs, and both answers are byte-identical", async () => {
    const handler = (context: Context): void => {
      context.set("ETag", "abc");
      context.set("X-Multi", ["a", "b"]);
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls } = await buildApp({ handler });
    const strip = (headers: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) =>
            ![
              "date",
              "content-length",
              "connection",
              "keep-alive",
              "transfer-encoding",
            ].includes(name),
        ),
      );
    const first = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(calls(), 1);
    assert.equal(first.status, second.status);
    assert.equal(first.text, second.text);
    assert.deepEqual(strip(first.headers), strip(second.headers));
  });

  it("answers 409 idempotency-mismatch when the same key carries a different body", async () => {
    const { agent, calls } = await buildApp({ handler: okHandler });
    await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "other" });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "idempotency-mismatch");
    assert.equal(calls(), 1);
  });

  it("answers 409 idempotency-mismatch when the same key carries a different query string", async () => {
    const { agent, calls } = await buildApp({ handler: okHandler });
    await agent
      .post("/v1/project?a=1")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project?a=2")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "idempotency-mismatch");
    assert.equal(calls(), 1);
  });

  it("records two entries and runs both commands when one key is sent to two different operations", async () => {
    const { agent, calls, store } = await buildApp({ handler: okHandler });
    const first = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/repository/inspect")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls(), 2);
    assert.equal(store.size(), 2);
  });

  it("runs the command once for two duplicates dispatched with no await between them", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls } = await buildApp({ handler });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    second.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    gate.resolve();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    assert.equal(calls(), 1);
    assert.notEqual(firstRes.status, 409);
    assert.notEqual(secondRes.status, 409);
    assert.equal(firstRes.status, secondRes.status);
    assert.deepEqual(firstRes.body, secondRes.body);
  });

  it("joins rather than erroring when a duplicate arrives while the first is in flight", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls, store } = await buildApp({ handler });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      key: "k1",
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    const second = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    second.then(
      () => {},
      () => {},
    );
    while (store.waiters(key) !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    gate.resolve();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    assert.equal(calls(), 1);
    assert.deepEqual(firstRes.body, secondRes.body);
  });

  it("does not cancel the original when a joined duplicate disconnects", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls, store } = await buildApp({ handler });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      key: "k1",
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    const second = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    second.then(
      () => {},
      () => {},
    );
    while (store.waiters(key) !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    second.abort();
    gate.resolve();
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    assert.equal(calls(), 1);
    assert.equal(store.waiters(key), 0);
    await second.catch(() => {});
  });

  it("does not cache a lease-held outcome, and a later request runs the command again", async () => {
    const handler = (): void => {
      throw httpError("lease-held", "held", {});
    };
    const { agent, calls, store } = await buildApp({ handler });
    const first = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(first.status, 409);
    assert.equal(first.body.error.code, "lease-held");
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "lease-held");
    assert.equal(calls(), 2);
    assert.equal(store.size(), 0);
  });

  it("answers 503 on a join timeout, then replays for a request that arrives after the original completes", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls, store, fireTimers } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, joinTimeoutSeconds: 30 },
    });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      key: "k1",
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    const second = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    second.then(
      () => {},
      () => {},
    );
    while (store.waiters(key) !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    fireTimers();
    const secondRes = await second;
    assert.equal(secondRes.status, 503);
    assert.deepEqual(secondRes.body, {
      error: {
        code: "service-unavailable",
        message:
          "the original request under this Idempotency-Key is still running",
      },
    });
    gate.resolve();
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    assert.equal(calls(), 1);

    const third = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.deepEqual(third.body, firstRes.body);
    assert.equal(calls(), 1);
    void store;
  });

  it("waits for the original with a zero join timeout", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls, store, fireTimers } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, joinTimeoutSeconds: 0 },
    });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      key: "k1",
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    const second = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    second.then(
      () => {},
      () => {},
    );
    while (store.waiters(key) !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    fireTimers();
    gate.resolve();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    assert.deepEqual(firstRes.body, secondRes.body);
    assert.equal(calls(), 1);
  });

  it("a joiner of a lease-held outcome receives it and does not run the command", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      throw httpError("lease-held", "held", {});
    };
    const { agent, calls, store } = await buildApp({ handler });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      key: "k1",
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    const second = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    second.then(
      () => {},
      () => {},
    );
    while (store.waiters(key) !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    gate.resolve();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    assert.equal(firstRes.status, 409);
    assert.equal(secondRes.status, 409);
    assert.equal(calls(), 1);
    assert.equal(store.size(), 0);
  });

  it("marks the key indeterminate when a handler commits and then throws", async () => {
    let committed = 0;
    const handler = (): void => {
      committed += 1;
      throw new Error("boom");
    };
    const { agent, calls, store } = await buildApp({ handler });
    const expected = {
      error: { code: "internal-error", message: "internal error" },
    };
    const first = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(first.status, 500);
    assert.deepEqual(first.body, expected);
    assert.equal(second.status, 500);
    assert.deepEqual(second.body, expected);
    assert.equal(calls(), 1);
    assert.equal(committed, 1);
    assert.equal(store.size(), 1);
  });

  it("answers 400 invalid-request when the key arrives twice, and the command never runs", async () => {
    const { app, calls } = await buildApp({ handler: okHandler });
    const server = await loopbackServer(app);
    const port = (server.address() as AddressInfo).port;
    const response = await rawRequest(
      port,
      "POST",
      "/v1/project",
      {
        "idempotency-key": ["a", "b"],
        "content-type": "application/json",
      },
      JSON.stringify({ name: "x" }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        code: "invalid-request",
        message: "Idempotency-Key was supplied more than once",
      },
    });
    assert.equal(calls(), 0);
  });

  it("answers 400 invalid-request for a 256-character key, and the command never runs", async () => {
    const { agent, calls } = await buildApp({ handler: okHandler });
    const key = "a".repeat(256);
    const response = await agent
      .post("/v1/project")
      .set("Idempotency-Key", key)
      .send({ name: "a" });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        code: "invalid-request",
        message:
          "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
      },
    });
    assert.equal(calls(), 0);
  });

  it("answers 400 invalid-request for a key carrying a tab, and the command never runs", async () => {
    const { agent, calls } = await buildApp({ handler: okHandler });
    const response = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "a\tb")
      .send({ name: "a" });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        code: "invalid-request",
        message:
          "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
      },
    });
    assert.equal(calls(), 0);
  });

  it("accepts a key with an interior space", async () => {
    const { agent, calls } = await buildApp({ handler: okHandler });
    await agent
      .post("/v1/project")
      .set("Idempotency-Key", "release candidate")
      .send({ name: "a" });
    await agent
      .post("/v1/project")
      .set("Idempotency-Key", "release candidate")
      .send({ name: "a" });
    assert.equal(calls(), 1);
  });

  it("runs the command every time for a POST with no key", async () => {
    const { agent, calls, store } = await buildApp({ handler: okHandler });
    await agent.post("/v1/project").send({ name: "a" });
    await agent.post("/v1/project").send({ name: "a" });
    assert.equal(calls(), 2);
    assert.equal(store.size(), 0);
  });

  it("ignores a key on a GET without caching", async () => {
    const { agent, calls, store } = await buildApp({ handler: okHandler });
    await agent.get("/v1/health").set("Idempotency-Key", "k1");
    await agent.get("/v1/health").set("Idempotency-Key", "k1");
    assert.equal(calls(), 2);
    assert.equal(store.size(), 0);
  });

  it("answers 400 for a GET carrying a malformed key", async () => {
    const { agent, calls } = await buildApp({ handler: okHandler });
    const key = "a".repeat(256);
    const response = await agent.get("/v1/health").set("Idempotency-Key", key);
    assert.equal(response.status, 400);
    assert.equal(calls(), 0);
  });

  it("an in-flight reservation survives a TTL sweep at the app level", async () => {
    let now = 1_000;
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, ttlSeconds: 300 },
      now: () => now,
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    now += 300 * 1000 + 1;
    const second = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    second.then(
      () => {},
      () => {},
    );
    gate.resolve();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    assert.equal(calls(), 1);
    assert.deepEqual(firstRes.body, secondRes.body);
  });

  it("the TTL starts at completion at the app level", async () => {
    let now = 1_000;
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, ttlSeconds: 1 },
      now: () => now,
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    now += 5_000;
    gate.resolve();
    const firstRes = await first;
    assert.equal(calls(), 1);
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(calls(), 1);
    assert.deepEqual(second.body, firstRes.body);
  });

  it("a completed record expires after its TTL", async () => {
    let now = 1_000;
    const { agent, calls } = await buildApp({
      handler: okHandler,
      settings: { ...defaultIdempotencySettings, ttlSeconds: 300 },
      now: () => now,
    });
    await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    now += 300_000;
    await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(calls(), 2);
  });

  it("answers 503 at the entry bound, with the first request untouched", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, maxEntries: 1 },
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    const secondRes = await agent
      .post("/v1/repository/inspect")
      .set("Idempotency-Key", "k2")
      .send({ name: "a" });
    assert.equal(secondRes.status, 503);
    assert.deepEqual(secondRes.body, {
      error: {
        code: "service-unavailable",
        message: "the idempotency cache is full of in-flight requests",
      },
    });
    gate.resolve();
    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    assert.equal(calls(), 1);
  });

  it("a saturated request may retry once capacity frees", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const { agent, calls } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, maxEntries: 1 },
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    const saturatedRes = await agent
      .post("/v1/repository/inspect")
      .set("Idempotency-Key", "k2")
      .send({ name: "a" });
    assert.equal(saturatedRes.status, 503);
    gate.resolve();
    await first;
    const retry = await agent
      .post("/v1/repository/inspect")
      .set("Idempotency-Key", "k2")
      .send({ name: "a" });
    assert.equal(retry.status, 200);
    assert.equal(calls(), 2);
  });

  it("does not report saturation as an internal fault", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (context: Context): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      context.status = 200;
      context.body = { ok: true };
    };
    const reported: unknown[] = [];
    const { agent } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, maxEntries: 1 },
      onInternalError: (error) => reported.push(error),
    });
    const first = agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    first.then(
      () => {},
      () => {},
    );
    await arrived.promise;
    const second = agent
      .post("/v1/repository/inspect")
      .set("Idempotency-Key", "k2")
      .send({ name: "a" });
    second.then(
      () => {},
      () => {},
    );
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(reported, []);
  });

  it("a zero TTL disables the memory policy", async () => {
    const { agent, calls, store } = await buildApp({
      handler: okHandler,
      settings: { ...defaultIdempotencySettings, ttlSeconds: 0 },
    });
    await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(calls(), 2);
    assert.equal(store.size(), 0);
  });

  it("a zero TTL still validates the key", async () => {
    const { agent, calls } = await buildApp({
      handler: okHandler,
      settings: { ...defaultIdempotencySettings, ttlSeconds: 0 },
    });
    const key = "a".repeat(256);
    const response = await agent
      .post("/v1/project")
      .set("Idempotency-Key", key)
      .send({ name: "a" });
    assert.equal(response.status, 400);
    assert.equal(calls(), 0);
  });

  describe("plan.import under the durable policy", () => {
    it("reaches the command when the header equals importId, and the cache holds no record", async () => {
      const { agent, calls, store } = await buildApp({ handler: okHandler });
      const response = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_a")
        .send({ importId: "imp_a", documents: [] });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });
      assert.equal(calls(), 1);
      assert.equal(store.size(), 0);
    });

    it("reaches the command again on an identical repeat, because the memory cache never suppresses a durable operation", async () => {
      const { agent, calls, store } = await buildApp({ handler: okHandler });
      await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_a")
        .send({ importId: "imp_a", documents: [] });
      await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_a")
        .send({ importId: "imp_a", documents: [] });
      assert.equal(calls(), 2);
      assert.equal(store.size(), 0);
    });

    it("answers 400 invalid-request when the header differs from importId", async () => {
      const { agent, calls, store } = await buildApp({ handler: okHandler });
      const response = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_b")
        .send({ importId: "imp_a" });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        error: {
          code: "invalid-request",
          message: "Idempotency-Key must equal importId",
        },
      });
      assert.equal(calls(), 0);
      assert.equal(store.size(), 0);
    });

    it("answers 400 invalid-request when the body has no importId and a header is present", async () => {
      const { agent, calls } = await buildApp({ handler: okHandler });
      const response = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_a")
        .send({});
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        error: {
          code: "invalid-request",
          message: "Idempotency-Key must equal importId",
        },
      });
      assert.equal(calls(), 0);
    });

    it("answers 400 invalid-request when the body is a non-object and a header is present", async () => {
      const { agent, calls } = await buildApp({ handler: okHandler });
      const response = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_a")
        .send([]);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        error: {
          code: "invalid-request",
          message: "Idempotency-Key must equal importId",
        },
      });
      assert.equal(calls(), 0);
    });

    it("answers 400 invalid-request for a numeric importId with a matching-looking header, by string equality only", async () => {
      const { agent, calls } = await buildApp({ handler: okHandler });
      const response = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "1")
        .send({ importId: 1 });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        error: {
          code: "invalid-request",
          message: "Idempotency-Key must equal importId",
        },
      });
      assert.equal(calls(), 0);
    });

    it("reaches the command untouched with no header", async () => {
      const { agent, calls, store } = await buildApp({ handler: okHandler });
      const response = await agent
        .post("/v1/project/p_1/plan/import")
        .send({ importId: "imp_a" });
      assert.equal(response.status, 200);
      assert.equal(calls(), 1);
      assert.equal(store.size(), 0);
    });

    it("answers 400 for a malformed header before the importId comparison", async () => {
      const { agent, calls } = await buildApp({ handler: okHandler });
      const key = "a".repeat(256);
      const response = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", key)
        .send({ importId: "imp_a" });
      assert.equal(response.status, 400);
      assert.equal(
        response.body.error.message,
        "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space",
      );
      assert.equal(calls(), 0);
    });

    it("reaches the command both times on a reordered documents array, taking no record", async () => {
      const { agent, calls, store } = await buildApp({ handler: okHandler });
      const first = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_a")
        .send({
          importId: "imp_a",
          documents: [{ path: "a" }, { path: "b" }],
        });
      const second = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_a")
        .send({
          importId: "imp_a",
          documents: [{ path: "b" }, { path: "a" }],
        });
      assert.notEqual(first.status, 409);
      assert.notEqual(second.status, 409);
      assert.equal(calls(), 2);
      assert.equal(store.size(), 0);
    });

    it("a zero join timeout does not disable the importId rule", async () => {
      const { agent, calls } = await buildApp({
        handler: okHandler,
        settings: { ...defaultIdempotencySettings, ttlSeconds: 0 },
      });
      const response = await agent
        .post("/v1/project/p_1/plan/import")
        .set("Idempotency-Key", "imp_b")
        .send({ importId: "imp_a" });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        error: {
          code: "invalid-request",
          message: "Idempotency-Key must equal importId",
        },
      });
      assert.equal(calls(), 0);
    });
  });
});
