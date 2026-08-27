import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { Hono } from "hono";
import type { Context } from "hono";

import { errorResponse, errorValue, materializeError } from "./envelope.ts";
import { headersMiddleware } from "./headers.ts";
import { renderMiddleware } from "./render.ts";
import { routeMiddleware } from "./route.ts";
import { bodyMiddleware } from "./body.ts";
import { demand, optional } from "./variables.ts";
import type { AppEnv } from "./variables.ts";
import { httpError } from "../contract/errors.ts";
import type { Operation } from "../contract/operation.ts";
import { createIdempotency } from "./idempotency.ts";
import type { IdempotencySettings } from "./idempotency-store.ts";
import { defaultIdempotencySettings } from "./idempotency-store.ts";
import type { Schedule } from "./idempotency-store.ts";
import { recordKey } from "./idempotency-key.ts";
import { loopbackAgent, loopbackServer } from "../../../test/helpers/agent.ts";
import {
  BOOTSTRAP_ACTOR_FIXTURE,
  HARNESS_ACTOR_FIXTURE,
  HARNESS_ACTOR_FIXTURE_B,
} from "../../../test/helpers/app.ts";
import type { ActorRow } from "../../domain/actor.ts";
import { bootstrapActorId } from "../../domain/actor.ts";
import type { Handler } from "./app.ts";
import { importPlanHandler } from "./plan/import-plan.ts";
import { importPlan } from "../../commands/plan/import-plan.ts";
import type {
  ImportPlanInput,
  ImportPlanResult,
} from "../../commands/plan/import-plan.ts";
import { exportPlan } from "../../queries/plan/export-plan.ts";
import { canonicalDocumentsJson } from "../../domain/plan-hash.ts";
import type { EventLog, RecordedEvent } from "../../services/event/index.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { fixtureIds } from "../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanReader,
  createPlanStore,
  createRevision,
  planFixtureIdentities,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";

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

async function settles(
  prompt: Promise<unknown>,
  ticks: number,
): Promise<boolean> {
  let settled = false;
  prompt.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < ticks && !settled; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return settled;
}

const admit: Handler = () => ({
  kind: "json",
  status: 200,
  body: { handled: true },
});

const bound: Readonly<Record<string, Handler>> = {
  "project.create": admit,
  "repository.inspect": admit,
  "plan.import": admit,
};

async function buildApp(input: {
  handler?: (c: Context<AppEnv>) => Promise<void> | void;
  settings?: IdempotencySettings;
  now?: () => number;
  onInternalError?: (error: unknown) => void;
  resolveActor?: (presented: string) => ActorRow | null;
  operationOverride?: (operation: Operation) => Operation;
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
  const resolveActor = input.resolveActor ?? (() => BOOTSTRAP_ACTOR_FIXTURE);

  let count = 0;
  const hono = new Hono<AppEnv>();
  hono.onError((error, c) => {
    const value = errorValue(error);
    const materialized = materializeError(value);
    if (materialized.internal && input.onInternalError !== undefined) {
      input.onInternalError(value);
    }
    return errorResponse(materialized, demand(c, "headers"));
  });
  hono.use("*", headersMiddleware());
  hono.use("*", renderMiddleware());
  hono.use("*", routeMiddleware());
  const override = input.operationOverride;
  if (override !== undefined) {
    hono.use("*", async (c, next) => {
      const match = demand(c, "match");
      c.set("match", {
        operation: override(match.operation),
        parameters: match.parameters,
      });
      await next();
    });
  }
  hono.use("*", bodyMiddleware(bound));
  hono.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const resolved = resolveActor(presented);
    if (resolved === null) {
      throw httpError("unauthenticated", "the bearer token is not valid");
    }
    c.set("actor", resolved);
    await next();
  });
  hono.use("*", middleware);
  hono.all("*", async (c) => {
    count += 1;
    if (input.handler !== undefined) {
      await input.handler(c);
      return;
    }
    c.set("result", { kind: "json", status: 200, body: { ok: true } });
  });

  const app = hono;
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

const okHandler = (c: Context<AppEnv>): void => {
  c.set("result", { kind: "json", status: 200, body: { ok: true } });
};

const encoder = new TextEncoder();
const U_REV = "01JQZ3NDEKTSV4RRFFQ69G5FAV";

const recordingEvents: EventLog = {
  append(): RecordedEvent {
    return {
      id: "event_1",
      subjectKind: "",
      subjectId: "",
      type: "",
      actorKind: "human",
      actorId: "",
      payload: {},
      occurredAt: 0,
    };
  },
  list(): readonly RecordedEvent[] {
    return [];
  },
};

const GENERIC_ENVELOPE =
  '{"error":{"code":"internal-error","message":"internal error"}}';

