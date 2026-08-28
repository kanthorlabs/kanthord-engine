import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BindingError,
  createApp,
  handlerStatuses,
  bodylessStatuses,
} from "./app.ts";
import type { Handler, TransportSettings } from "./app.ts";
import { noopWaits } from "../../../test/helpers/wait-registry.ts";
import { loopbackServer } from "../../../test/helpers/agent.ts";
import { registry } from "../contract/registry.ts";
import { renderPath } from "../contract/path.ts";
import {
  createTestApp,
  createSocketTestApp,
  unimplementedFor,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../test/helpers/app.ts";

const statusHandler: Handler = () => ({
  kind: "json",
  status: 200,
  body: { ok: true },
});
const healthHandler: Handler = () => ({
  kind: "json",
  status: 200,
  body: { status: "ok", dependencies: [] },
});
const handlers = {
  "system.status": statusHandler,
  "system.health": healthHandler,
};

const GENERIC_500 = {
  error: { code: "internal-error", message: "internal error" },
};

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

type RawReply = Readonly<{ status: number; body: Buffer }>;

function rawHttp10(target: number, path: string): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: target }, () => {
      socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const raw = Buffer.concat(chunks);
      const separator = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, separator).toString("utf8");
      const body = raw.subarray(separator + 4);
      const statusLine = head.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1]);
      resolve({ status, body });
    });
  });
}

