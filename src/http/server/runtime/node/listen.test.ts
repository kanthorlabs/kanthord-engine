import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { Hono } from "hono";

import { createApp } from "../../app.ts";
import type { Handler } from "../../app.ts";
import { noopWaits } from "../../../../../test/helpers/wait-registry.ts";
import { listen } from "./listen.ts";
import { HttpError } from "../../../contract/errors.ts";
import {
  systemDbResponse,
  systemHealthResponse,
} from "../../../contract/system.ts";
import {
  unimplementedFor,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../../test/helpers/database.ts";
import { reservePort } from "../../../../../test/helpers/port.ts";
import { healthHandler } from "../../system/health.ts";
import { dbHandler } from "../../system/db.ts";
import { readHealth } from "../../../../queries/system/read-health.ts";
import type { DependencyStatus } from "../../../../queries/system/read-health.ts";
import { readMigrationStatus } from "../../../../queries/system/read-migration-status.ts";
import { call } from "../../../../cli/client.ts";
import type { ClientDependencies } from "../../../../cli/client.ts";
import { exitCodeForError } from "../../../../cli/exit-code.ts";

const nativeRequest = globalThis.Request;
const nativeResponse = globalThis.Response;

function rawSocketRequest(
  port: number,
  requestLine: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(requestLine);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const raw = Buffer.concat(chunks);
      const separator = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, separator).toString("utf8");
      const body = raw.subarray(separator + 4).toString("latin1");
      const lines = head.split("\r\n");
      const status = Number(lines[0]?.split(" ")[1]);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colonAt = line.indexOf(":");
        if (colonAt >= 0) {
          headers[line.slice(0, colonAt).trim().toLowerCase()] = line
            .slice(colonAt + 1)
            .trim();
        }
      }
      resolve({ status, headers, body });
    });
  });
}

function buildApp() {
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
  const { hono } = created;
  return hono;
}

