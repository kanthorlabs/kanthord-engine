import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";
import type Koa from "koa";

import { errorResponse, errorValue, materializeError } from "./envelope.ts";
import { authMiddleware, bearerToken } from "./auth.ts";
import { headersMiddleware } from "./headers.ts";
import { koaFromHono } from "./koa-bridge.ts";
import { renderMiddleware } from "./render.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";
import type { ActorRow } from "../../domain/actor.ts";
import { bootstrapActorId } from "../../domain/actor.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";
import { BOOTSTRAP_ACTOR_FIXTURE } from "../../../test/helpers/app.ts";

function defaultResolveActor(presented: string): ActorRow | null {
  if (presented === "test-token" || presented === "") {
    return BOOTSTRAP_ACTOR_FIXTURE;
  }
  return null;
}

type OnInternalError = (error: unknown) => void;

function buildFixture(
  token: string,
  resolveActor: (presented: string) => ActorRow | null,
  onInternalError: OnInternalError = () => {},
): { hono: Hono<AppEnv>; recorded: () => ActorRow | undefined } {
  let recorded: ActorRow | undefined;
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
  hono.use("*", authMiddleware({ token, resolveActor }));
  hono.all("*", async (c) => {
    recorded = demand(c, "actor");
    c.set("result", { kind: "json", status: 200, body: { reached: true } });
  });
  return { hono, recorded: () => recorded };
}

function buildApp(
  token: string,
  resolveActor: (presented: string) => ActorRow | null = defaultResolveActor,
  onInternalError?: OnInternalError,
): Koa {
  return koaFromHono(buildFixture(token, resolveActor, onInternalError).hono);
}

function buildRecordingApp(
  token: string,
  resolveActor: (presented: string) => ActorRow | null,
): { app: Koa; recorded: () => ActorRow | undefined } {
  const fixture = buildFixture(token, resolveActor);
  return { app: koaFromHono(fixture.hono), recorded: fixture.recorded };
}

function sourceText(): string {
  return readFileSync(resolve(import.meta.dirname, "./auth.ts"), "utf8");
}

const harnessRow: ActorRow = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
  kind: "harness",
  name: "harness-a",
  tokenSha256: new Uint8Array(32),
  registeredBy: bootstrapActorId,
  createdAt: 1720000000000,
  revokedAt: null,
  revokedBy: null,
};

