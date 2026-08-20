import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "./app.ts";
import type { Handler } from "./app.ts";
import { listen } from "./start.ts";
import { HttpError } from "../contract/errors.ts";
import { systemDbResponse, systemHealthResponse } from "../contract/system.ts";
import {
  unimplementedFor,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { reservePort } from "../../../test/helpers/port.ts";
import { healthHandler } from "./system/health.ts";
import { dbHandler } from "./system/db.ts";
import { readHealth } from "../../queries/system/read-health.ts";
import type { DependencyStatus } from "../../queries/system/read-health.ts";
import { readMigrationStatus } from "../../queries/system/read-migration-status.ts";
import { call } from "../../cli/client.ts";
import type { ClientDependencies } from "../../cli/client.ts";
import { exitCodeForError } from "../../cli/exit-code.ts";

function buildApp() {
  return createApp({
    settings: {
      token: "test-token",
      allowedHosts: ["kanthord.test"],
      allowedOrigins: [],
    },
    handlers: {},
    unimplemented: unimplementedFor({}),
    resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
    onInternalError: () => {},
  });
}

describe("src/http/server/start.test", () => {
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
    const app = createApp({
      settings: {
        token: "test-token",
        allowedHosts: [`127.0.0.1:${port}`],
        allowedOrigins: [],
      },
      handlers,
      unimplemented: unimplementedFor(handlers),
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
      onInternalError: () => {},
    });
    const server = await listen(app, { bind: "127.0.0.1", port });
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
});