describe("src/http/server/runtime/node/listen.test", () => {
  it("listen on port 0 resolves a real port and the middleware runs over a real socket", async () => {
    const app = buildApp();
    const server = await listen(app, { bind: "127.0.0.1", port: 0 });
    after(async () => {
      await server.close();
    });

    assert.ok(server.port > 0);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/health`);
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "host-forbidden");
  });

  it("two listen calls on one explicit port: the first resolves, the second rejects with EADDRINUSE", async () => {
    const port = await reservePort();
    const app = buildApp();
    const first = await listen(app, { bind: "127.0.0.1", port });
    after(async () => {
      await first.close();
    });

    await assert.rejects(
      listen(app, { bind: "127.0.0.1", port }),
      (error: unknown) => {
        assert.equal(error instanceof HttpError, false);
        return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      },
    );
  });

  it("close resolves, and a second close also resolves without throwing", async () => {
    const app = buildApp();
    const server = await listen(app, { bind: "127.0.0.1", port: 0 });
    await server.close();
    await server.close();
  });

  it("the registry, renderer, middleware, queries, handlers and client run against one socket", async () => {
    const port = await reservePort();
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const reporters = [
      {
        name: "storage",
        probe: (): DependencyStatus => {
          storage.ping();
          return "ok";
        },
      },
    ];
    const handlers: Readonly<Record<string, Handler>> = {
      "system.health": healthHandler({
        readHealth: () =>
          readHealth({
            reporters,
            version: "27.8.1",
            capabilities: [],
          }),
      }),
      "system.db": dbHandler({
        readMigrationStatus: () => readMigrationStatus({ storage }),
      }),
    };
    const created = createApp({
      settings: {
        token: "test-token",
        allowedHosts: [`127.0.0.1:${port}`],
        allowedOrigins: [],
      },
      handlers,
      unimplemented: unimplementedFor(handlers),
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
      waits: noopWaits(),
    });
    const { hono } = created;
    const server = await listen(hono, { bind: "127.0.0.1", port });
    after(async () => {
      await server.close();
      temporary.dispose();
    });
    const client = (token: string | undefined): ClientDependencies => ({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      fetch: globalThis.fetch,
    });

    const health = await call(client("test-token"), {
      operationId: "system.health",
    });
    assert.equal(health.ok, true);
    if (health.ok) {
      assert.equal(systemHealthResponse.safeParse(health.body).success, true);
      assert.equal((health.body as { status: string }).status, "ok");
      assert.deepEqual(
        (health.body as { dependencies: unknown }).dependencies,
        [{ name: "storage", status: "ok" }],
      );
    }

    const healthNoToken = await call(client(undefined), {
      operationId: "system.health",
    });
    assert.equal(healthNoToken.ok, false);
    if (!healthNoToken.ok) {
      assert.equal(healthNoToken.code, "unauthenticated");
    }

    const db = await call(client("test-token"), {
      operationId: "system.db",
    });
    assert.equal(db.ok, true);
    if (db.ok) {
      assert.equal(systemDbResponse.safeParse(db.body).success, true);
      const migrations = (
        db.body as {
          migrations: readonly { applied: boolean }[];
        }
      ).migrations;
      assert.ok(migrations.length > 0);
      assert.equal(
        migrations.every((entry) => entry.applied),
        true,
      );
    }

    const dbNoToken = await call(client(undefined), {
      operationId: "system.db",
    });
    assert.equal(dbNoToken.ok, false);
    if (!dbNoToken.ok) {
      assert.equal(dbNoToken.code, "unauthenticated");
    }

    const status = await call(client("test-token"), {
      operationId: "system.status",
    });
    assert.equal(status.ok, false);
    if (!status.ok) {
      assert.equal(status.code, "not-implemented");
      assert.equal(exitCodeForError(status.code, status.status), 220);
    }

    storage.close();
    const degraded = await call(client("test-token"), {
      operationId: "system.health",
    });
    assert.equal(degraded.ok, true);
    if (degraded.ok) {
      const body = degraded.body as {
        status: string;
        dependencies: readonly { name: string; status: string }[];
      };
      assert.equal(body.status, "degraded");
      assert.deepEqual(body.dependencies, [
        { name: "storage", status: "failed" },
      ]);
    }
  });

  it("a %2F path and a %zz path each reach the route intact", async () => {
    const seen: string[] = [];
    const app = new Hono();
    app.all("*", (c) => {
      seen.push(c.req.path);
      return c.text("reached");
    });
    const server = await listen(app, { bind: "127.0.0.1", port: 0 });
    after(async () => {
      await server.close();
    });

    await rawSocketRequest(
      server.port,
      "GET /v1/a%2Fb HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    await rawSocketRequest(
      server.port,
      "GET /v1/a%zzb HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );

    assert.deepEqual(seen, ["/v1/a%2Fb", "/v1/a%zzb"]);
  });

  it("a Uint8Array answer carries the exact content-length and the exact bytes", async () => {
    const bytes = Uint8Array.from([
      0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x20, 0x2a, 0x0a, 0x0d,
    ]);
    const app = new Hono();
    app.all("*", () => new Response(bytes));
    const server = await listen(app, { bind: "127.0.0.1", port: 0 });
    after(async () => {
      await server.close();
    });

    const reply = await rawSocketRequest(
      server.port,
      "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );

    assert.equal(reply.status, 200);
    assert.equal(reply.headers["content-length"], "10");
    assert.deepEqual(Buffer.from(reply.body, "latin1"), Buffer.from(bytes));
  });

  it("a 204 answer carries neither content-length nor content-type", async () => {
    const app = new Hono();
    app.all("*", () => new Response(null, { status: 204 }));
    const server = await listen(app, { bind: "127.0.0.1", port: 0 });
    after(async () => {
      await server.close();
    });

    const reply = await rawSocketRequest(
      server.port,
      "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );

    assert.equal(reply.status, 204);
    assert.equal(reply.headers["content-length"], undefined);
    assert.equal(reply.headers["content-type"], undefined);
  });

  it("a POST body reaches the route with its whitespace intact", async () => {
    const body = '{ "a" :  1 }\n';
    let received: string | undefined;
    const app = new Hono();
    app.all("*", async (c) => {
      received = await c.req.text();
      return c.text(received);
    });
    const server = await listen(app, { bind: "127.0.0.1", port: 0 });
    after(async () => {
      await server.close();
    });

    const reply = await rawSocketRequest(
      server.port,
      `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );

    assert.equal(reply.status, 200);
    assert.equal(received, body);
    assert.equal(reply.body, body);
  });

  it("listen leaves the global Request and Response untouched", async () => {
    const server = await listen(new Hono(), {
      bind: "127.0.0.1",
      port: 0,
    });
    after(async () => {
      await server.close();
    });

    assert.equal(globalThis.Request, nativeRequest);
    assert.equal(globalThis.Response, nativeResponse);
  });

  it("a request with no Host header answers 403 host-forbidden", async () => {
    const server = await listen(buildApp(), {
      bind: "127.0.0.1",
      port: 0,
    });
    after(async () => {
      await server.close();
    });

    const reply = await rawSocketRequest(
      server.port,
      "GET /v1/health HTTP/1.0\r\n\r\n",
    );
    const error = JSON.parse(reply.body) as {
      error: { code: string; message: string };
    };

    assert.equal(reply.status, 403);
    assert.equal(error.error.code, "host-forbidden");
    assert.equal(error.error.message, "the request carried no Host header");
  });

  it("an in-flight request drains before close resolves", async () => {
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    }

    const entered = deferred<void>();
    const release = deferred<void>();
    const order: string[] = [];
    const app = new Hono();
    app.all("*", async (c) => {
      order.push("handler-entered");
      entered.resolve();
      await release.promise;
      order.push("handler-released");
      return c.text("complete-body");
    });
    const server = await listen(app, { bind: "127.0.0.1", port: 0 });
    after(async () => {
      release.resolve();
      await server.close();
    });

    const responsePromise = fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { connection: "close" },
    });
    await entered.promise;
    order.push("shutdown-started");
    const closePromise = server.close().then(() => {
      order.push("close-resolved");
    });
    release.resolve();

    const response = await responsePromise;
    const responseBody = await response.text();
    await closePromise;

    assert.equal(response.status, 200);
    assert.equal(responseBody, "complete-body");
    assert.ok(
      order.indexOf("close-resolved") > order.indexOf("handler-released"),
    );
  });
});
