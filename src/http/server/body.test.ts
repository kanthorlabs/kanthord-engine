import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";

import { errorResponse, errorValue, materializeError } from "./envelope.ts";
import { headersMiddleware } from "./headers.ts";
import { renderMiddleware } from "./render.ts";
import { bodyMiddleware, BODY_LIMIT_BYTES } from "./body.ts";
import { demand, optional } from "./variables.ts";
import type { AppEnv } from "./variables.ts";
import type { Handler } from "./app.ts";
import type { RouteMatch } from "../contract/registry.ts";
import type { Operation } from "../contract/operation.ts";

type Observed = Readonly<{ body: unknown; rawBody: unknown }>;

type Fixture = Readonly<{
  app: Hono<AppEnv>;
  observed: Observed[];
  internals: unknown[];
}>;

function buildFixture(
  options: Readonly<{
    handlers: Readonly<Record<string, Handler>>;
    match?: RouteMatch;
  }>,
): Fixture {
  const observed: Observed[] = [];
  const internals: unknown[] = [];
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    const value = errorValue(error);
    const materialized = materializeError(value);
    if (materialized.internal) {
      internals.push(value);
    }
    return errorResponse(materialized, demand(c, "headers"));
  });
  app.use("*", headersMiddleware());
  app.use("*", renderMiddleware());
  app.use("*", async (c, next) => {
    if (options.match !== undefined) {
      c.set("match", options.match);
    }
    await next();
  });
  app.use("*", bodyMiddleware(options.handlers));
  app.all("*", async (c) => {
    observed.push({
      body: optional(c, "body"),
      rawBody: optional(c, "rawBody"),
    });
    c.set("result", { kind: "json", status: 200, body: { reached: true } });
  });
  return { app, observed, internals };
}

async function send(app: Hono<AppEnv>, init: RequestInit): Promise<Response> {
  return app.request(new Request("https://kanthord.invalid/v1/node", init));
}

type CountedBody = Readonly<{
  body: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancels: () => number;
  sizes: () => readonly number[];
}>;

