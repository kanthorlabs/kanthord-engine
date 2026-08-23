import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa from "koa";

import { envelopeMiddleware } from "./envelope.ts";
import { authMiddleware } from "./auth.ts";
import type { AuthenticatedState } from "./auth.ts";
import { routeMiddleware } from "./route.ts";
import { dispatchMiddleware } from "./dispatch.ts";
import { createApp, BindingError } from "./app.ts";
import type { Handler, HandlerContext, TransportSettings } from "./app.ts";
import { noopWaits } from "../../../test/helpers/wait-registry.ts";
import { httpError } from "../contract/errors.ts";
import { registry } from "../contract/registry.ts";
import { renderPath } from "../contract/path.ts";
import type { ActorRow } from "../../domain/actor.ts";
import { bootstrapActorId } from "../../domain/actor.ts";
import {
  createTestApp,
  unimplementedFor,
  drive,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../test/helpers/app.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";
import {
  createMigratedStorage,
  tableCounts,
} from "../../../test/helpers/database.ts";

const settings: TransportSettings = {
  token: "test-token",
  allowedHosts: ["kanthord.test"],
  allowedOrigins: [],
};

const resolveActor = (): ActorRow | null => BOOTSTRAP_ACTOR_FIXTURE;

const harnessActor: ActorRow = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
  kind: "harness",
  name: "harness-a",
  tokenSha256: new Uint8Array(32),
  registeredBy: bootstrapActorId,
  createdAt: 1720000000000,
  revokedAt: null,
  revokedBy: null,
};

const okHandler: Handler = () => ({ status: 200, body: { ok: true } });

