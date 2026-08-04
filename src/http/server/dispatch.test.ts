import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa from "koa";

import { envelopeMiddleware } from "./envelope.ts";
import { routeMiddleware } from "./route.ts";
import { dispatchMiddleware } from "./dispatch.ts";
import { createApp, BindingError } from "./app.ts";
import type { Handler, HandlerContext, TransportSettings } from "./app.ts";
import { httpError } from "../contract/errors.ts";
import { registry } from "../contract/registry.ts";
import { renderPath } from "../contract/path.ts";
import { createTestApp, unimplementedFor } from "../../../test/helpers/app.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

const settings: TransportSettings = {
  token: "test-token",
  allowedHosts: ["kanthord.test"],
};

const okHandler: Handler = () => ({ status: 200, body: { ok: true } });

describe("src/http/server/dispatch.test", () => {
  it("a stubbed route answers 501 with its ships-in message from an empty handler map", async () => {
    const app = await createTestApp();
    const response = await app.post("/v1/node/task_01JQ8ZAN9P/unblock");
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "node.unblock ships in phase-2",
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
          "node.unblock": () => {
            calls += 1;
            return { status: 200, body: { ok: true } };
          },
        },
      }),
    );
    const response = await (
      await loopbackAgent(app)
    ).post("/v1/node/task_01/unblock");
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "node.unblock ships in phase-2",
      },
    });
    assert.equal(calls, 0);
  });

  it("a stubbed route carrying a malformed JSON body answers 501 and the body is never parsed", async () => {
    const app = await createTestApp();
    const response = await app
      .post("/v1/node/task_01/unblock")
      .set("Content-Type", "application/json")
      .send('{"oops');
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "node.unblock ships in phase-2",
      },
    });
  });

  it("a stubbed route carrying a valid JSON body answers 501 and never reaches a handler", async () => {
    const app = await createTestApp();
    const response = await app
      .post("/v1/node/task_01/unblock")
      .set("Content-Type", "application/json")
      .send('{"ok":1}');
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "node.unblock ships in phase-2",
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
          onInternalError: () => {},
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
          onInternalError: () => {},
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
          onInternalError: () => {},
        }),
      (error: unknown) =>
        error instanceof BindingError && error.message.includes("zzz.invented"),
    );
  });

  it("createApp refuses a stubbed id in handlers", () => {
    const stubbed = { "node.unblock": okHandler };
    assert.throws(
      () =>
        createApp({
          settings,
          handlers: stubbed,
          unimplemented: unimplementedFor(stubbed),
          onInternalError: () => {},
        }),
      (error: unknown) =>
        error instanceof BindingError && error.message.includes("node.unblock"),
    );
  });

  it("createApp refuses a stubbed id in unimplemented", () => {
    assert.throws(
      () =>
        createApp({
          settings,
          handlers: {},
          unimplemented: ["node.unblock"],
          onInternalError: () => {},
        }),
      (error: unknown) =>
        error instanceof BindingError && error.message.includes("node.unblock"),
    );
  });

  it("the complete binding does not throw and derives twenty-one unimplemented ids", () => {
    const complete = { "system.health": okHandler, "system.db": okHandler };
    const unimplemented = unimplementedFor(complete);
    assert.equal(unimplemented.length, 21);
    assert.doesNotThrow(() =>
      createApp({
        settings,
        handlers: complete,
        unimplemented,
        onInternalError: () => {},
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

  it("every one of the thirty stubbed operations answers 501 from an empty handler map", async () => {
    const app = await createTestApp();
    let driven = 0;
    for (const entry of registry) {
      if (entry.status !== "stubbed") {
        continue;
      }
      const path = renderPath(entry.path).replace(/:[^/]+/g, "x_01");
      const method =
        entry.method === "DELETE"
          ? "del"
          : (entry.method.toLowerCase() as "get" | "post" | "put");
      const response = await app[method](path);
      assert.equal(response.status, 501, entry.operationId);
      assert.equal(
        response.body.error.code,
        "not-implemented",
        entry.operationId,
      );
      driven += 1;
    }
    assert.equal(driven, 30);
  });
});
