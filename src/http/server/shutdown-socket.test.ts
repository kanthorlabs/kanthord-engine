import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import { Hono } from "hono";

import type { AppEnv } from "./variables.ts";
import { loopbackAgent, loopbackServer } from "../../../test/helpers/agent.ts";

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the loopback server exposes no numeric port");
  }
  if (!(address.port > 0)) {
    throw new Error("the loopback server holds no assigned port");
  }
  return address.port;
}

describe("src/http/server/shutdown-socket.test", () => {
  it("graceful shutdown drains an in-flight request to its full body", async () => {
    const order: string[] = [];
    const entered = deferred<void>();
    const release = deferred<void>();
    const application = new Hono<AppEnv>();
    application.get("/drain", async (c) => {
      order.push("handler-entered");
      entered.resolve();
      await release.promise;
      return c.text("complete-body");
    });
    const server = await loopbackServer(application);
    const agent = await loopbackAgent(application);

    const answer = agent.get("/drain").then((response) => {
      order.push("response-complete");
      return { status: response.status, text: response.text };
    });

    await entered.promise;
    order.push("shutdown-started");
    const closing = closeServer(server);
    order.push("handler-released");
    release.resolve();

    const carried = await answer;
    await closing;

    assert.equal(carried.status, 200);
    assert.equal(carried.text, "complete-body");
    assert.deepEqual(order, [
      "handler-entered",
      "shutdown-started",
      "handler-released",
      "response-complete",
    ]);
    assert.equal(server.listening, false);
  });

  it("a connection opened after shutdown starts is refused", async () => {
    const application = new Hono<AppEnv>();
    application.get("/", (c) => c.text("ok"));
    const server = await loopbackServer(application);
    const port = portOf(server);

    const closing = closeServer(server);
    const refusal = await fetch(`http://127.0.0.1:${port}/`).then(
      () => null,
      (error: unknown) => error,
    );

    assert.equal(
      (refusal as { cause?: { code?: string } } | null)?.cause?.code,
      "ECONNREFUSED",
    );
    await closing;
  });

  it("the listener closes", async () => {
    const application = new Hono<AppEnv>();
    application.get("/", (c) => c.text("ok"));
    const server = await loopbackServer(application);

    assert.equal(server.listening, true);

    await closeServer(server);

    assert.equal(server.listening, false);
    assert.equal(server.address(), null);
  });
});