describe("src/http/server/dispatch.test", () => {
  it("a stubbed route answers 501 with its ships-in message from an empty handler map", async () => {
    const app = await createTestApp();
    const response = await app.post("/v1/node/task_01JQ8ZAN9P/abandon");
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "node.abandon ships in phase-2",
      },
    });
  });

  it("a stubbed route never reaches a handler bound anyway", async () => {
    let calls = 0;
    const app = new Koa();
    app.use(envelopeMiddleware({ onInternalError: () => {} }));
    app.use(routeMiddleware());
    app.use(
      dispatchMiddleware({
        handlers: {
          "node.abandon": () => {
            calls += 1;
            return { status: 200, body: { ok: true } };
          },
        },
      }),
    );
    const response = await (
      await loopbackAgent(app)
    ).post("/v1/node/task_01/abandon");
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "node.abandon ships in phase-2",
      },
    });
    assert.equal(calls, 0);
  });

  it("a stubbed route carrying a malformed JSON body answers 501 and the body is never parsed", async () => {
    const app = await createTestApp();
    const response = await app
      .post("/v1/node/task_01/abandon")
      .set("Content-Type", "application/json")
      .send('{"oops');
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "node.abandon ships in phase-2",
      },
    });
  });

  it("a stubbed route carrying a valid JSON body answers 501 and never reaches a handler", async () => {
    const app = await createTestApp();
    const response = await app
      .post("/v1/node/task_01/abandon")
      .set("Content-Type", "application/json")
      .send('{"ok":1}');
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "node.abandon ships in phase-2",
      },
    });
  });

  it("a routed route declared unimplemented answers 501 with the not-implemented-yet message", async () => {
    const app = await createTestApp();
    const response = await app.get("/v1/status");
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "system.status is not implemented yet",
      },
    });
  });

  it("createApp refuses an incomplete binding: every routed operation unaccounted for", () => {
    assert.throws(
      () =>
        createApp({
          settings,
          handlers: {},
          unimplemented: [],
          resolveActor,
          onInternalError: () => {},
          waits: noopWaits(),
        }),
      (error: unknown) =>
        error instanceof BindingError &&
        error.message.includes("system.health"),
    );
  });

  it("createApp refuses an operation in both handlers and unimplemented", () => {
    const both = { "system.status": okHandler };
    assert.throws(
      () =>
        createApp({
          settings,
          handlers: both,
          unimplemented: [...unimplementedFor(both), "system.status"],
          resolveActor,
          onInternalError: () => {},
          waits: noopWaits(),
        }),
      (error: unknown) =>
        error instanceof BindingError &&
        error.message.includes("system.status"),
    );
  });

  it("createApp refuses a handler id absent from the registry", () => {
    const invented = { "zzz.invented": okHandler };
    assert.throws(
      () =>
        createApp({
          settings,
          handlers: invented,
          unimplemented: unimplementedFor(invented),
          resolveActor,
          onInternalError: () => {},
          waits: noopWaits(),
        }),
      (error: unknown) =>
        error instanceof BindingError && error.message.includes("zzz.invented"),
    );
  });

  it("createApp refuses a stubbed id in handlers", () => {
    const stubbed = { "node.abandon": okHandler };
    assert.throws(
      () =>
        createApp({
          settings,
          handlers: stubbed,
          unimplemented: unimplementedFor(stubbed),
          resolveActor,
          onInternalError: () => {},
          waits: noopWaits(),
        }),
      (error: unknown) =>
        error instanceof BindingError && error.message.includes("node.abandon"),
    );
  });

  it("createApp refuses a stubbed id in unimplemented", () => {
    assert.throws(
      () =>
        createApp({
          settings,
          handlers: {},
          unimplemented: ["node.abandon"],
          resolveActor,
          onInternalError: () => {},
          waits: noopWaits(),
        }),
      (error: unknown) =>
        error instanceof BindingError && error.message.includes("node.abandon"),
    );
  });

  it("the complete binding does not throw and derives forty-two unimplemented ids", () => {
    const complete = { "system.health": okHandler, "system.db": okHandler };
    const unimplemented = unimplementedFor(complete);
    assert.equal(unimplemented.length, 42);
    assert.doesNotThrow(() =>
      createApp({
        settings,
        handlers: complete,
        unimplemented,
        resolveActor,
        onInternalError: () => {},
        waits: noopWaits(),
      }),
    );
  });

  it("a routed route with a handler answers 200 with the handler body", async () => {
    const app = await createTestApp({
      handlers: {
        "system.status": () => ({ status: 200, body: { ok: true } }),
      },
    });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  });

  it("a handler receives the parameters and the operation", async () => {
    let recorded: HandlerContext | undefined;
    const app = await createTestApp({
      handlers: {
        "node.show": (context) => {
          recorded = context;
          return { status: 200, body: { ok: true } };
        },
      },
    });
    const response = await app.get("/v1/node/task_01JQ8ZAN9P");
    assert.equal(response.status, 200);
    assert.deepEqual(recorded?.parameters, { id: "task_01JQ8ZAN9P" });
    assert.equal(recorded?.operation.operationId, "node.show");
  });

  it("a handler receives context.actor equal to the actor on context.state", async () => {
    let stateActor: ActorRow | undefined;
    let recorded: HandlerContext | undefined;
    const app = new Koa();
    app.use(envelopeMiddleware({ onInternalError: () => {} }));
    app.use(
      authMiddleware({ token: "test-token", resolveActor: () => harnessActor }),
    );
    app.use(async (context, next) => {
      stateActor = (context.state as AuthenticatedState).actor;
      await next();
    });
    app.use(routeMiddleware());
    app.use(
      dispatchMiddleware({
        handlers: {
          "system.health": (context) => {
            recorded = context;
            return { status: 200, body: { ok: true } };
          },
        },
      }),
    );
    const response = await (
      await loopbackAgent(app)
    )
      .get("/v1/health")
      .set("Authorization", "Bearer test-token");
    assert.equal(response.status, 200);
    assert.deepEqual(stateActor, harnessActor);
    assert.deepEqual(recorded?.actor, stateActor);
  });

  it("a handler receives a parsed JSON body", async () => {
    let recordedBody: unknown;
    const app = await createTestApp({
      handlers: {
        "repository.register": (context) => {
          recordedBody = context.body;
          return { status: 200, body: { ok: true } };
        },
      },
    });
    const response = await app
      .post("/v1/repository")
      .send({ url: "https://example.test/r.git" });
    assert.equal(response.status, 200);
    assert.deepEqual(recordedBody, { url: "https://example.test/r.git" });
  });

  it("a handler receives the query string as a list per key", async () => {
    let recorded: HandlerContext | undefined;
    const app = await createTestApp({
      handlers: {
        "system.health": (context) => {
          recorded = context;
          return { status: 200, body: { ok: true } };
        },
      },
    });
    await app.get("/v1/health?limit=5");
    assert.deepEqual(recorded?.query, { limit: ["5"] });

    await app.get("/v1/health");
    assert.deepEqual(recorded?.query, {});
  });

  it("a handler receives the request headers, lowercase-keyed", async () => {
    let recorded: HandlerContext | undefined;
    const app = await createTestApp({
      handlers: {
        "system.health": (context) => {
          recorded = context;
          return { status: 200, body: { ok: true } };
        },
      },
    });
    const response = await app.get("/v1/health");
    assert.equal(response.status, 200);
    assert.equal(recorded?.headers["host"], "kanthord.test");
    assert.match(recorded?.headers["authorization"] ?? "", /^Bearer /);
  });

  it("a handler's response headers are applied to the response", async () => {
    const app = await createTestApp({
      handlers: {
        "system.health": () => ({
          status: 200,
          body: "ok",
          headers: { "X-B": "2", "X-A": "1" },
        }),
      },
    });
    const response = await app.get("/v1/health");
    assert.equal(response.headers["x-a"], "1");
    assert.equal(response.headers["x-b"], "2");
  });

  it("a handler's binary body and content type cross the boundary intact", async () => {
    const app = await createTestApp({
      handlers: {
        "system.health": () => ({
          status: 200,
          body: Buffer.from([1, 2, 3]),
          headers: { "Content-Type": "application/octet-stream" },
        }),
      },
    });
    const response = await app.get("/v1/health").buffer();
    assert.match(
      response.headers["content-type"] ?? "",
      /application\/octet-stream/,
    );
    assert.equal((response.body as Buffer).length, 3);
    assert.deepEqual(Array.from(response.body as Buffer), [1, 2, 3]);
  });

  it("a handler omitting headers sets no extra header", async () => {
    const app = await createTestApp({
      handlers: {
        "system.health": () => ({ status: 200, body: { ok: true } }),
      },
    });
    const response = await app.get("/v1/health");
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-a"], undefined);
  });

  it("a repeated query key reaches the handler unrefused", async () => {
    let recorded: HandlerContext | undefined;
    const app = await createTestApp({
      handlers: {
        "system.health": (context) => {
          recorded = context;
          return { status: 200, body: { ok: true } };
        },
      },
    });
    const response = await app.get("/v1/health?a=1&a=2");
    assert.equal(response.status, 200);
    assert.deepEqual(recorded?.query, { a: ["1", "2"] });
  });

  it("a stubbed route answers 501 whatever the repeated query string says", async () => {
    const app = await createTestApp();
    const response = await app.get("/v1/run?a=1&a=2");
    assert.equal(response.status, 501);
  });

  it("an async handler is awaited", async () => {
    const app = await createTestApp({
      handlers: {
        "system.status": async () => ({ status: 201, body: { created: true } }),
      },
    });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { created: true });
  });

  it("a handler that throws an HttpError answers its status with details intact", async () => {
    const app = await createTestApp({
      handlers: {
        "system.status": () => {
          throw httpError("needs-reconcile", "diverged", {
            local: "a",
            remote: "b",
          });
        },
      },
    });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: {
        code: "needs-reconcile",
        message: "diverged",
        details: { local: "a", remote: "b" },
      },
    });
  });

  it("a handler that throws a plain Error answers 500 and reports it once", async () => {
    const boom = new Error("boom");
    const app = await createTestApp({
      handlers: {
        "system.status": () => {
          throw boom;
        },
      },
    });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 500);
    assert.equal(app.internalErrors().length, 1);
    assert.equal(app.internalErrors()[0], boom);
  });

  async function buildWitnessApp(
    temporary: ReturnType<typeof createMigratedStorage>,
  ) {
    let writes = 0;
    const witness: Handler = () => {
      writes += 1;
      temporary.storage.transact((transaction) => {
        transaction.run(
          "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            `event_01HZY8QF3M4N5P6R7S8T9V0W${String(writes).padStart(2, "0")}`,
            "node",
            "node_01HZY8QF3M4N5P6R7S8T9V0W1A",
            "witness",
            "daemon",
            "d1",
            "{}",
          ],
        );
      });
      return { status: 200, body: {} };
    };

    const handlers = Object.fromEntries(
      registry
        .filter((entry) => entry.status === "routed")
        .map((entry) => [entry.operationId, witness]),
    );
    const app = await createTestApp({ handlers });
    return { app, writes: () => writes };
  }

  it("every stubbed route answers 501 and writes no row", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());

    const { app, writes } = await buildWitnessApp(temporary);
    const before = tableCounts(temporary.storage);

    let driven = 0;
    for (const entry of registry) {
      if (entry.status !== "stubbed") continue;
      const path = renderPath(entry.path).replace(/:[^/]+/g, "x_01");
      const response = await drive(app, entry.method, path);
      assert.equal(response.status, 501, `${entry.operationId} ${path}`);
      assert.equal(
        response.body.error.code,
        "not-implemented",
        entry.operationId,
      );
      assert.deepEqual(
        tableCounts(temporary.storage),
        before,
        entry.operationId,
      );
      driven += 1;
    }

    assert.equal(
      driven,
      registry.filter((entry) => entry.status === "stubbed").length,
    );
    assert.equal(driven, 25);
    assert.equal(writes(), 0);
    assert.deepEqual(tableCounts(temporary.storage), before);
  });

  it("a routed route reaches the witness and writes a row", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());

    const { app, writes } = await buildWitnessApp(temporary);
    const before = tableCounts(temporary.storage);

    const response = await app.get("/v1/health");
    assert.equal(response.status, 200);
    assert.equal(writes(), 1);
    assert.equal(tableCounts(temporary.storage).event, before.event + 1);
  });
});
