import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Koa from "koa";

import { loopbackAgent, loopbackServer } from "./agent.ts";

describe("test/helpers/agent.test", () => {
  it("binds the loopback address and never the wildcard", async () => {
    const address = (await loopbackServer(new Koa())).address();

    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    assert.equal((address as { address: string }).address, "127.0.0.1");
  });

  it("reuses one server per app", async () => {
    const app = new Koa();

    assert.equal(await loopbackServer(app), await loopbackServer(app));
  });

  it("gives each app its own server", async () => {
    assert.notEqual(
      await loopbackServer(new Koa()),
      await loopbackServer(new Koa()),
    );
  });

  it("drives the app over that server", async () => {
    const app = new Koa();
    app.use((context) => {
      context.status = 200;
      context.body = { reached: true };
    });

    const response = await (await loopbackAgent(app)).get("/");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
  });
});
