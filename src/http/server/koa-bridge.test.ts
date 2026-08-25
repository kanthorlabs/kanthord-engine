import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";

import { BRIDGE_HOSTNAME, koaFromHono } from "./koa-bridge.ts";
import type { AppEnv } from "./variables.ts";

type RawReply = Readonly<{
  status: number;
  rawHeaders: readonly string[];
  body: Buffer;
}>;

async function listen(hono: Hono<AppEnv>): Promise<Server> {
  const server = createServer(koaFromHono(hono).callback());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  return server;
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function header(
  rawHeaders: readonly string[],
  name: string,
): string | undefined {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      return rawHeaders[index + 1];
    }
  }
  return undefined;
}

function send(
  server: Server,
  method: string,
  path: string,
  requestBody?: string,
): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port: port(server), method, path },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            rawHeaders: incoming.rawHeaders,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(requestBody);
  });
}

function rawHttp10(target: number): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: target }, () => {
      socket.write("GET / HTTP/1.0\r\n\r\n");
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const raw = Buffer.concat(chunks);
      const separator = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, separator).toString("utf8");
      const body = raw.subarray(separator + 4);
      const lines = head.split("\r\n");
      const status = Number(lines[0]?.split(" ")[1]);
      const rawHeaders: string[] = [];
      for (const line of lines.slice(1)) {
        const colonAt = line.indexOf(":");
        if (colonAt >= 0) {
          rawHeaders.push(
            line.slice(0, colonAt).trim().toLowerCase(),
            line.slice(colonAt + 1).trim(),
          );
        }
      }
      resolve({ status, rawHeaders, body });
    });
  });
}

describe("src/http/server/koa-bridge.test", () => {
  it("a %2F path and a %zz path each reach the route intact", async (t) => {
    const seen: string[] = [];
    const hono = new Hono<AppEnv>();
    hono.all("*", (c) => {
      seen.push(new URL(c.req.url).pathname);
      return c.json({ reached: true });
    });
    const server = await listen(hono);
    t.after(() => {
      server.close();
    });

    await send(server, "GET", "/v1/a%2Fb");
    await send(server, "GET", "/v1/x%zz");

    assert.deepEqual(seen, ["/v1/a%2Fb", "/v1/x%zz"]);
  });

  it("a Uint8Array answer carries the exact content-length and the exact bytes", async (t) => {
    const hono = new Hono<AppEnv>();
    hono.all("*", () => new Response(Uint8Array.from([0x00, 0x80, 0xff])));
    const server = await listen(hono);
    t.after(() => {
      server.close();
    });

    const reply = await send(server, "GET", "/");

    assert.equal(reply.status, 200);
    assert.equal(header(reply.rawHeaders, "content-length"), "3");
    assert.deepEqual(reply.body, Buffer.from([0x00, 0x80, 0xff]));
  });

  it("a 204 answer carries no body bytes, no content-length and no content-type", async (t) => {
    const hono = new Hono<AppEnv>();
    hono.all("*", () => new Response(null, { status: 204 }));
    const server = await listen(hono);
    t.after(() => {
      server.close();
    });

    const reply = await send(server, "GET", "/");

    assert.equal(reply.status, 204);
    assert.equal(reply.body.length, 0);
    assert.equal(header(reply.rawHeaders, "content-length"), undefined);
    assert.equal(header(reply.rawHeaders, "content-type"), undefined);
  });

  it("a POST body reaches the route with its whitespace and newline intact", async (t) => {
    let received: string | undefined;
    const hono = new Hono<AppEnv>();
    hono.all("*", async (c) => {
      received = await c.req.text();
      return c.text(received);
    });
    const server = await listen(hono);
    t.after(() => {
      server.close();
    });

    const reply = await send(server, "POST", "/", '{ "a" : 1 }\n');

    assert.equal(reply.status, 200);
    assert.equal(received, '{ "a" : 1 }\n');
    assert.deepEqual(reply.body, Buffer.from('{ "a" : 1 }\n', "utf8"));
  });

  it("koaFromHono leaves global.Request and global.Response strictly identical", () => {
    const savedRequest = global.Request;
    const savedResponse = global.Response;

    koaFromHono(new Hono<AppEnv>());

    assert.strictEqual(global.Request, savedRequest);
    assert.strictEqual(global.Response, savedResponse);
  });

  it("an HTTP/1.0 request with no Host header answers through the fallback authority", async (t) => {
    let urlHost: string | undefined;
    let headerHost: string | undefined;
    const hono = new Hono<AppEnv>();
    hono.all("*", (c) => {
      urlHost = new URL(c.req.url).host;
      headerHost = c.req.header("host");
      return new Response(null, { status: 204 });
    });
    const server = await listen(hono);
    t.after(() => {
      server.close();
    });

    const reply = await rawHttp10(port(server));

    assert.equal(urlHost, BRIDGE_HOSTNAME);
    assert.strictEqual(headerHost, undefined);
    assert.equal(reply.status, 204);
    assert.equal(reply.body.length, 0);
  });
});
