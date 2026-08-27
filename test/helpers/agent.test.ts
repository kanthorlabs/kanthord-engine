import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";

import type { AppEnv } from "../../src/http/server/variables.ts";
import { fetchAgent, loopbackAgent, loopbackServer } from "./agent.ts";

describe("test/helpers/agent.test", () => {
  it("binds the loopback address and never the wildcard", async () => {
    const address = (await loopbackServer(new Hono())).address();

    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    assert.equal((address as { address: string }).address, "127.0.0.1");
  });

  it("reuses one server per app", async () => {
    const app = new Hono();

    assert.equal(await loopbackServer(app), await loopbackServer(app));
  });

  it("gives each app its own server", async () => {
    assert.notEqual(
      await loopbackServer(new Hono()),
      await loopbackServer(new Hono()),
    );
  });

  it("drives the app over that server", async () => {
    const app = new Hono();
    app.all("*", (c) => c.json({ reached: true }));

    const response = await (await loopbackAgent(app)).get("/");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
  });

  it("reports an assigned ephemeral port", async () => {
    const address = (await loopbackServer(new Hono())).address();

    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const { port } = address as AddressInfo;
    assert.equal(typeof port, "number");
    assert.equal(port > 0, true);
  });

  it("reports a response header name in lower case", async () => {
    const app = new Hono();
    app.get(
      "/lower",
      () => new Response("ok", { headers: { "X-Namespace": "kanthor" } }),
    );

    const response = await fetchAgent(app).get("/lower");

    assert.equal(response.headers["x-namespace"], "kanthor");
  });

  it("joins two values of one header name with ', ', set-cookie included", async () => {
    const app = new Hono();
    app.get("/cookies", () => {
      const res = new Response(null);
      res.headers.append("X-A", "one");
      res.headers.append("X-A", "two");
      res.headers.append("set-cookie", "a=1");
      res.headers.append("set-cookie", "b=2");
      return res;
    });

    const response = await fetchAgent(app).get("/cookies");

    assert.equal(response.headers["x-a"], "one, two");
    assert.equal(response.headers["set-cookie"], "a=1, b=2");
  });

  it("parses a JSON content type into body", async () => {
    const app = new Hono();
    app.get("/json", (c) => c.json({ reached: true }));
    app.get(
      "/mixed-case",
      () =>
        new Response('{"reached":true}', {
          headers: { "content-type": "Application/JSON" },
        }),
    );

    const canonical = await fetchAgent(app).get("/json");
    const mixedCase = await fetchAgent(app).get("/mixed-case");

    assert.deepEqual(canonical.body, { reached: true });
    assert.deepEqual(mixedCase.body, { reached: true });
  });

  it("buffers a non-JSON content type into body", async () => {
    const app = new Hono();
    app.get(
      "/bytes",
      () =>
        new Response(Uint8Array.of(0, 255), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const response = await fetchAgent(app).get("/bytes");

    assert.equal(Buffer.isBuffer(response.body), true);
    assert.deepEqual(response.body, Buffer.from([0, 255]));
  });

  it("keeps an empty body as {}", async () => {
    const app = new Hono();
    app.get(
      "/empty",
      () =>
        new Response(null, {
          status: 204,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await fetchAgent(app).get("/empty");

    assert.deepEqual(response.body, {});
  });

  it("decodes text as UTF-8", async () => {
    const app = new Hono();
    app.get(
      "/utf8",
      () =>
        new Response("héllo", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );

    const response = await fetchAgent(app).get("/utf8");

    assert.equal(response.text, "héllo");
  });

  it("sets content-type application/json when .send passes an object", async () => {
    const seen: { contentType?: string; text: string } = { text: "" };
    const app = new Hono();
    app.post("/echo", async (c) => {
      seen.contentType = c.req.header("content-type");
      seen.text = await c.req.text();
      return c.body(null, 200);
    });

    const response = await fetchAgent(app).post("/echo").send({ a: 1 });

    assert.equal(response.status, 200);
    assert.equal(seen.contentType, "application/json");
    assert.equal(seen.text, '{"a":1}');
  });

  it("keeps a content-type the caller set before .send", async () => {
    const seen: { contentType?: string; text: string } = { text: "" };
    const app = new Hono();
    app.post("/echo", async (c) => {
      seen.contentType = c.req.header("content-type");
      seen.text = await c.req.text();
      return c.body(null, 200);
    });

    await fetchAgent(app)
      .post("/echo")
      .set("content-type", "text/plain")
      .send({ a: 1 });

    assert.equal(seen.contentType, "text/plain");
    assert.equal(seen.text, '{"a":1}');
  });

  it("sends a string payload verbatim and sets no content type", async () => {
    const seen: { contentType?: string; text: string } = { text: "" };
    const app = new Hono();
    app.post("/echo", async (c) => {
      seen.contentType = c.req.header("content-type");
      seen.text = await c.req.text();
      return c.body(null, 200);
    });

    await fetchAgent(app).post("/echo").send('{ "a" : 1 }');

    assert.equal(seen.text, '{ "a" : 1 }');
    assert.equal(seen.contentType, undefined);
  });

  it("delays dispatch until the first await, so .set after the call reaches the app", async () => {
    let calls = 0;
    let lazyHeader: string | undefined;
    let secondHeader: string | undefined;
    const app = new Hono();
    app.post("/lazy", (c) => {
      calls += 1;
      lazyHeader = c.req.header("x-lazy");
      secondHeader = c.req.header("x-second");
      return c.body(null, 200);
    });

    const pending = fetchAgent(app)
      .post("/lazy")
      .set("x-lazy", "yes")
      .set("x-second", "too");

    assert.equal(calls, 0);

    const response = await pending;

    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.equal(lazyHeader, "yes");
    assert.equal(secondHeader, "too");
  });

  it("serves both awaits of one request from one application call", async () => {
    let calls = 0;
    const app = new Hono();
    app.get("/once", (c) => {
      calls += 1;
      return c.json({ n: calls });
    });

    const once = fetchAgent(app).get("/once");
    const first = await once;
    const second = await once;

    assert.equal(calls, 1);
    assert.equal(first, second);
  });

  it("reaches the application with the OPTIONS method through options()", async () => {
    let method = "";
    const app = new Hono();
    app.on("OPTIONS", "/opts", (c) => {
      method = c.req.method;
      return c.body(null, 204);
    });

    const response = await fetchAgent(app).options("/opts");

    assert.equal(response.status, 204);
    assert.equal(method, "OPTIONS");
  });

  it("routes delete() and del() both through the DELETE method", async () => {
    let calls = 0;
    const app = new Hono();
    app.delete("/gone", (c) => {
      calls += 1;
      return c.body(null, 204);
    });

    const removed = await fetchAgent(app).delete("/gone");
    const deleted = await fetchAgent(app).del("/gone");

    assert.equal(removed.status, 204);
    assert.equal(deleted.status, 204);
    assert.equal(calls, 2);
  });

  it("leaves process.getActiveResourcesInfo() with no new TCPServerWrap", async () => {
    const countWraps = (): number =>
      process
        .getActiveResourcesInfo()
        .filter((name) => name === "TCPServerWrap").length;
    const app = new Hono();
    app.get("/", (c) => c.text("ok"));
    const agent = fetchAgent(app);

    const before = countWraps();
    await agent.get("/");
    const after = countWraps();

    assert.equal(before, 0);
    assert.equal(after, before);
  });

  it("preserves two set-cookie values over the socket", async () => {
    const app = new Hono<AppEnv>();
    app.get("/cookies", () => {
      const response = new Response(null);
      response.headers.append("Set-Cookie", "a=1");
      response.headers.append("Set-Cookie", "b=2");
      return response;
    });
    const response = await (await loopbackAgent(app)).get("/cookies");

    assert.deepEqual(response.headers["set-cookie"], ["a=1", "b=2"]);
  });
});