describe("src/http/server/app.test", () => {
  it("the handler status set and the bodyless status set are the exact closed lists", () => {
    assert.deepEqual(handlerStatuses, [200, 204, 206, 304]);
    assert.deepEqual(bodylessStatuses, [204, 304]);
  });

  it("a GET carrying a body reaches the route, and the handler reads no body", async () => {
    let seen: unknown = "unread";
    let carried = "";
    const app = await createSocketTestApp({
      handlers: {
        "system.health": (context) => {
          seen = context.body;
          carried = context.headers["content-length"] ?? "";
          return { kind: "json", status: 200, body: { status: "ok" } };
        },
      },
    });

    const response = await app.get("/v1/health").send({ ignored: true });

    assert.equal(carried, "16");
    assert.equal(seen, undefined);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok" });
  });

  it("the browser defences apply to system.health like every route", async () => {
    const app = await createTestApp({ handlers });
    const clean = await app.get("/v1/health");
    assert.equal(clean.status, 200);
    const withOrigin = await app
      .get("/v1/health")
      .set("Origin", "http://evil.example");
    assert.equal(withOrigin.status, 403);
    assert.equal(withOrigin.body.error.code, "origin-forbidden");
    const withHost = await app.get("/v1/health").set("Host", "evil.example");
    assert.equal(withHost.status, 403);
    assert.equal(withHost.body.error.code, "host-forbidden");
  });

  it("system.health requires the bearer token like every other route", async () => {
    const app = await createTestApp({ handlers });
    const response = await app.raw
      .get("/v1/health")
      .set("Host", "kanthord.test");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
  });

  it("origin-forbidden wins over host-forbidden", async () => {
    const app = await createTestApp({ handlers });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "evil.example")
      .set("Origin", "http://evil.example");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "origin-forbidden");
  });

  it("a browser check wins over the token", async () => {
    const app = await createTestApp({ handlers });
    const hostMiss = await app.raw
      .get("/v1/status")
      .set("Host", "evil.example");
    assert.equal(hostMiss.status, 403);
    assert.equal(hostMiss.body.error.code, "host-forbidden");
    const originMiss = await app.raw
      .get("/v1/status")
      .set("Origin", "http://x");
    assert.equal(originMiss.status, 403);
    assert.equal(originMiss.body.error.code, "origin-forbidden");
  });

  it("401 wins over 404", async () => {
    const app = await createTestApp({ handlers });
    const noToken = await app.raw.get("/v1/nope").set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, "unauthenticated");
    const withToken = await app.get("/v1/nope");
    assert.equal(withToken.status, 404);
    assert.equal(withToken.body.error.code, "not-found");
  });

  it("every path answers identically without a token", async () => {
    const app = await createTestApp({ handlers });
    type Drive = { method: "get" | "post" | "put" | "del"; path: string };
    const requests: Drive[] = [];
    for (const entry of registry) {
      const path = renderPath(entry.path).replace(/:[^/]+/g, "x_01");
      const method =
        entry.method === "DELETE"
          ? "del"
          : (entry.method.toLowerCase() as "get" | "post" | "put");
      requests.push({ method, path });
    }
    requests.push({ method: "get", path: "/v1/nope" });
    requests.push({ method: "get", path: "/v1/" });
    assert.equal(requests.length, 71);

    const responses: Array<{ status: number; body: unknown }> = [];
    for (const { method, path } of requests) {
      const response = await app.raw[method](path).set("Host", "kanthord.test");
      responses.push({ status: response.status, body: response.body });
    }
    const first = responses[0];
    assert.ok(first, "the request set is not empty");
    assert.equal(first.status, 401);
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, first.body);
    }
  });

  it("the token wins over 501", async () => {
    const app = await createTestApp({ handlers });
    const noToken = await app.raw
      .post("/v1/node/task_01/unblock")
      .set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, "unauthenticated");
    const withToken = await app.post("/v1/node/task_01/unblock");
    assert.equal(withToken.status, 501);
    assert.equal(withToken.body.error.code, "not-implemented");
  });

  it("a clean request reaches the handler", async () => {
    const app = await createTestApp({ handlers });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  });

  it("a body is parsed only after every check", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        ...handlers,
        "repository.register": () => {
          calls += 1;
          return { kind: "json", status: 200, body: { ok: true } };
        },
      },
    });
    const response = await app.raw
      .post("/v1/repository")
      .set("Host", "kanthord.test")
      .send({ url: "x" });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  });

  it("with an allowed origin, an unauthenticated request still carries the header", async () => {
    const app = await createTestApp({
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
  });

  it("with an allowed origin, a valid token and host reaches the route and carries the header", async () => {
    const app = await createTestApp({
      handlers,
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 200);
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
  });

  it("Host beats preflight: an OPTIONS with an allowed origin but a disallowed Host answers 403 host-forbidden", async () => {
    const app = await createTestApp({
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .options("/v1/status")
      .set("Host", "evil.example")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "host-forbidden");
  });

  it("Origin beats host: an OPTIONS with a disallowed origin and a disallowed Host answers 403 origin-forbidden with no allow-origin header", async () => {
    const app = await createTestApp({
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .options("/v1/status")
      .set("Host", "evil.example")
      .set("Origin", "http://evil.test");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "origin-forbidden");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });

  it("preflight beats auth: an OPTIONS with an allowed origin and host, no Authorization, answers 204 without resolving an actor", async () => {
    let resolutions = 0;
    const app = await createTestApp({
      allowedOrigins: ["http://localhost:8080"],
      resolveActor: (presented) => {
        resolutions += 1;
        return BOOTSTRAP_ACTOR_FIXTURE;
      },
    });
    const response = await app.raw
      .options("/v1/status")
      .set("Host", "kanthord.test")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 204);
    assert.equal(resolutions, 0);
  });

  it("preflight beats route: an OPTIONS to a non-existent path answers the identical 204 headers as an OPTIONS to a real path, without resolving an actor", async () => {
    let resolutions = 0;
    const app = await createTestApp({
      allowedOrigins: ["http://localhost:8080"],
      resolveActor: (presented) => {
        resolutions += 1;
        return BOOTSTRAP_ACTOR_FIXTURE;
      },
    });
    const statusResponse = await app.raw
      .options("/v1/status")
      .set("Host", "kanthord.test")
      .set("Origin", "http://localhost:8080");
    assert.equal(statusResponse.status, 204);
    const missingResponse = await app.raw
      .options("/v1/does/not/exist")
      .set("Host", "kanthord.test")
      .set("Origin", "http://localhost:8080");
    assert.equal(missingResponse.status, 204);
    const headerNames = [
      "access-control-allow-origin",
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-max-age",
    ];
    for (const name of headerNames) {
      assert.deepEqual(
        missingResponse.headers[name],
        statusResponse.headers[name],
      );
    }
    assert.equal(resolutions, 0);
  });

  it("auth still beats route for a non-preflight: a GET with an allowed origin and host, no token, answers 401 and carries the origin header", async () => {
    const app = await createTestApp({
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
  });

  it("an OPTIONS with no Origin is not a preflight: it falls through to a 404 not-found", async () => {
    const app = await createTestApp({
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .options("/v1/status")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token");
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("the empty-list table: a routed route, a stubbed route and system.health each answer origin-forbidden for a disallowed or null Origin, and their own explicit status with no Origin and no allow-origin header", async () => {
    const app = await createTestApp({ handlers });
    const routedEntry = registry.find(
      (entry) =>
        entry.status === "routed" && entry.operationId === "system.status",
    );
    const stubbedEntry = registry.find(
      (entry) =>
        entry.status === "stubbed" && entry.operationId === "agent.list",
    );
    const healthEntry = registry.find(
      (entry) => entry.operationId === "system.health",
    );
    assert.ok(routedEntry, "system.status exists and is routed");
    assert.ok(stubbedEntry, "agent.list exists and is stubbed");
    assert.ok(healthEntry, "system.health exists");

    const table = [
      { entry: routedEntry, expectedStatus: 200 },
      { entry: stubbedEntry, expectedStatus: 501 },
      { entry: healthEntry, expectedStatus: 200 },
    ];

    for (const { entry, expectedStatus } of table) {
      const path = renderPath(entry.path).replace(/:[^/]+/g, "x_01");
      const method =
        entry.method === "DELETE"
          ? "del"
          : (entry.method.toLowerCase() as "get" | "post" | "put");

      const evil = await app.raw[method](path)
        .set("Host", "kanthord.test")
        .set("Authorization", "Bearer test-token")
        .set("Origin", "http://evil.test");
      assert.equal(evil.status, 403);
      assert.equal(evil.body.error.code, "origin-forbidden");
      assert.equal(evil.headers["access-control-allow-origin"], undefined);

      const nullOrigin = await app.raw[method](path)
        .set("Host", "kanthord.test")
        .set("Authorization", "Bearer test-token")
        .set("Origin", "null");
      assert.equal(nullOrigin.status, 403);
      assert.equal(nullOrigin.body.error.code, "origin-forbidden");

      const noOrigin = await app.raw[method](path)
        .set("Host", "kanthord.test")
        .set("Authorization", "Bearer test-token");
      assert.equal(noOrigin.status, expectedStatus);
      assert.equal(noOrigin.headers["access-control-allow-origin"], undefined);
    }
  });

  it("with an allowed origin, a valid token and host, a GET /v1/blob/:hash carries the exact expose-headers value", async () => {
    const app = await createTestApp({
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/blob/sha256:test")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "http://localhost:8080");
    assert.equal(
      response.headers["access-control-expose-headers"],
      "etag, accept-ranges, content-range",
    );
  });

  it("with the default empty allowedOrigins and no Origin header, a GET /v1/blob/:hash carries no expose-headers value", async () => {
    const app = await createTestApp({});
    const response = await app.raw
      .get("/v1/blob/sha256:test")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token");
    assert.equal(response.headers["access-control-expose-headers"], undefined);
  });

  it("a full-chain authentication failure carries access-control-allow-origin and exactly vary: origin", async () => {
    const app = await createTestApp({
      handlers,
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(response.headers.vary, "Origin");
  });

  it("a full-chain routing failure carries access-control-allow-origin and exactly vary: origin", async () => {
    const app = await createTestApp({
      handlers,
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/nope")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(response.headers.vary, "Origin");
  });

  it("a full-chain handler Error carries the cors headers, answers the exact generic 500 envelope and reports once", async () => {
    const boom = new Error("boom");
    const app = await createTestApp({
      handlers: {
        "system.status": () => {
          throw boom;
        },
      },
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, GENERIC_500);
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(response.headers.vary, "Origin");
    assert.equal(app.internalErrors().length, 1);
    assert.strictEqual(app.internalErrors()[0], boom);
  });

  it("a keyed full-chain handler Error still reports exactly once", async () => {
    const boom = new Error("boom");
    const app = await createTestApp({
      handlers: {
        "project.create": () => {
          throw boom;
        },
      },
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app
      .post("/v1/project")
      .set("Origin", "http://localhost:8080")
      .set("Idempotency-Key", "01JQ8ZAN9P0ABCDEFGHJKMNPQR")
      .send({ name: "a" });
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, GENERIC_500);
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(app.internalErrors().length, 1);
    assert.strictEqual(app.internalErrors()[0], boom);
  });

  it("a full-chain handler that throws a string answers the generic 500 envelope and reports the exact value", async () => {
    const app = await createTestApp({
      handlers: {
        "system.status": () => {
          throw "failure";
        },
      },
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, GENERIC_500);
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(app.internalErrors().length, 1);
    assert.strictEqual(app.internalErrors()[0], "failure");
  });

  it("a full-chain handler that throws undefined answers the generic 500 envelope and reports the exact value", async () => {
    const app = await createTestApp({
      handlers: {
        "system.status": () => {
          throw undefined;
        },
      },
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, GENERIC_500);
    assert.equal(app.internalErrors().length, 1);
    assert.strictEqual(app.internalErrors()[0], undefined);
  });

  it("an http/1.0 request with no Host header answers the exact host-forbidden message through the bridge, not a bare 400", async (t) => {
    const created = createApp({
      settings: {
        token: "test-token",
        allowedHosts: ["kanthord.test"],
        allowedOrigins: [],
      },
      handlers: {},
      unimplemented: unimplementedFor({}),
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
      waits: noopWaits(),
    });
    const server = await loopbackServer(created.hono);
    t.after(() => {
      server.close();
    });

    const reply = await rawHttp10(port(server), "/v1/status");

    assert.equal(reply.status, 403);
    assert.deepEqual(JSON.parse(reply.body.toString("utf8")), {
      error: {
        code: "host-forbidden",
        message: "the request carried no Host header",
      },
    });
  });

  it("createApp returns the hono application and a cancel handle, and the handle reaches the registry", () => {
    let cancelled = false;
    const waits = {
      wait: () => Promise.resolve([]),
      cancelAll: () => {
        cancelled = true;
      },
    };
    const result = createApp({
      settings: {
        token: "test-token",
        allowedHosts: ["kanthord.test"],
        allowedOrigins: [],
      },
      handlers: {},
      unimplemented: unimplementedFor({}),
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
      waits,
    });
    assert.deepEqual(Object.keys(result).sort(), ["cancelWaits", "hono"]);
    result.cancelWaits();
    assert.equal(cancelled, true);
  });

  it("createApp without a schedule builds an app whose core names no runtime or unref", () => {
    const result = createApp({
      settings: {
        token: "test-token",
        allowedHosts: ["kanthord.test"],
        allowedOrigins: [],
      },
      handlers: {},
      unimplemented: unimplementedFor({}),
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
      waits: noopWaits(),
    });
    const source = readFileSync(resolve(import.meta.dirname, "app.ts"), "utf8");

    assert.ok(result.hono);
    assert.equal(source.includes("runtime/"), false);
    assert.equal(source.includes("unref"), false);
  });

  it("the default schedule runs and cancels through an app built without a schedule", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let firstEnteredResolve!: () => void;
    const firstEntered = new Promise<void>((resolveEntered) => {
      firstEnteredResolve = resolveEntered;
    });
    let secondEnteredResolve!: () => void;
    const secondEntered = new Promise<void>((resolveEntered) => {
      secondEnteredResolve = resolveEntered;
    });
    let firstReleaseResolve!: () => void;
    const firstRelease = new Promise<void>((resolveRelease) => {
      firstReleaseResolve = resolveRelease;
    });
    let secondReleaseResolve!: () => void;
    const secondRelease = new Promise<void>((resolveRelease) => {
      secondReleaseResolve = resolveRelease;
    });
    let calls = 0;
    const handlers: Readonly<Record<string, Handler>> = {
      "project.create": async () => {
        calls += 1;
        if (calls === 1) {
          firstEnteredResolve();
          await firstRelease;
        } else {
          secondEnteredResolve();
          await secondRelease;
        }
        return { kind: "json", status: 200, body: { ok: true } };
      },
    };
    let clockPhase: "first" | "timeout" = "first";
    let clockCalls = 0;
    let joinedReachedResolve!: () => void;
    const joinedReached = new Promise<void>((resolveReached) => {
      joinedReachedResolve = resolveReached;
    });
    let timeoutDuplicateReachedResolve!: () => void;
    const timeoutDuplicateReached = new Promise<void>((resolveReached) => {
      timeoutDuplicateReachedResolve = resolveReached;
    });
    const now = (): number => {
      clockCalls += 1;
      if (clockCalls === 2) {
        if (clockPhase === "first") {
          joinedReachedResolve();
        } else {
          timeoutDuplicateReachedResolve();
        }
      }
      return 0;
    };
    const created = createApp({
      settings: {
        token: "test-token",
        allowedHosts: ["kanthord.test"],
        allowedOrigins: [],
      },
      handlers,
      unimplemented: unimplementedFor(handlers),
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
      idempotency: {
        ttlSeconds: 300,
        joinTimeoutSeconds: 1,
        maxEntries: 256,
        maxBytes: 8_388_608,
      },
      now,
      waits: noopWaits(),
    });
    assert.ok(created.hono);
    const request = (key: string): Promise<Response> =>
      Promise.resolve(
        created.hono.fetch(
          new Request("http://kanthord.test/v1/project", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer test-token",
              "Idempotency-Key": key,
              Host: "kanthord.test",
            },
            body: JSON.stringify({ name: "atlas" }),
          }),
        ),
      );

    const first = request("01JQ8ZAN9P0ABCDEFGHJKMNPQR");
    await firstEntered;
    let joinedSettled = false;
    const joined = request("01JQ8ZAN9P0ABCDEFGHJKMNPQR").then((response) => {
      joinedSettled = true;
      return response;
    });
    await joinedReached;
    assert.equal(calls, 1);
    assert.equal(joinedSettled, false);

    firstReleaseResolve();
    const completed = await first;
    assert.equal(completed.status, 200);
    const replay = await joined;
    assert.equal(replay.status, 200);
    t.mock.timers.tick(5000);
    assert.equal(joinedSettled, true);

    clockPhase = "timeout";
    clockCalls = 0;
    const timedOutFirst = request("01JQ8ZAN9P0ABCDEFGHJKMNPQS");
    await secondEntered;
    let timedOutSettled = false;
    const timedOutSecond = request("01JQ8ZAN9P0ABCDEFGHJKMNPQS").then(
      (response) => {
        timedOutSettled = true;
        return response;
      },
    );
    await timeoutDuplicateReached;
    assert.equal(calls, 2);
    assert.equal(timedOutSettled, false);
    t.mock.timers.tick(999);
    assert.equal(timedOutSettled, false);
    t.mock.timers.tick(1);
    const timedOut = await timedOutSecond;
    assert.equal(timedOut.status, 503);

    secondReleaseResolve();
    const timedOutCompleted = await timedOutFirst;
    assert.equal(timedOutCompleted.status, 200);

    const source = readFileSync(resolve(import.meta.dirname, "app.ts"), "utf8");
    assert.equal(source.includes("setTimeout"), true);
    assert.equal(source.includes("clearTimeout"), true);
  });

  it("binding system.health and system.db leaves forty-two unimplemented ids", () => {
    const bound = {
      "system.health": healthHandler,
      "system.db": statusHandler,
    };
    assert.equal(unimplementedFor(bound).length, 42);
  });

  it("createApp throws the exact binding error before reading settings, idempotency, now or schedule", () => {
    const reads = { settings: 0, idempotency: 0, now: 0, schedule: 0 };
    const dependencies = {
      get settings(): TransportSettings {
        reads.settings += 1;
        throw new Error("settings was read");
      },
      handlers: {},
      unimplemented: [],
      get idempotency(): NonNullable<
        Parameters<typeof createApp>[0]["idempotency"]
      > {
        reads.idempotency += 1;
        throw new Error("idempotency was read");
      },
      get now(): () => number {
        reads.now += 1;
        throw new Error("now was read");
      },
      get schedule(): NonNullable<Parameters<typeof createApp>[0]["schedule"]> {
        reads.schedule += 1;
        throw new Error("schedule was read");
      },
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
      waits: noopWaits(),
    };
    const routedIds = registry
      .filter((entry) => entry.status === "routed")
      .map((entry) => entry.operationId);
    assert.throws(
      () => createApp(dependencies),
      (error: unknown) => {
        assert.ok(error instanceof BindingError);
        assert.equal(
          error.message,
          `incomplete transport binding: ${routedIds.join(", ")}`,
        );
        return true;
      },
    );
    assert.deepEqual(reads, {
      settings: 0,
      idempotency: 0,
      now: 0,
      schedule: 0,
    });
  });

  it("createApp called with no schedule builds an app, and the module source contains neither runtime/ nor unref", () => {
    const source = readFileSync(resolve(import.meta.dirname, "app.ts"), "utf8");
    assert.equal(source.includes("runtime/"), false);
    assert.equal(source.includes("unref"), false);
    const result = createApp({
      settings: {
        token: "test-token",
        allowedHosts: ["kanthord.test"],
        allowedOrigins: [],
      },
      handlers: {},
      unimplemented: unimplementedFor({}),
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
      waits: noopWaits(),
    });
    assert.ok(result.hono);
  });

  it("defaultSchedule runs and cancels under mock timers, through a createApp built with no schedule", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const source = readFileSync(resolve(import.meta.dirname, "app.ts"), "utf8");
    assert.equal(source.includes("setTimeout"), true);
    assert.equal(source.includes("clearTimeout"), true);
    const result = createApp({
      settings: {
        token: "test-token",
        allowedHosts: ["kanthord.test"],
        allowedOrigins: [],
      },
      handlers: {},
      unimplemented: unimplementedFor({}),
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
      waits: noopWaits(),
    });
    assert.ok(result.hono);
  });

  it("production sources keep header writes in the accumulator", () => {
    const directory = new URL("./", import.meta.url);
    const listing = readdirSync(directory, { recursive: true }).map(String);
    const sources = listing
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .sort();
    const text = (entry: string) =>
      readFileSync(new URL(entry, directory), "utf8");
    const repoPath = (entry: string) => `src/http/server/${entry}`;

    const bareContextGet = sources
      .filter(
        (entry) => entry !== "variables.ts" && /\bc\.get\(/.test(text(entry)),
      )
      .map(repoPath);
    const contextHeaderWrites = sources
      .filter((entry) => /\bc\.header\(/.test(text(entry)))
      .map(repoPath);
    const contextResponseWrites = sources
      .filter((entry) => /\bc\.res\s*=/.test(text(entry)))
      .map(repoPath);
    assert.deepEqual(bareContextGet, []);
    assert.deepEqual(contextHeaderWrites, []);
    assert.deepEqual(contextResponseWrites, []);
  });
});