function countingBody(chunks: readonly Uint8Array[]): CountedBody {
  let pulled = 0;
  let cancelled = 0;
  let next = 0;
  const sizes: number[] = [];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1;
        const chunk = chunks[next];
        if (chunk !== undefined) {
          next += 1;
          sizes.push(chunk.byteLength);
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled += 1;
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
  return {
    body,
    pulls: () => pulled,
    cancels: () => cancelled,
    sizes: () => sizes,
  };
}

const encoder = new TextEncoder();

function routedOperation(operationId: string): Operation {
  return {
    operationId,
    method: "POST",
    path: [],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human", "harness"],
  };
}

function stubbedOperation(operationId: string): Operation {
  return { ...routedOperation(operationId), status: "stubbed" };
}

function matchFor(operation: Operation): RouteMatch {
  return { operation, parameters: {} };
}

const okHandler: Handler = () => ({
  kind: "json",
  status: 200,
  body: { handled: true },
});

const boundHandlers: Readonly<Record<string, Handler>> = {
  "node.create": okHandler,
};

const GENERIC_ENVELOPE =
  '{"error":{"code":"internal-error","message":"internal error"}}';

describe("src/http/server/body.test", () => {
  it("a get and a delete leave both variables absent and still reach downstream", async () => {
    for (const method of ["GET", "DELETE"]) {
      const fixture = buildFixture({
        handlers: boundHandlers,
        match: matchFor(routedOperation("node.create")),
      });
      const response = await send(fixture.app, { method });
      assert.equal(response.status, 200, method);
      assert.deepEqual(await response.json(), { reached: true }, method);
      assert.equal(fixture.observed.length, 1, method);
      const [record] = fixture.observed;
      assert.ok(record !== undefined, method);
      assert.equal(record.body, undefined, method);
      assert.equal(record.rawBody, undefined, method);
    }
  });

  it("post, put and patch each parse an admitted json body", async () => {
    for (const method of ["POST", "PUT", "PATCH"]) {
      const fixture = buildFixture({
        handlers: boundHandlers,
        match: matchFor(routedOperation("node.create")),
      });
      const response = await send(fixture.app, {
        method,
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      });
      assert.equal(response.status, 200, method);
      assert.deepEqual(await response.json(), { reached: true }, method);
      assert.equal(fixture.observed.length, 1, method);
      const [record] = fixture.observed;
      assert.ok(record !== undefined, method);
      assert.deepEqual(record.body, { a: 1 }, method);
      assert.equal(record.rawBody, '{"a":1}', method);
    }
  });

  it("a stubbed operation never pulls the body, leaves both variables absent and still reaches downstream", async () => {
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(stubbedOperation("node.stub")),
    });
    const counted = countingBody([encoder.encode('{ "broken"')]);
    const response = await send(fixture.app, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: counted.body,
      duplex: "half",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reached: true });
    assert.equal(fixture.observed.length, 1);
    const [record] = fixture.observed;
    assert.ok(record !== undefined);
    assert.equal(record.body, undefined);
    assert.equal(record.rawBody, undefined);
    assert.equal(counted.pulls(), 0);
  });

  it("a routed operation without a bound handler never pulls the body, leaves both variables absent and still reaches downstream", async () => {
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(routedOperation("node.unbound")),
    });
    const counted = countingBody([encoder.encode('{ "broken"')]);
    const response = await send(fixture.app, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: counted.body,
      duplex: "half",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reached: true });
    assert.equal(fixture.observed.length, 1);
    const [record] = fixture.observed;
    assert.ok(record !== undefined);
    assert.equal(record.body, undefined);
    assert.equal(record.rawBody, undefined);
    assert.equal(counted.pulls(), 0);
  });

  it("every admitted media type parses across mixed case and parameters", async () => {
    const mediaTypes = [
      "application/json",
      "APPLICATION/JSON",
      "application/json-patch+json",
      "Application/Json-Patch+Json",
      "application/vnd.api+json;charset=utf-8",
      'application/csp-report ; charset="a;b"',
      "APPLICATION/REPORTS+JSON",
      "application/scim+json",
    ];
    for (const contentType of mediaTypes) {
      const fixture = buildFixture({
        handlers: boundHandlers,
        match: matchFor(routedOperation("node.create")),
      });
      const response = await send(fixture.app, {
        method: "POST",
        headers: { "content-type": contentType },
        body: '{"a":1}',
      });
      assert.equal(response.status, 200, contentType);
      assert.equal(fixture.observed.length, 1, contentType);
      const [record] = fixture.observed;
      assert.ok(record !== undefined, contentType);
      assert.equal(record.rawBody, '{"a":1}', contentType);
      assert.deepEqual(record.body, { a: 1 }, contentType);
    }
  });

  it("a text/plain body stores an empty object without rawBody", async () => {
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(routedOperation("node.create")),
    });
    const response = await send(fixture.app, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"a":1}',
    });
    assert.equal(response.status, 200);
    assert.equal(fixture.observed.length, 1);
    const [record] = fixture.observed;
    assert.ok(record !== undefined);
    assert.deepEqual(record.body, {});
    assert.equal(record.rawBody, undefined);
  });

  it("an absent content type stores an empty object without rawBody and without pulling the stream", async () => {
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(routedOperation("node.create")),
    });
    const counted = countingBody([encoder.encode('{"a":1}')]);
    const response = await send(fixture.app, {
      method: "POST",
      body: counted.body,
      duplex: "half",
    });
    assert.equal(response.status, 200);
    assert.equal(fixture.observed.length, 1);
    const [record] = fixture.observed;
    assert.ok(record !== undefined);
    assert.deepEqual(record.body, {});
    assert.equal(record.rawBody, undefined);
    assert.equal(counted.pulls(), 0);
  });

  it("the exact whitespace of an admitted body survives into rawBody while parsing to the same value", async () => {
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(routedOperation("node.create")),
    });
    const response = await send(fixture.app, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{ "a" : 1 }',
    });
    assert.equal(response.status, 200);
    const [record] = fixture.observed;
    assert.ok(record !== undefined);
    assert.equal(record.rawBody, '{ "a" : 1 }');
    assert.deepEqual(record.body, { a: 1 });
  });

  it("zero json bytes store an empty rawBody and an empty object", async () => {
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(routedOperation("node.create")),
    });
    const response = await send(fixture.app, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    assert.equal(response.status, 200);
    const [record] = fixture.observed;
    assert.ok(record !== undefined);
    assert.equal(record.rawBody, "");
    assert.deepEqual(record.body, {});
  });

  it("scalar and truncated bodies answer 400 invalid-request with the exact message", async () => {
    const invalidBodies = ["1", '"a"', '{"oops'];
    for (const raw of invalidBodies) {
      const fixture = buildFixture({
        handlers: boundHandlers,
        match: matchFor(routedOperation("node.create")),
      });
      const response = await send(fixture.app, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      assert.equal(response.status, 400, JSON.stringify(raw));
      assert.deepEqual(
        await response.json(),
        {
          error: {
            code: "invalid-request",
            message: "the request body is not valid json",
          },
        },
        JSON.stringify(raw),
      );
      assert.equal(fixture.observed.length, 0, JSON.stringify(raw));
      assert.equal(fixture.internals.length, 0, JSON.stringify(raw));
    }
  });

  it("a declared content-length above the cap answers the generic 500 envelope without pulling the stream", async () => {
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(routedOperation("node.create")),
    });
    const counted = countingBody([encoder.encode("x")]);
    const response = await send(fixture.app, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(BODY_LIMIT_BYTES + 1),
      },
      body: counted.body,
      duplex: "half",
    });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), GENERIC_ENVELOPE);
    assert.equal(counted.pulls(), 0);
    assert.equal(fixture.observed.length, 0);
    assert.equal(fixture.internals.length, 1);
    const [reported] = fixture.internals;
    assert.ok(reported instanceof Error);
    assert.equal(reported.message, "request body exceeds the limit");
  });

  it("a streamed body that crosses the cap refuses at the crossing and never touches the sentinel", async () => {
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(routedOperation("node.create")),
    });
    const counted = countingBody([
      encoder.encode("a".repeat(BODY_LIMIT_BYTES)),
      encoder.encode("b"),
      encoder.encode("SENTINEL"),
    ]);
    const response = await send(fixture.app, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: counted.body,
      duplex: "half",
    });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), GENERIC_ENVELOPE);
    assert.deepEqual(counted.sizes(), [BODY_LIMIT_BYTES, 1]);
    assert.equal(counted.pulls(), 2);
    assert.equal(counted.cancels(), 0);
    assert.equal(fixture.observed.length, 0);
    assert.equal(fixture.internals.length, 1);
    const [reported] = fixture.internals;
    assert.ok(reported instanceof Error);
    assert.equal(reported.message, "request body exceeds the limit");
  });

  it("a body of exactly the limit parses once and reaches downstream", async () => {
    assert.equal(BODY_LIMIT_BYTES, 1_048_576);
    const raw = `{"x":"${"a".repeat(1_048_568)}"}`;
    assert.equal(encoder.encode(raw).byteLength, 1_048_576);
    const fixture = buildFixture({
      handlers: boundHandlers,
      match: matchFor(routedOperation("node.create")),
    });
    const response = await send(fixture.app, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assert.equal(response.status, 200);
    assert.equal(fixture.observed.length, 1);
    const [record] = fixture.observed;
    assert.ok(record !== undefined);
    assert.equal(record.rawBody, raw);
    assert.deepEqual(record.body, { x: "a".repeat(1_048_568) });
  });
});
