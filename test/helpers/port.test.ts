import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { reservePort } from "./port.ts";

describe("test/helpers/port.test", () => {
  it("yields two different ports, both above 1023", async () => {
    const first = await reservePort();
    const second = await reservePort();

    assert.ok(first > 1023);
    assert.ok(second > 1023);
    assert.notEqual(first, second);
  });

  it("the returned port binds", async () => {
    const port = await reservePort();

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve());
      });
    });
  });
});
