import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLoopbackUrl } from "./base-url.ts";

describe("src/cli/base-url.test", () => {
  it("accepts loopback urls", () => {
    const loopback = [
      "http://127.0.0.1:7421",
      "http://127.0.0.5:1",
      "https://127.0.0.1",
      "http://localhost:7421",
      "http://[::1]:7421",
    ];
    for (const url of loopback) {
      assert.equal(isLoopbackUrl(url), true, url);
    }
  });

  it("refuses non-loopback urls and unparseable strings", () => {
    const nonLoopback = [
      "https://daemon.example.com",
      "http://10.0.0.1:7421",
      "http://127.0.0.1.example.com",
      "ssh://localhost",
      "file:///tmp",
      "not a url",
      "",
      "http://127.999.0.1:7421",
    ];
    for (const url of nonLoopback) {
      assert.equal(isLoopbackUrl(url), false, url);
    }
  });
});