describe("src/http/server/auth.test", () => {
  it("parses the bearer scheme case-insensitively and rejects everything else", () => {
    const cases: ReadonlyArray<readonly [string | undefined, string | null]> = [
      [undefined, null],
      ["", null],
      ["abc", null],
      ["Bearer", null],
      ["Bearer ", null],
      ["Bearer abc", "abc"],
      ["bearer abc", "abc"],
      ["BEARER abc", "abc"],
      ["Basic abc", null],
      ["Bearer abc def", "abc def"],
    ];
    for (const [header, expected] of cases) {
      assert.equal(bearerToken(header), expected, JSON.stringify(header));
    }
  });

  it("stays route-independent by construction", () => {
    const source = sourceText();
    assert.equal(source.includes("match"), false);
    assert.equal(source.includes("registry"), false);
    assert.equal(source.includes("operationId"), false);
  });

  it("no longer names node:crypto and no longer exports tokensMatch", () => {
    const source = sourceText();
    assert.equal(source.includes("timingSafeEqual"), false);
    assert.equal(source.includes("createHash"), false);
    assert.equal(source.includes("node:crypto"), false);
    assert.equal(/export\s+function\s+tokensMatch/.test(source), false);
  });

  it("answers 401 unauthenticated when no token is presented", async () => {
    const response = await (
      await loopbackAgent(buildApp("test-token"))
    ).get("/v1/health");
    assert.equal(response.body.reached, undefined);
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: { code: "unauthenticated", message: "no bearer token" },
    });
  });

  it("answers 401 with the not-valid message when the token is wrong", async () => {
    const response = await (
      await loopbackAgent(buildApp("test-token"))
    )
      .get("/v1/health")
      .set("Authorization", "Bearer wrong");
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: {
        code: "unauthenticated",
        message: "the bearer token is not valid",
      },
    });
  });

  it("answers the identical not-valid body for every unresolved token, whatever the resolver", async () => {
    const resolvers: ReadonlyArray<{
      name: string;
      resolve: (presented: string) => ActorRow | null;
    }> = [
      { name: "unrecognized shape", resolve: () => null },
      {
        name: "unknown actor id",
        resolve: (presented) => (presented === "" ? null : null),
      },
      {
        name: "revoked actor",
        resolve: (presented) => {
          if (presented === "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR.x") return null;
          return null;
        },
      },
    ];
    const bodies: unknown[] = [];
    for (const { name, resolve } of resolvers) {
      const response = await (
        await loopbackAgent(buildApp("test-token", resolve))
      )
        .get("/v1/health")
        .set("Authorization", "Bearer whatever");
      assert.equal(response.status, 401, name);
      const expected = {
        error: {
          code: "unauthenticated",
          message: "the bearer token is not valid",
        },
      };
      assert.deepEqual(response.body, expected, name);
      bodies.push(response.body);
    }
    assert.deepEqual(bodies[1], bodies[0]);
    assert.deepEqual(bodies[2], bodies[0]);
  });

  it("treats a wrong scheme as a missing token", async () => {
    const response = await (
      await loopbackAgent(buildApp("test-token"))
    )
      .get("/v1/health")
      .set("Authorization", "Basic test-token");
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: { code: "unauthenticated", message: "no bearer token" },
    });
  });

  it("answers 200 when the bearer token matches", async () => {
    const response = await (
      await loopbackAgent(buildApp("test-token"))
    )
      .get("/v1/health")
      .set("Authorization", "Bearer test-token");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
  });

  it("refuses every path and method with the same 401", async () => {
    const requests = [
      (await loopbackAgent(buildApp("test-token"))).get("/v1/health"),
      (await loopbackAgent(buildApp("test-token"))).get("/v1/anything"),
      (await loopbackAgent(buildApp("test-token"))).post("/v1/repository"),
      (await loopbackAgent(buildApp("test-token"))).delete("/v1/provider/x"),
    ];
    for (const pending of requests) {
      const response = await pending;
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, {
        error: { code: "unauthenticated", message: "no bearer token" },
      });
    }
  });

  it("a header the resolver accepts reaches the terminal handler and the resolved actor lands on the actor variable", async () => {
    const { app, recorded } = buildRecordingApp("test-token", (presented) =>
      presented === "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR.s3cr3t"
        ? harnessRow
        : null,
    );
    const response = await (
      await loopbackAgent(app)
    )
      .get("/v1/health")
      .set("Authorization", "Bearer actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR.s3cr3t");
    assert.equal(response.status, 200);
    assert.equal(recorded(), harnessRow);
  });

  it("with an empty configured token, a request with no Authorization header reaches the terminal handler with the bootstrap actor, and the resolver is called exactly once with an empty string", async () => {
    const calls: string[] = [];
    const { app, recorded } = buildRecordingApp("", (presented) => {
      calls.push(presented);
      return BOOTSTRAP_ACTOR_FIXTURE;
    });
    const response = await (await loopbackAgent(app)).get("/v1/health");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
    assert.equal(recorded(), BOOTSTRAP_ACTOR_FIXTURE);
    assert.deepEqual(calls, [""]);
  });

  it("with an empty configured token, an arbitrary Authorization header still reaches the handler with the bootstrap actor", async () => {
    const calls: string[] = [];
    const { app, recorded } = buildRecordingApp("", (presented) => {
      calls.push(presented);
      return BOOTSTRAP_ACTOR_FIXTURE;
    });
    const response = await (
      await loopbackAgent(app)
    )
      .get("/v1/health")
      .set("Authorization", "Bearer anything");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
    assert.equal(recorded(), BOOTSTRAP_ACTOR_FIXTURE);
    assert.deepEqual(calls, [""]);
  });

  it("resolveActor is called exactly once per request with the exact presented token, including a token that holds a dot", async () => {
    const presented = "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR.s3cr3t.value";
    const calls: string[] = [];
    const app = buildApp("test-token", (value) => {
      calls.push(value);
      return value === presented ? BOOTSTRAP_ACTOR_FIXTURE : null;
    });
    const response = await (
      await loopbackAgent(app)
    )
      .get("/v1/health")
      .set("Authorization", `Bearer ${presented}`);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [presented]);
  });
});
