import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import { registry } from "../contract/registry.ts";
import { errorResponse, errorValue, materializeError } from "./envelope.ts";
import { headersMiddleware } from "./headers.ts";
import { renderMiddleware } from "./render.ts";
import { authMiddleware } from "./auth.ts";
import { routeMiddleware } from "./route.ts";
import { authorizeMiddleware } from "./authorize.ts";
import { dispatchMiddleware } from "./dispatch.ts";
import { createIdempotency } from "./idempotency.ts";
import { defaultIdempotencySettings } from "./idempotency-store.ts";
import type { Handler } from "./app.ts";
import { koaFromHono } from "./koa-bridge.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";
import {
  createTestApp,
  HARNESS_ACTOR_FIXTURE,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../test/helpers/app.ts";
import {
  createMigratedStorage,
  tableCounts,
} from "../../../test/helpers/database.ts";

function concretePath(operationId: string): string {
  const entry = registry.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (entry === undefined) {
    throw new Error(`no such operation: ${operationId}`);
  }
  return `/v1/${entry.path
    .map((segment) => (segment.kind === "parameter" ? "x_01" : segment.value))
    .join("/")}`;
}

describe("src/http/server/authorize.test", () => {
  it("GET /v1/node, GET /v1/blob/<hash> and GET /v1/project/<id>/plan/revision answer 200 to a harness with a bound handler", async () => {
    const app = await createTestApp({
      resolveActor: () => HARNESS_ACTOR_FIXTURE,
      handlers: {
        "node.list": () => ({ kind: "json", status: 200, body: { nodes: [] } }),
        "blob.show": () => ({
          kind: "json",
          status: 200,
          body: { hash: "sha256:9f2a" },
        }),
        "plan.revisions": () => ({
          kind: "json",
          status: 200,
          body: { revisions: [] },
        }),
      },
    });
    const node = await app.get("/v1/node");
    assert.equal(node.status, 200);
    const blob = await app.get("/v1/blob/sha256:9f2a");
    assert.equal(blob.status, 200);
    const revisions = await app.get(concretePath("plan.revisions"));
    assert.equal(revisions.status, 200);
  });

  it("GET /v1/provider, GET /v1/status and GET /v1/event answer 403 actor-forbidden to a harness, naming the operation", async () => {
    const app = await createTestApp({
      resolveActor: () => HARNESS_ACTOR_FIXTURE,
    });
    const cases = [
      ["/v1/provider", "provider.list"],
      ["/v1/status", "system.status"],
      ["/v1/event", "event.list"],
    ] as const;
    for (const [path, operationId] of cases) {
      const response = await app.get(path);
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, "actor-forbidden", path);
      assert.ok(
        response.body.error.message.includes(operationId),
        `${path} message names ${operationId}`,
      );
      assert.ok(
        response.body.error.message.includes("harness"),
        `${path} message names the refused kind`,
      );
    }
  });

  it("the same three routes do not answer 403 to the bootstrap human", async () => {
    const app = await createTestApp({
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
    });
    for (const path of ["/v1/provider", "/v1/status", "/v1/event"]) {
      const response = await app.get(path);
      assert.notEqual(response.status, 403, path);
    }
  });

  it("a stubbed route answers 403 to a harness and 501 to the human, with no internal error", async () => {
    const stubbed = registry.find((entry) => entry.status === "stubbed");
    assert.ok(stubbed !== undefined, "the registry holds a stubbed row");
    const path = concretePath(stubbed.operationId);
    const harnessApp = await createTestApp({
      resolveActor: () => HARNESS_ACTOR_FIXTURE,
    });
    const refused = await harnessApp.get(path);
    assert.equal(refused.status, 403, stubbed.operationId);
    assert.equal(refused.body.error.code, "actor-forbidden");
    assert.equal(harnessApp.internalErrors().length, 0);
    const humanApp = await createTestApp({
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
    });
    const unimplemented = await humanApp.get(path);
    assert.equal(unimplemented.status, 501, stubbed.operationId);
    assert.equal(unimplemented.body.error.code, "not-implemented");
    assert.equal(humanApp.internalErrors().length, 0);
  });

  it("neither the refused provider.list nor a stubbed route writes state", async () => {
    const temporary = createMigratedStorage();
    try {
      const wouldWrite: Handler = () => {
        temporary.storage.transact((transaction) => {
          transaction.run(
            "INSERT INTO blob (hash, size, content, created_at) VALUES (?, ?, ?, ?)",
            ["sha256:write-probe", 0, new Uint8Array(0), 0],
          );
        });
        return { kind: "json", status: 200, body: { providers: [] } };
      };
      const app = await createTestApp({
        resolveActor: () => HARNESS_ACTOR_FIXTURE,
        handlers: { "provider.list": wouldWrite },
      });
      const stubbed = registry.find((entry) => entry.status === "stubbed");
      assert.ok(stubbed !== undefined, "the registry holds a stubbed row");
      const before = tableCounts(temporary.storage);
      const refused = await app.get("/v1/provider");
      assert.equal(refused.status, 403);
      const stubbedResponse = await app.get(concretePath(stubbed.operationId));
      assert.equal(stubbedResponse.status, 403);
      assert.deepEqual(tableCounts(temporary.storage), before);
    } finally {
      temporary.dispose();
    }
  });

  it("a refusal precedes the body parse: a harness POST with a malformed JSON body answers 403, not 400", async () => {
    const app = await createTestApp({
      resolveActor: () => HARNESS_ACTOR_FIXTURE,
      handlers: {
        "provider.register": () => ({
          kind: "json",
          status: 200,
          body: { ok: true },
        }),
      },
    });
    const response = await app
      .post("/v1/provider")
      .set("Content-Type", "application/json")
      .send('{"oops');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "actor-forbidden");
  });

  it("a refusal reserves no idempotency key", async () => {
    const { middleware, store } = createIdempotency({
      settings: defaultIdempotencySettings,
      now: () => 1000,
      schedule: () => () => {},
    });
    let calls = 0;
    const onInternalError: (error: unknown) => void = () => {};
    const hono = new Hono<AppEnv>();
    hono.onError((error, c) => {
      const value = errorValue(error);
      const materialized = materializeError(value);
      if (materialized.internal) {
        onInternalError(value);
      }
      return errorResponse(materialized, demand(c, "headers"));
    });
    hono.use("*", headersMiddleware());
    hono.use("*", renderMiddleware());
    hono.use("*", routeMiddleware());
    hono.use(
      "*",
      authMiddleware({
        token: "test-token",
        resolveActor: () => HARNESS_ACTOR_FIXTURE,
      }),
    );
    hono.use("*", authorizeMiddleware());
    const reservedStage = middleware as unknown as MiddlewareHandler<AppEnv>;
    hono.use("*", reservedStage);
    const dispatchStage = dispatchMiddleware({
      handlers: {
        "provider.register": () => {
          calls += 1;
          return { kind: "json", status: 200, body: { ok: true } };
        },
      },
    }) as unknown as MiddlewareHandler<AppEnv>;
    hono.use("*", dispatchStage);
    const agent = await loopbackAgent(koaFromHono(hono));
    const response = await agent
      .post("/v1/provider")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "k1")
      .send({ name: "probe" });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "actor-forbidden");
    assert.equal(store.size(), 0);
    assert.equal(calls, 0);
  });
});