describe("src/http/server/idempotency.test", () => {
  it("runs the command once for two identical keyed POSTs, and both answers are byte-identical", async () => {
    const handler = (c: Context<AppEnv>): void => {
      const headers = demand(c, "headers");
      headers.set("ETag", "abc");
      headers.append("X-Multi", "a");
      headers.append("X-Multi", "b");
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
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

  it("answers 409 idempotency-mismatch when the same key repeats with equal json but different whitespace", async () => {
    const { agent, calls } = await buildApp({ handler: okHandler });
    const first = await agent
      .post("/v1/project")
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "k1")
      .send('{"name":"a"}');
    const second = await agent
      .post("/v1/project")
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "k1")
      .send('{ "name" : "a" }');
    assert.equal(first.status, 200);
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

  describe("the record key carries the actor", () => {
    const twoActors = (presented: string): ActorRow =>
      presented === "token-a" ? HARNESS_ACTOR_FIXTURE : HARNESS_ACTOR_FIXTURE_B;

    it("two actors with the same Idempotency-Key each run their own execution, byte-identical bodies", async () => {
      const { agent, calls, store } = await buildApp({
        handler: okHandler,
        resolveActor: twoActors,
      });
      const first = await agent
        .post("/v1/project")
        .set("Authorization", "Bearer token-a")
        .set("Idempotency-Key", "k1")
        .send({ name: "a" });
      const second = await agent
        .post("/v1/project")
        .set("Authorization", "Bearer token-b")
        .set("Idempotency-Key", "k1")
        .send({ name: "a" });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls(), 2);
      assert.equal(store.size(), 2);
      assert.equal(first.text, second.text);
    });

    it("two actors with the same Idempotency-Key and different bodies each run their own execution", async () => {
      const handler = (c: Context<AppEnv>): void => {
        const body = optional(c, "body") as { name?: string } | undefined;
        c.set("result", {
          kind: "json",
          status: 200,
          body: { echoed: body?.name ?? null },
        });
      };
      const { agent, calls, store } = await buildApp({
        handler,
        resolveActor: twoActors,
      });
      const first = await agent
        .post("/v1/project")
        .set("Authorization", "Bearer token-a")
        .set("Idempotency-Key", "k1")
        .send({ name: "a" });
      const second = await agent
        .post("/v1/project")
        .set("Authorization", "Bearer token-b")
        .set("Idempotency-Key", "k1")
        .send({ name: "b" });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.notEqual(second.status, 409);
      assert.equal(calls(), 2);
      assert.equal(store.size(), 2);
      assert.deepEqual(first.body, { echoed: "a" });
      assert.deepEqual(second.body, { echoed: "b" });
    });

    it("a slow first request does not make a second actor's request wait or answer 503", async () => {
      const arrived = deferred<void>();
      const gate = deferred<void>();
      const handler = async (c: Context<AppEnv>): Promise<void> => {
        if (!gated) {
          gated = true;
          arrived.resolve();
          await gate.promise;
        }
        c.set("result", { kind: "json", status: 200, body: { ok: true } });
      };
      let gated = false;
      const { agent, calls, store } = await buildApp({
        handler,
        resolveActor: twoActors,
      });
      const first = agent
        .post("/v1/project")
        .set("Authorization", "Bearer token-a")
        .set("Idempotency-Key", "k1")
        .send({ name: "a" });
      first.then(
        () => {},
        () => {},
      );
      await arrived.promise;
      const second = agent
        .post("/v1/project")
        .set("Authorization", "Bearer token-b")
        .set("Idempotency-Key", "k1")
        .send({ name: "a" });
      assert.equal(
        await settles(second, 5000),
        true,
        "the second request must answer from its own execution while the first is still in flight",
      );
      const secondRes = await second;
      assert.equal(secondRes.status, 200);
      assert.equal(calls(), 2);
      assert.equal(store.size(), 2);
      gate.resolve();
      const firstRes = await first;
      assert.equal(firstRes.status, 200);
    });

    it("a replay of the same key by the same actor still returns the stored answer", async () => {
      const { agent, calls, store } = await buildApp({ handler: okHandler });
      const first = await agent
        .post("/v1/project")
        .set("Idempotency-Key", "k1")
        .send({ name: "a" });
      const second = await agent
        .post("/v1/project")
        .set("Idempotency-Key", "k1")
        .send({ name: "a" });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls(), 1);
      assert.equal(store.size(), 1);
      assert.deepEqual(second.body, first.body);
    });
  });

  it("runs the command once for two duplicates dispatched with no await between them", async () => {
    const arrived = deferred<void>();
    const gate = deferred<void>();
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
    };
    const { agent, calls, store } = await buildApp({ handler });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      actorId: bootstrapActorId,
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
    };
    const { agent, calls, store } = await buildApp({ handler });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      actorId: bootstrapActorId,
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
    };
    const { agent, calls, store, fireTimers } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, joinTimeoutSeconds: 30 },
    });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      actorId: bootstrapActorId,
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
    };
    const { agent, calls, store, fireTimers } = await buildApp({
      handler,
      settings: { ...defaultIdempotencySettings, joinTimeoutSeconds: 0 },
    });
    const key = recordKey({
      operationId: "project.create",
      parameters: {},
      actorId: bootstrapActorId,
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
      actorId: bootstrapActorId,
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
    const boom = new Error("boom");
    const handler = (): void => {
      committed += 1;
      throw boom;
    };
    const reported: unknown[] = [];
    const { agent, calls, store } = await buildApp({
      handler,
      onInternalError: (error) => reported.push(error),
    });
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
    assert.equal(reported.length, 1);
    assert.equal(reported[0], boom);
  });

  it("keeps a keyed serialization failure indeterminate: the same generic 500 replays, the handler runs once, one callback fires, one record remains", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const handler = (c: Context<AppEnv>): void => {
      c.set("result", { kind: "json", status: 200, body: circular });
    };
    const reported: unknown[] = [];
    const { agent, calls, store } = await buildApp({
      handler,
      onInternalError: (error) => reported.push(error),
    });
    const first = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(first.status, 500);
    assert.equal(second.status, 500);
    assert.equal(first.text, GENERIC_ENVELOPE);
    assert.equal(second.text, first.text);
    assert.equal(
      first.headers["content-type"],
      "application/json; charset=utf-8",
    );
    assert.equal(
      second.headers["content-type"],
      "application/json; charset=utf-8",
    );
    assert.equal(calls(), 1);
    assert.equal(reported.length, 1);
    assert.ok(reported[0] instanceof TypeError);
    assert.equal(store.size(), 1);
  });

  it("settles and replays a stored answer for an HttpError whose status the operation declares replayable", async () => {
    const handler = (): void => {
      throw httpError("lease-held", "held", {});
    };
    const { agent, calls, store } = await buildApp({
      handler,
      operationOverride: (operation) => ({
        ...operation,
        replayable: [409],
      }),
    });
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
    assert.equal(second.text, first.text);
    assert.equal(calls(), 1);
    assert.equal(store.size(), 1);
  });

  it("stores and replays the exact json text, status and content type", async () => {
    const { agent, calls } = await buildApp({ handler: okHandler });
    const first = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(first.status, 200);
    assert.equal(first.text, '{"ok":true}');
    assert.equal(
      first.headers["content-type"],
      "application/json; charset=utf-8",
    );
    assert.equal(second.status, 200);
    assert.equal(second.text, '{"ok":true}');
    assert.equal(
      second.headers["content-type"],
      "application/json; charset=utf-8",
    );
    assert.equal(calls(), 1);
  });

  it("stores and replays a byte-exact Uint8Array body with the operation media type", async () => {
    const bytes = Uint8Array.from([0x00, 0x80, 0xff]);
    const handler = (c: Context<AppEnv>): void => {
      c.set("result", { kind: "bytes", status: 200, bytes });
    };
    const { app, calls } = await buildApp({
      handler,
      operationOverride: (operation) => ({
        ...operation,
        responseMedia: "application/octet-stream",
      }),
    });
    const server = await loopbackServer(app);
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/v1/project`;
    const first = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "k1",
      },
      body: '{"name":"a"}',
    });
    const second = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "k1",
      },
      body: '{"name":"a"}',
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(
      Array.from(new Uint8Array(await first.arrayBuffer())),
      [0, 128, 255],
    );
    assert.equal(second.status, 200);
    assert.equal(
      second.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await second.arrayBuffer())),
      [0, 128, 255],
    );
    assert.equal(calls(), 1);
  });

  it("stores and replays a null body for an empty 204 answer", async () => {
    const handler = (c: Context<AppEnv>): void => {
      c.set("result", { kind: "empty", status: 204 });
    };
    const { agent, calls } = await buildApp({
      handler,
      operationOverride: (operation) => ({
        ...operation,
        replayable: [204],
      }),
    });
    const first = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(first.status, 204);
    assert.equal(first.text, "");
    assert.equal(first.headers["content-type"], undefined);
    assert.equal(second.status, 204);
    assert.equal(second.text, "");
    assert.equal(second.headers["content-type"], undefined);
    assert.equal(calls(), 1);
  });

  it("serializes a stateful toJSON result exactly once across a keyed replay", async () => {
    let serializations = 0;
    const handler = (c: Context<AppEnv>): void => {
      c.set("result", {
        kind: "json",
        status: 200,
        body: {
          toJSON(): unknown {
            serializations += 1;
            return { ok: true };
          },
        },
      });
    };
    const { agent, calls } = await buildApp({ handler });
    const first = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    const second = await agent
      .post("/v1/project")
      .set("Idempotency-Key", "k1")
      .send({ name: "a" });
    assert.equal(serializations, 1);
    assert.equal(calls(), 1);
    assert.equal(first.text, '{"ok":true}');
    assert.equal(second.text, first.text);
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
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
    const handler = async (c: Context<AppEnv>): Promise<void> => {
      arrived.resolve();
      await gate.promise;
      c.set("result", { kind: "json", status: 200, body: { ok: true } });
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

    it("plan.import under two actors with the same importId collapses to one import and reserves nothing", async (t) => {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());
      const storage = temporary.storage;
      const plan = createPlanStore();
      const blobs = createBlobStore(
        storage,
        createMockClock({ start: 1700000000000, step: 1000 }),
      );
      seedPlanFixture(storage, plan, blobs);
      const revision = createRevision(blobs, plan);
      const exported = exportPlan(
        { storage, plan, revision },
        { projectId: fixtureIds.project },
      ).documents;
      const recorded: ImportPlanResult[] = [];
      const handle = importPlanHandler({
        importPlan: (input: ImportPlanInput): ImportPlanResult => {
          const outcome = importPlan(
            {
              storage,
              plan,
              blobs,
              reader: createPlanReader(),
              graph: createPlanGraph(),
              ids: createMockIdGenerator({ ulids: [U_REV] }),
              clock: createMockClock({
                start: 1700000000000,
                step: 1000,
              }),
              events: recordingEvents,
            },
            input,
          );
          recorded.push(outcome);
          return outcome;
        },
      });
      const handler = async (c: Context<AppEnv>): Promise<void> => {
        const match = demand(c, "match");
        const outcome = await handle({
          operation: match.operation,
          parameters: match.parameters,
          query: {},
          headers: {},
          body: optional(c, "body"),
          actor: demand(c, "actor"),
        });
        c.set("result", outcome);
      };
      const { agent, store } = await buildApp({
        handler,
        resolveActor: (presented) =>
          presented === "token-a"
            ? HARNESS_ACTOR_FIXTURE
            : HARNESS_ACTOR_FIXTURE_B,
      });
      const body = (): Record<string, unknown> => ({
        fromRevision: fixtureIds.planRevision,
        importId: "imp_two_actors",
        documents: exported,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: blobs.hash(
          encoder.encode(canonicalDocumentsJson(exported)),
        ),
      });
      const first = await agent
        .post(`/v1/project/${fixtureIds.project}/plan/import`)
        .set("Authorization", "Bearer token-a")
        .set("Idempotency-Key", "imp_two_actors")
        .send(body());
      const second = await agent
        .post(`/v1/project/${fixtureIds.project}/plan/import`)
        .set("Authorization", "Bearer token-b")
        .set("Idempotency-Key", "imp_two_actors")
        .send(body());
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(first.body.revision, second.body.revision);
      assert.equal(
        recorded.length,
        2,
        "the durable path reaches the command for both actors, so it is not actor scoped",
      );
      assert.equal(
        recorded.filter((outcome) => !outcome.retried).length,
        1,
        "the import executes once, so the command-level dedup still collapses one identity",
      );
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

    it("the reserved success try covers only materializeResult, so a capture or settlement failure never enters the materialization catch", async () => {
      const source = await readFile(
        new URL("./idempotency.ts", import.meta.url),
        "utf8",
      );
      const nextAt = source.indexOf("await next();");
      assert.ok(nextAt >= 0, "the reserved branch awaits next()");
      const entry = source.indexOf('demand(c, "result")');
      assert.ok(
        entry > nextAt,
        "the success branch demands result after next()",
      );
      const tryAt = source.indexOf("try {", entry);
      assert.ok(
        tryAt > entry,
        "the reserved success branch enters its own try",
      );
      const catchAt = source.indexOf("} catch", tryAt);
      assert.ok(catchAt > tryAt, "the try closes into its catch");
      const covered = source.slice(tryAt, catchAt);
      assert.match(covered, /materializeResult\(/);
      assert.doesNotMatch(covered, /captureAnswer\(/);
      assert.doesNotMatch(covered, /\.settle\(/);
      assert.doesNotMatch(covered, /c\.set\("replay"/);

      const rethrowAt = source.indexOf("throw failure;", catchAt);
      assert.ok(
        rethrowAt > catchAt,
        "the catch preserves the original failure",
      );
      const tail = source.slice(rethrowAt + "throw failure;".length);
      assert.match(tail, /captureAnswer\(/);
      assert.match(tail, /\.settle\(/);
      assert.match(tail, /c\.set\("replay"/);
    });
  });
});
